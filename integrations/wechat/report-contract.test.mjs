import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { join } from "node:path";
import { generateEtfRotation } from "../../src/etf-rotation.js";

// Synthetic fixtures stay in memory; no test prices are written to report files.
test("ETF generation always emits an array on buy, hold and cash days", async () => {
  const originalFetch = globalThis.fetch;
  let quotePrice = 110;
  const codes = ["159915", "510300", "518880", "159941", "513050", "511260"];
  const timestamps = Array.from({ length: 40 }, (_, i) => Date.parse("2026-09-01T07:00:00Z") / 1000 + i * 86400);
  globalThis.fetch = async url => {
    if (String(url).startsWith("https://query1.finance.yahoo.com/")) return { ok: true, json: async () => ({ chart: { result: [{ timestamp: timestamps, indicators: { quote: [{ close: timestamps.map(() => 100) }] } }] } }) };
    assert.ok(String(url).startsWith("https://push2.eastmoney.com/"));
    return { ok: true, json: async () => ({ data: { diff: codes.map(f12 => ({ f12, f2: quotePrice })) } }) };
  };
  try {
    const input = { date: "2026-10-30", now: new Date("2026-10-30T06:53:00Z"), portfolio: null };
    const first = await generateEtfRotation(input);
    assert.equal(first.report.rebalance.length, 1);
    const hold = await generateEtfRotation({ ...input, portfolio: first.portfolio });
    assert.deepEqual(hold.report.rebalance, []);
    assert.deepEqual(hold.report.holding, first.report.holding);
    assert.equal(hold.report.netValue, first.report.netValue);
    quotePrice = 90;
    const cash = await generateEtfRotation(input);
    assert.deepEqual(cash.report.rebalance, []);
    assert.equal(cash.report.holding, null);
    assert.equal(cash.report.netValue, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("static ETF export normalizes only absent trades without changing financial data", async () => {
  const source = (await readFile(new URL("../../src/cli.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "");
  const writes = new Map();
  const reports = {
    "2026-10-28": { date: "2026-10-28", status: "ok", netValue: 1, rebalance: null, etfs: [] },
    "2026-10-29": { date: "2026-10-29", status: "ok", netValue: 1.01, rebalance: [{ action: "buy", symbol: "SH511260", price: 135.667 }], etfs: [] },
    "2026-10-30": { date: "2026-10-30", status: "ok", netValue: 1.02, rebalance: null, holding: { symbol: "SH511260" }, etfs: [] }
  };
  const db = { dailyReports: {}, weeklyReports: {}, lateReports: {}, newsReports: {}, etfRotationReports: reports, etfRotationPortfolio: { history: [] }, jobLogs: [] };
  await runInNewContext(`(async () => { ${source}\n await exportStatic(inputDb); })()`, {
    process: { argv: [], env: {} }, console: { log() {}, warn() {} }, join, inputDb: db,
    mkdir: async () => {}, readdir: async () => [], rm: async () => {},
    writeFile: async (path, value) => writes.set(path.replaceAll("\\", "/"), JSON.parse(value))
  });
  for (const [date, report] of Object.entries(reports)) {
    const output = writes.get(`outputs/data/reports/etf-rotation/${date}.json`);
    assert.equal(JSON.stringify(output), JSON.stringify({ ...report, rebalance: report.rebalance ?? [], portfolioHistory: [] }));
  }
  assert.deepEqual(writes.get("outputs/data/reports/etf-rotation-latest.json").rebalance, []);
  assert.equal(reports["2026-10-30"].rebalance, null);
});
