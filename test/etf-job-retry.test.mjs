import test from "node:test";
import assert from "node:assert/strict";
import { runEtfJobWithRetry, isRetryableEtfError } from "../src/etf-job-retry.js";

test("temporary storage failure retries after ten seconds and succeeds",async()=>{
  let calls=0;const waits=[],attempts=[],retries=[];
  const result=await runEtfJobWithRetry(async context=>{
    attempts.push(context.attempt);assert.ok(context.deadline>Date.now());
    if(++calls===1)throw Object.assign(new Error("storage unavailable"),{status:503});
    return {status:"completed"};
  },{wait:async ms=>waits.push(ms),onRetry:value=>retries.push(value.attempt)});
  assert.deepEqual(result,{status:"completed"});assert.deepEqual(attempts,[1,2]);
  assert.deepEqual(waits,[10000]);assert.deepEqual(retries,[1]);
});

test("persistent temporary errors stop after three attempts",async()=>{
  let calls=0;const waits=[];
  await assert.rejects(runEtfJobWithRetry(async()=>{calls++;throw new TypeError("fetch failed");},{wait:async ms=>waits.push(ms)}),error=>error.retryAttempts===3);
  assert.equal(calls,3);assert.deepEqual(waits,[10000,10000]);
});

test("authentication, missing configuration, corrupt history and invalid data fail closed",async()=>{
  const errors=[Object.assign(new Error("Unauthorized"),{status:401}),new Error("GITHUB_REPORT_TOKEN is not configured"),new Error("ETF net value history changed unexpectedly"),new Error("ETF report prices or net value are incomplete")];
  for(const error of errors){
    let calls=0,waits=0;
    await assert.rejects(runEtfJobWithRetry(async()=>{calls++;throw error;},{wait:async()=>waits++}));
    assert.equal(calls,1);assert.equal(waits,0);
  }
});

test("replaying an uncertain commit reuses the saved report instead of trading twice",async()=>{
  let saved=null,trades=0,calls=0;
  const result=await runEtfJobWithRetry(async()=>{
    calls++;
    if(saved)return {skipped:true,report:saved};
    trades++;saved={netValue:0.9054761569445161,history:["prior","today"]};
    throw Object.assign(new Error("response interrupted after commit"),{status:502});
  },{wait:async()=>{}});
  assert.equal(calls,2);assert.equal(trades,1);assert.equal(result.report,saved);assert.equal(result.skipped,true);
});

test("attempts share the execution deadline and stop when the remaining budget is too small",async()=>{
  let time=1000,calls=0,waits=0;
  await assert.rejects(runEtfJobWithRetry(async context=>{
    assert.equal(context.deadline,271000);calls++;time+=250000;throw new TypeError("fetch failed");
  },{now:()=>time,wait:async()=>waits++}),error=>error.retryAttempts===1);
  assert.equal(calls,1);assert.equal(waits,0);
});

test("only transient source, storage and timeout failures are retryable",()=>{
  for(const error of [Object.assign(new Error("rate limited"),{status:429}),Object.assign(new Error("conflict"),{code:"REPORT_STORAGE_CONFLICT"}),Object.assign(new Error("slow child"),{code:"REPORT_STEP_TIMEOUT"}),new Error("report generator exited 1: Yahoo HTTP 502"),new Error("缺少 2026-11-09 14:50 真实分钟行情")])assert.equal(isRetryableEtfError(error),true);
  assert.equal(isRetryableEtfError(Object.assign(new Error("permanent"),{status:403})),false);
});
