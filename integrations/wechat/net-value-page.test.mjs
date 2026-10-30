import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { monthsBefore, validDate, normalizeReport, selectWindow, loadCurveReport } from "../../outputs/etf-net-value.js";

// Synthetic cases stay in tests and are never exported as real report data.
function fixture() {
  const history = Array.from({ length: 32 }, (_, i) => ({ date: new Date(Date.UTC(2026, 8, 28 + i)).toISOString().slice(0, 10), netValue: 1 + i / 1000, rebalanced: i % 4 === 0 }));
  return { type: "etf-rotation", status: "ok", date: "2026-10-29", netValue: 1.031, holding: null, rebalance: [], portfolioHistory: history };
}

test("calendar range cutoffs handle month ends and leap years", () => {
  assert.equal(monthsBefore("2026-10-29", 1), "2026-09-29");
  assert.equal(monthsBefore("2026-10-29", 6), "2026-04-29");
  assert.equal(monthsBefore("2026-10-29", 12), "2025-10-29");
  assert.equal(monthsBefore("2026-03-31", 1), "2026-02-28");
  assert.equal(monthsBefore("2024-03-31", 1), "2024-02-29");
  assert.equal(validDate("2026-02-30"), false);
});

test("20-day navigation is clamped; month and year buttons include all available points", () => {
  const report = normalizeReport(fixture());
  assert.equal(selectWindow(report).items.length, 20);
  assert.equal(selectWindow(report).windowStart, 12);
  assert.equal(selectWindow(report, "20", -99).windowStart, 0);
  assert.equal(selectWindow(report, "20", 999).windowStart, 12);
  assert.equal(selectWindow(report, "1m").items[0].date, "2026-09-29");
  assert.equal(selectWindow(report, "1m").items.length, 31);
  for (const mode of ["6m", "1y"]) assert.equal(selectWindow(report, mode).items.length, 32);
  assert.equal(selectWindow(report, "1y").items[0].date, "2026-09-28");
});

test("historical article dates never show future NAV; null values are not drawn as zero", () => {
  const report = fixture();
  report.portfolioHistory.push({ date: "2026-10-30", netValue: 2 }, { date: "2026-08-01", netValue: null });
  const normalized = normalizeReport(report, "2026-10-29");
  assert.equal(normalized.portfolioHistory.length, 32);
  assert.equal(normalized.portfolioHistory.at(-1).date, report.date);
  assert.throws(() => normalizeReport(report, "2026-10-28"));
  assert.throws(() => normalizeReport({ ...report, netValue: 5 }), /不一致/);
});

test("the current real NAV is retained as a single point when history is absent", () => {
  const report = normalizeReport({ ...fixture(), portfolioHistory: [], rebalance: [{ action: "sell", symbol: "SH510300", price: 3 }] });
  assert.equal(report.portfolioHistory.length, 1);
  assert.equal(report.portfolioHistory[0].netValue, 1.031);
  assert.equal(report.portfolioHistory[0].trades[0].price, 3);
});

test("missing date-specific reports fail without falling back to the latest date", async () => {
  const calls = [];
  await assert.rejects(loadCurveReport("2026-10-28", async url => { calls.push(url); return { ok: false, status: 404 }; }), /该日期/);
  assert.deepEqual(calls, ["data/reports/etf-rotation/2026-10-28.json"]);
  await assert.rejects(loadCurveReport("2026-02-30", () => assert.fail("invalid date fetch")), /无效/);
});

test("dedicated curve page includes the requested range buttons and no stock-report table", async () => {
  const html = await readFile(new URL("../../outputs/etf-net-value.html", import.meta.url), "utf8");
  for (const text of ["近一个月", "近半年", "近一年", "20 个交易日"]) assert.ok(html.includes(text));
  assert.doesNotMatch(html, /<table|行情报告|6 只 ETF/);
});

test("curve page omits the source-date row while retaining the calculation note", async () => {
  const html = await readFile(new URL("../../outputs/etf-net-value.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../../outputs/etf-net-value.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="benchmarkStatus"/);
  assert.doesNotMatch(script, /benchmarkStatus|sourceNotes/);
  assert.match(html, /区间起点归一为 1/);
  assert.match(html, /模拟组合记录，不构成投资建议/);
});
