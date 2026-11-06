import test from "node:test";
import assert from "node:assert/strict";
import { recoverArchivedEtf, etfFilesAreCurrent, preparePublishedReports } from "../api/_github-report-job.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function env(t){const old=process.env.GITHUB_REPORT_TOKEN;process.env.GITHUB_REPORT_TOKEN="test-token";t.after(()=>{if(old===undefined)delete process.env.GITHUB_REPORT_TOKEN;else process.env.GITHUB_REPORT_TOKEN=old;});}
const date="2026-11-06",previous="2026-11-05";
function data(){
  const before={date:previous,netValue:1},point={date,netValue:1.01};
  const history=[before,point];
  const report={date,status:"ok",netValue:1.01,holding:null,etfs:Array.from({length:6},(_,i)=>({symbol:`SZ15990${i}`,price:1})),portfolioHistory:history};
  const snapshot={db:{etfRotationReports:{},etfRotationPortfolio:{netValue:1,holding:null,cash:1,history:[before]},lateReports:{[date]:{date,status:"ok"}},latePortfolio:{netValue:1.02},jobLogs:[]}};
  const historical={etfRotationReports:{[date]:report},etfRotationPortfolio:{netValue:1.01,holding:null,cash:1.01,history},lateReports:{},jobLogs:[]};
  return {snapshot,historical,report};
}
const response=value=>new Response(JSON.stringify(value));
test("deleted real ETF report is restored from its original commit, keeping the current tail report",async(t)=>{
  env(t);const {snapshot,historical,report}=data();const calls=[];
  t.mock.method(globalThis,"fetch",async url=>{
    calls.push(String(url));
    if(String(url).includes("/commits?"))return response([{sha:"deleted"},{sha:"original"}]);
    if(String(url).includes("/deleted/"))return new Response("not found",{status:404});
    if(String(url).endsWith("/data/reports.json"))return response(historical);
    return response(report);
  });
  const restored=await recoverArchivedEtf(snapshot,date);
  assert.deepEqual(restored.etfRotationReports[date],report);
  assert.deepEqual(restored.lateReports,snapshot.db.lateReports);assert.deepEqual(restored.latePortfolio,snapshot.db.latePortfolio);
  assert.ok(calls.every(url=>url.includes("github")));assert.equal(restored.etfRotationPortfolio.history.length,2);
});
test("a successful report is reused without reading prices or archives",async(t)=>{
  env(t);const {historical}=data();let calls=0;t.mock.method(globalThis,"fetch",async()=>{calls++;throw Error("unexpected");});
  assert.equal(await recoverArchivedEtf({db:historical},date),null);assert.equal(calls,0);
});
test("no archived report means normal generation, never an invented historical quote",async(t)=>{
  env(t);t.mock.method(globalThis,"fetch",async()=>response([]));
  assert.equal(await recoverArchivedEtf(data().snapshot,date),null);
});

test("successful compensation requires both dated report and latest pointer, not just a completed log",async(t)=>{
  env(t);const {historical,report}=data();const snapshot={sha:"current",db:historical};
  t.mock.method(globalThis,"fetch",async()=>response(report));assert.equal(await etfFilesAreCurrent(snapshot,date),true);
  t.mock.method(globalThis,"fetch",async url=>String(url).endsWith("latest.json")?new Response("missing",{status:404}):response(report));
  assert.equal(await etfFilesAreCurrent(snapshot,date),false);
});

test("Pages refuses to publish an older database after a completed ETF snapshot disappears",async(t)=>{
  env(t);const {snapshot}=data();snapshot.db.jobLogs=[];
  const workspace=await mkdtemp(join(tmpdir(),"report-integrity-test-"));t.after(()=>rm(workspace,{recursive:true,force:true}));
  t.mock.method(globalThis,"fetch",async url=>{
    if(String(url).includes("git/ref/"))return response({object:{sha:"current"}});
    if(String(url).endsWith("etf-rotation-job.json"))return response({date,status:"completed"});
    return response(snapshot.db);
  });
  await assert.rejects(preparePublishedReports(workspace),/refuse to publish stale data/);
});
