import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeGeneratedReport } from "../src/report-state.js";
import { persistGeneratedReport } from "../api/_github-report-job.mjs";

const day="2026-11-06", previous="2026-11-05";
const symbols=["SZ159915","SH510300","SH518880","SZ159941","SH513050","SH511260"];
function log(jobName, reportKey, minute){return {jobName,reportKey,startedAt:`2026-11-06T06:${minute}:00Z`,status:"ok"};}
function fixture(){
  const history=[{date:previous,netValue:1,holding:null,rebalanced:false,trades:[]}];
  const portfolio={netValue:1,cash:1,holding:null,history};
  const report={type:"etf-rotation",date:previous,status:"ok",netValue:1,holding:null,rebalance:[],etfs:symbols.map(symbol=>({symbol,price:1})),portfolioHistory:history};
  return {dailyReports:{},weeklyReports:{},lateReports:{},newsReports:{},etfRotationReports:{[previous]:report},etfRotationPortfolio:portfolio,latePortfolio:null,jobLogs:[]};
}
function etfUpdate(db){
  const next=structuredClone(db), history=[...next.etfRotationPortfolio.history,{date:day,netValue:1,holding:null,rebalanced:false,trades:[]}];
  next.etfRotationPortfolio.history=history;
  next.etfRotationReports[day]={...next.etfRotationReports[previous],date:day,portfolioHistory:history};
  next.jobLogs.push(log("etf-rotation",day,"53"));return next;
}
function lateUpdate(db){
  const next=structuredClone(db);next.lateReports[day]={date:day,status:"ok",stocks:[],generatedAt:`${day}T06:54:00Z`};
  next.latePortfolio={netValue:1,cash:1,positions:[],history:[{date:day,netValue:1}]};next.jobLogs.push(log("late-report",day,"54"));return next;
}

test("late writer started before ETF cannot overwrite the new ETF report, NAV or logs",()=>{
  const snapshot=fixture(), current=etfUpdate(snapshot), generated=lateUpdate(snapshot);
  const {db}=mergeGeneratedReport({current,snapshot,generated,type:"late",date:day});
  assert.deepEqual(db.etfRotationReports,current.etfRotationReports);
  assert.deepEqual(db.etfRotationPortfolio,current.etfRotationPortfolio);
  assert.deepEqual(db.lateReports[day],generated.lateReports[day]);assert.equal(db.jobLogs.length,2);
});

test("ETF writer preserves a tail report that completed during generation",()=>{
  const snapshot=fixture(), current=lateUpdate(snapshot), generated=etfUpdate(snapshot);
  const {db}=mergeGeneratedReport({current,snapshot,generated,type:"etf-rotation",date:day});
  assert.deepEqual(db.lateReports,current.lateReports);assert.deepEqual(db.latePortfolio,current.latePortfolio);
  assert.deepEqual(db.etfRotationPortfolio,generated.etfRotationPortfolio);assert.equal(db.jobLogs.length,2);
});

test("compensation reuses today's original report instead of buying or valuing twice",()=>{
  const snapshot=fixture(), current=etfUpdate(snapshot), generated=etfUpdate(snapshot);
  const result=mergeGeneratedReport({current,snapshot,generated,type:"etf-rotation",date:day});
  assert.equal(result.alreadyPublished,true);assert.equal(result.db,current);assert.equal(result.db.etfRotationPortfolio.history.length,2);
});

test("a same-type concurrent tail update is rejected instead of overwriting its portfolio",()=>{
  const snapshot=fixture(), current=lateUpdate(snapshot), generated=lateUpdate(snapshot);
  assert.throws(()=>mergeGeneratedReport({current,snapshot,generated,type:"late",date:day}),/changed concurrently/);
});

test("missing ETF fields and a reset history cannot be marked complete",()=>{
  const snapshot=fixture(),generated=etfUpdate(snapshot);generated.etfRotationReports[day].etfs=[];
  assert.throws(()=>mergeGeneratedReport({current:snapshot,snapshot,generated,type:"etf-rotation",date:day}),/incomplete/);
  const reset=etfUpdate(snapshot);reset.etfRotationPortfolio.history.shift();
  assert.throws(()=>mergeGeneratedReport({current:snapshot,snapshot,generated:reset,type:"etf-rotation",date:day}),/history changed/);
});

test("push publishes only: it cannot rewrite report data or rebase stale generated JSON",async()=>{
  const workflow=await readFile(new URL("../.github/workflows/github-pages.yml",import.meta.url),"utf8");
  const persist=workflow.match(/- name: Persist generated report data([\s\S]*?)(?=\n      - uses:)/)[1];
  assert.match(persist,/if: github.event_name == 'workflow_dispatch'/);
  assert.doesNotMatch(persist,/git pull --rebase/);
  assert.doesNotMatch(workflow,/if: github.event_name == 'push' \|\|/);
  assert.doesNotMatch(workflow,/\n\s+schedule:/);
});

function env(t,key,value){const old=process.env[key];process.env[key]=value;t.after(()=>{if(old===undefined)delete process.env[key];else process.env[key]=old;});}
function response(body,status=200){return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});}

test("atomic writeback rebuilds indexes after a concurrent commit, preserving both reports",async(t)=>{
  env(t,"GITHUB_REPORT_TOKEN","fixture-token");
  const timer=setTimeout;t.mock.method(globalThis,"setTimeout",fn=>timer(fn,0));
  const workspace=await mkdtemp(join(tmpdir(),"report-race-test-"));t.after(()=>rm(workspace,{recursive:true,force:true}));
  await mkdir(join(workspace,"data"));
  const snapshot=fixture(), generated=etfUpdate(snapshot);await writeFile(join(workspace,"data","reports.json"),JSON.stringify(generated));
  let current=structuredClone(snapshot), head="seed", treeFiles, rejected=false, published;
  t.mock.method(globalThis,"fetch",async(url,options={})=>{
    const path=String(url),body=options.body&&JSON.parse(options.body);
    if(path.includes("git/ref/heads/"))return response({object:{sha:head}});
    if(path.includes("raw.githubusercontent.com"))return new Response(JSON.stringify(current));
    if(path.includes("git/commits/")&&!options.body)return response({tree:{sha:"base-tree"}});
    if(path.endsWith("git/trees")){treeFiles=body.tree;return response({sha:"tree"});}
    if(path.endsWith("git/commits"))return response({sha:"new-commit"});
    if(options.method==="PATCH"){
      assert.equal(body.force,false);
      if(!rejected){rejected=true;current=lateUpdate(snapshot);head="tail-commit";return response({message:"not fast forward"},422);}
      published=treeFiles;return response({object:{sha:"new-commit"}});
    }
    throw Error("Unexpected fixture URL");
  });
  await persistGeneratedReport(workspace,"etf-rotation",day,{sha:"seed",payload:JSON.stringify(snapshot),db:snapshot},{headers:{host:"example.test"}});
  const db=JSON.parse(published.find(file=>file.path==="data/reports.json").content);
  assert.ok(db.lateReports[day]);assert.ok(db.etfRotationReports[day]);assert.equal(db.etfRotationPortfolio.history.length,2);
  const index=JSON.parse(published.find(file=>file.path.endsWith("recent.json")).content);
  assert.equal(index.etfRotationReports[0].date,day);assert.equal(index.lateReports[0].date,day);
  assert.equal(JSON.parse(published.find(file=>file.path.endsWith("etf-rotation-job.json")).content).status,"completed");
});
