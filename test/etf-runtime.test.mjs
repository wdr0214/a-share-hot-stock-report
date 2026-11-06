import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { generateEtfRotation } from "../src/etf-rotation.js";
import { handleReportJob, writeEtfFilesToGitHub } from "../api/_github-report-job.mjs";

const date = "2026-11-05";
const symbols = ["159915.SZ", "510300.SS", "518880.SS", "159941.SZ", "513050.SS", "511260.SS"];
const prices = [2.584, 4.188, 8.416, 1.642, 1.042, 135.878];
const timestamp = Date.parse(`${date}T14:50:00+08:00`) / 1000;
const daily = { chart: { result: [{ timestamp: Array.from({length:40}, (_,i) => timestamp - (40-i)*86400), indicators: { quote: [{close: Array(40).fill(2)}] } }] } };
function response(payload) { return new Response(JSON.stringify(payload), {headers:{"Content-Type":"application/json"}}); }
function minute(url, missing = false) {
  const symbol = new URL(url).pathname.split("/").at(-1);
  return response({chart:{result:[{meta:{symbol},timestamp:[missing ? timestamp-60 : timestamp],indicators:{quote:[{open:[prices[symbols.indexOf(symbol)]],close:[999]}]}}]}});
}
function fastRetries(t) {
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis,"setTimeout",(fn) => timer(fn,0));
}
function env(t, key, value) {
  const old=process.env[key]; process.env[key]=value;
  t.after(()=>{if(old===undefined)delete process.env[key];else process.env[key]=old;});
}

test("after the execution minute uses exact 14:50 open, preserves NAV history and fee rules", async (t) => {
  const urls=[];
  t.mock.method(globalThis,"fetch",async (url) => {
    urls.push(String(url));
    return String(url).includes("interval=1m") ? minute(url) : response(daily);
  });
  const previous={cash:0,netValue:0.9,holding:{symbol:"SH511260",name:"bond",shares:0.01,entryPrice:130},history:[{date:"2026-11-04",netValue:0.9}]};
  const result=await generateEtfRotation({date,now:new Date(`${date}T17:00:00+08:00`),portfolio:previous});
  assert.deepEqual(result.report.etfs.map(e=>e.price),prices);
  assert.equal(result.report.executionPriceBasis,"minute_1450_open_backfill");
  assert.equal(result.report.executionTime,"14:50分钟行情补报");
  assert.equal(result.report.portfolioHistory.length,2);
  assert.equal(result.report.netValue,0.01*135.878);
  assert.equal(result.portfolio.holding.symbol,"SH511260");
  assert.equal(result.report.rebalance.length,0);
  assert.ok(urls.every(url=>url.includes("yahoo.com")));
});

test("missing 14:50 bar refuses latest/close substitution", async (t) => {
  fastRetries(t);
  t.mock.method(globalThis,"fetch",async url=>String(url).includes("interval=1m") ? minute(url,true) : response(daily));
  await assert.rejects(generateEtfRotation({date,now:new Date(`${date}T16:00:00+08:00`)}),/14:50/);
});

test("Sina multiline fallback parses six timestamped quotes", async(t)=>{
  fastRetries(t);
  t.mock.method(globalThis,"fetch",async url=>{
    if(String(url).includes("eastmoney.com")) return new Response("unavailable",{status:502});
    if(String(url).includes("sinajs.cn")) return new Response(symbols.map((s,i)=>{
      const fields=Array(33).fill("0"); fields[3]=String(prices[i]); fields[30]=date; fields[31]="14:50:08";
      return `var hq_str_${s.endsWith("SZ")?"sz":"sh"}${s.slice(0,6)}="${fields.join(",")}";`;
    }).join("\r\n"));
    return response(daily);
  });
  const {report}=await generateEtfRotation({date,now:new Date(`${date}T14:50:05+08:00`)});
  assert.deepEqual(report.etfs.map(e=>e.price),prices);
  assert.ok(report.etfs.every(e=>e.quoteSource==="Sina"));
  assert.equal(report.executionPriceBasis,"intraday_quote");
  assert.equal(report.netValue,0.9999);
});

test("before 14:50, weekends and unknown modes never fetch data",async(t)=>{
  let calls=0;t.mock.method(globalThis,"fetch",async()=>{calls++;throw Error("unexpected");});
  await assert.rejects(generateEtfRotation({date,now:new Date(`${date}T14:49:59+08:00`)}),/14:50/);
  await assert.rejects(generateEtfRotation({date:"2026-11-07",now:new Date("2026-11-07T15:00:00+08:00")}),/非 A 股交易日/);
  await assert.rejects(generateEtfRotation({date,now:new Date(),executionPriceMode:"fake"}),/Unsupported/);
  assert.equal(calls,0);
});

test("explicit close-price backfill remains supported",async(t)=>{
  t.mock.method(globalThis,"fetch",async url=>String(url).includes("eastmoney.com")
    ? response({data:{klines:[`${date},2,3,3,2,100`]}}) : response(daily));
  const {report}=await generateEtfRotation({date,now:new Date(`${date}T16:00:00+08:00`),executionPriceMode:"close-backfill"});
  assert.equal(report.executionPriceBasis,"daily_close_backfill");
  assert.ok(report.etfs.every(e=>e.price===3));
});

function res(){return {statusCode:null,payload:null,status(code){this.statusCode=code;return this;},json(payload){this.payload=payload;return this;}};}
test("ETF acknowledgment does not wait for storage, and failed seed cannot erase history",async(t)=>{
  fastRetries(t);
  env(t,"REPORT_JOB_SECRET","test-secret");env(t,"GITHUB_REPORT_TOKEN","test-token");
  let release; const gate=new Promise(resolve=>release=resolve); const writes=[];
  t.mock.method(globalThis,"fetch",async(url,options={})=>{
    if(String(url).includes("git/ref/")){await gate;return response({object:{sha:"abc"}});}
    if(String(url).includes("raw.githubusercontent.com")) return new Response("unavailable",{status:503});
    if(options.method==="PUT"){writes.push(JSON.parse(options.body));return response({commit:{sha:"failure-log"}});}
    return new Response("not found",{status:404});
  });
  let pending; const output=res();
  await handleReportJob({headers:{authorization:"Bearer test-secret"},query:{date}},output,"etf-rotation",{defer:p=>pending=p});
  assert.equal(output.statusCode,202);assert.equal(output.payload.completed,false);assert.ok(pending);
  release();await pending;
  assert.equal(writes.length,1);
  const state=JSON.parse(Buffer.from(writes[0].content,"base64").toString());
  assert.equal(state.status,"failed");assert.equal(state.date,date);assert.equal(state.attempts,3);
});

test("unauthorized and nontrading requests cannot schedule ETF work",async(t)=>{
  env(t,"REPORT_JOB_SECRET","test-secret");let queued=false;
  const unauthorized=res();await handleReportJob({headers:{},query:{date}},unauthorized,"etf-rotation",{defer:()=>queued=true});
  assert.equal(unauthorized.payload.ok,false);assert.equal(queued,false);
  const weekend=res();await handleReportJob({headers:{authorization:"Bearer test-secret"},query:{date:"2026-11-07"}},weekend,"etf-rotation",{defer:()=>queued=true});
  assert.equal(weekend.payload.reason,"weekend");assert.equal(queued,false);
});

test("ETF database, report and pointers publish in one non-forced commit",async(t)=>{
  env(t,"GITHUB_REPORT_TOKEN","test-token");const requests=[];
  t.mock.method(globalThis,"fetch",async(url,options={})=>{
    requests.push({url:String(url),method:options.method||"GET",body:options.body&&JSON.parse(options.body)});
    if(String(url).includes("git/ref/"))return response({object:{sha:"seed"}});
    if(String(url).endsWith("git/commits/seed"))return response({tree:{sha:"old-tree"}});
    if(String(url).endsWith("git/trees"))return response({sha:"new-tree"});
    if(String(url).endsWith("git/commits"))return response({sha:"new-commit"});
    if(options.method==="PATCH")return response({object:{sha:"new-commit"}});
    throw Error("unexpected request");
  });
  const files=[{path:"data/reports.json",content:"db"},{path:"outputs/data/reports/etf-rotation-latest.json",content:"report"}];
  const result=await writeEtfFilesToGitHub(files,"ETF update",{sha:"seed",payload:"old-db"});
  assert.equal(result.length,2);
  assert.equal(requests.filter(r=>r.method==="PATCH").length,1);
  assert.deepEqual(requests.at(-1).body,{sha:"new-commit",force:false});
  assert.deepEqual(requests.find(r=>r.url.endsWith("git/trees")).body.tree.map(r=>r.path),files.map(r=>r.path));
});

test("concurrently changed portfolio database is never overwritten",async(t)=>{
  env(t,"GITHUB_REPORT_TOKEN","test-token");let writes=0;
  t.mock.method(globalThis,"fetch",async(url,options={})=>{
    if(options.method&&options.method!=="GET")writes++;
    return String(url).includes("git/ref/") ? response({object:{sha:"newer"}}) : new Response("newer-db");
  });
  await assert.rejects(writeEtfFilesToGitHub([{path:"data/reports.json",content:"stale"}],"update",{sha:"seed",payload:"old-db"}),/refusing to overwrite/);
  assert.equal(writes,0);
});

test("expired ETF execution budget prevents a late repository write",async(t)=>{
  env(t,"GITHUB_REPORT_TOKEN","test-token");let calls=0;
  t.mock.method(globalThis,"fetch",async()=>{calls++;throw Error("unexpected");});
  await assert.rejects(writeEtfFilesToGitHub([{path:"data/reports.json",content:"stale"}],"update",{sha:"seed",payload:"old-db"},{deadline:Date.now()-1}),/budget exhausted/);
  assert.equal(calls,0);
});

test("ETF page identifies minute backfill while preserving normal snapshot copy",async()=>{
  const html=await readFile(new URL("../outputs/etf-rotation.html",import.meta.url),"utf8");
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  for(const [basis,time] of [["intraday_quote","14:50"],["minute_1450_open_backfill","14:50"],["intraday_quote","14:53"],["minute_1453_open_backfill","14:53"]]){
    const elements=new Map();
    const get=id=>{if(!elements.has(id))elements.set(id,{innerHTML:"",addEventListener(){}});return elements.get(id);};
    const report={executionTime:time,date,generatedAt:`${date}T13:20:00Z`,holding:null,etfs:[],rebalance:[],netValue:1,executionPriceBasis:basis};
    runInNewContext(`${script}\n report=${JSON.stringify(report)};render();`,{
      document:{getElementById:get},fetch:()=>new Promise(()=>{}),location:{assign(){}}
    });
    assert.ok(get("meta").innerHTML.includes(basis==="intraday_quote"?"&#25253;&#20215;&#24555;&#29031; "+time:time+"&#20998;&#38047;&#24320;&#30424;&#20215;&#34917;&#25253;"));
    assert.ok(get("content").innerHTML.includes("<th>"+time+"&#20215;&#26684;</th>"));
  }
});


