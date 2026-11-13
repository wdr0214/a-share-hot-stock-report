import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { BENCHMARKS, reportCutoff, normalizeBenchmarks, buildComparison, completedCloseAt } from "../../outputs/etf-benchmark-model.js";
import { usCloseTime, parseYahoo, parseHiThink, parseTencentRealtimeQuote, exportBenchmarks } from "../../scripts/export-etf-benchmarks.mjs";

// Only synthetic unit-test fixtures; never published as market history.
const cnRow = (date, close) => ({ date, close, availableAt: new Date(date + "T15:00:00+08:00").toISOString() });
const usRow = (date, close) => ({ date, close, availableAt: usCloseTime(date) });
const payload = () => ({ version: 1, series: [
  { ...BENCHMARKS[0], source: "test", status: "ok", rows: [cnRow("2026-10-26", 4000), cnRow("2026-10-27", 4400), cnRow("2026-10-28", 4200), cnRow("2026-10-29", 9000)] },
  { ...BENCHMARKS[1], source: "test", status: "ok", rows: [usRow("2026-10-26", 20000), usRow("2026-10-27", 22000), usRow("2026-10-28", 23000), usRow("2026-10-29", 50000)] }
] });

test("comparison rebases all three series to one and excludes future daily closes", () => {
  const items = [{ date: "2026-10-27", netValue: 0.9 }, { date: "2026-10-28", netValue: 0.99 }, { date: "2026-10-29", netValue: 0.945 }];
  const lines = buildComparison(items, { executionTime: "14:53" }, payload());
  for (const line of lines) assert.equal(line.rows[0].value, 1);
  assert.ok(Math.abs(lines[0].rows[2].value - 1.05) < 1e-12);
  assert.equal(lines[1].rows[2].value, 9000 / 4400);
  assert.equal(lines[2].rows[1].value, 23000 / 22000);
  assert.equal(lines[2].rows[2].value, null);
  assert.equal(lines[1].rows[2].sourceDate, "2026-10-29");
  assert.equal(lines[2].rows[1].sourceDate, "2026-10-28");
  assert.equal(lines[2].rows[2].sourceDate, null);
  assert.equal(completedCloseAt(normalizeBenchmarks(payload()).series[0].rows, reportCutoff("2026-10-29", "15:01")).date, "2026-10-29");
});

test("CSI 300 never substitutes the prior session when a same-day row is missing", () => {
  const p = payload();
  p.series[0].rows = p.series[0].rows.filter(row => row.date !== "2026-10-29");
  const line = buildComparison([
    { date: "2026-10-28", netValue: 1 },
    { date: "2026-10-29", netValue: 1.01 }
  ], { date: "2026-10-29", executionTime: "14:50" }, p)[1];
  assert.equal(line.rows[0].sourceDate, "2026-10-28");
  assert.equal(line.rows[1].sourceDate, null);
  assert.equal(line.rows[1].value, null);
});

test("Tencent realtime CSI 300 quote is accepted only for the report date after execution", () => {
  const fields = Array(31).fill("");
  fields[2] = "000300"; fields[3] = "4123.45"; fields[30] = "20261113145021";
  const quote = parseTencentRealtimeQuote(`v_sh000300="${fields.join("~")}";`, "2026-11-13", "14:50");
  assert.equal(quote.date, "2026-11-13");
  assert.equal(quote.close, 4123.45);
  assert.equal(quote.basis, "intraday");
  assert.throws(() => parseTencentRealtimeQuote(`v_sh000300="${fields.join("~")}";`, "2026-11-12", "14:50"), /outside the report session/);
  fields[30] = "20261113144959";
  assert.throws(() => parseTencentRealtimeQuote(`v_sh000300="${fields.join("~")}";`, "2026-11-13", "14:50"), /outside the report session/);
  fields[30] = "20261113150000";
  assert.throws(() => parseTencentRealtimeQuote(`v_sh000300="${fields.join("~")}";`, "2026-11-13", "14:50"), /outside the report session/);
});

test("same-day report uses a timestamped intraday CSI 300 point", async () => {
  const dir = await mkdtemp(join(tmpdir(), "etf-benchmark-intraday-test-"));
  const reportPath = join(dir, "report.json"), outputPath = join(dir, "benchmarks.json");
  try {
    await writeFile(reportPath, JSON.stringify({
      type: "etf-rotation", status: "ok", date: "2026-11-13", executionTime: "14:50", netValue: 1,
      portfolioHistory: [{ date: "2026-11-12", netValue: 0.99 }, { date: "2026-11-13", netValue: 1 }], rebalance: [], holding: null
    }));
    const quoteFields = Array(31).fill("");
    quoteFields[2] = "000300"; quoteFields[3] = "4123.45"; quoteFields[30] = "20261113145021";
    const text = `v_sh000300="${quoteFields.join("~")}";`;
    const yahoo = { chart: { result: [{ meta: { symbol: "^IXIC", exchangeTimezoneName: "America/New_York" }, timestamp: ["2026-11-11", "2026-11-12"].map(date => Date.parse(`${date}T15:00:00-05:00`) / 1000), indicators: { quote: [{ close: [23000, 23100] }] } }] } };
    const fetchImpl = async url => {
      if (url.includes("fqkline/get")) return { ok: true, json: async () => ({ code: 0, data: { sh000300: { day: [["2026-11-11", "4100", "4110"], ["2026-11-12", "4110", "4120"]] } } }) };
      if (url.includes("qt.gtimg.cn")) return { ok: true, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
      return { ok: true, json: async () => yahoo };
    };
    const result = await exportBenchmarks({ reportPath, outputPath, key: null, now: new Date("2026-11-13T06:52:00.000Z"), producer: "test", fetchImpl, wait: async () => {}, print: () => {} });
    assert.equal(result.series[0].status, "ok");
    assert.equal(result.series[0].rows.at(-1).date, "2026-11-13");
    assert.equal(result.series[0].rows.at(-1).basis, "intraday");
    const comparison = buildComparison([{ date: "2026-11-12", netValue: 0.99 }, { date: "2026-11-13", netValue: 1 }], { date: "2026-11-13", executionTime: "14:50" }, result);
    assert.equal(comparison[1].rows.at(-1).sourceDate, "2026-11-13");
    assert.equal(comparison[1].rows.at(-1).basis, "intraday");
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("etf-benchmark-intraday-test-"));
    await rm(dir, { recursive: true, force: true });
  }
});

test("Nasdaq uses actual US session dates and does not extend across holidays or report day", () => {
  const p = payload();
  p.series[1].rows = [usRow("2026-10-26", 20000), usRow("2026-10-28", 23000), usRow("2026-10-29", 50000)];
  const items = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"].map(date => ({ date, netValue: 1 }));
  const line = buildComparison(items, { date: "2026-10-29", executionTime: "14:53" }, p)[2];
  assert.deepEqual(line.rows.map(row => row.sourceDate), ["2026-10-26", null, "2026-10-28", null]);
  assert.deepEqual(line.rows.map(row => row.value), [1, null, 1.15, null]);
  const older = buildComparison(items.slice(0, 3), { date: "2026-10-28" }, p)[2];
  assert.equal(older.rows.at(-1).value, null);
  const historical = buildComparison(items.slice(0, 3), { date: "2026-10-29" }, p)[2];
  assert.equal(historical.rows.at(-1).sourceDate, "2026-10-28");
  const single = buildComparison(items.slice(-1), { date: "2026-10-29" }, p)[2];
  assert.equal(single.rows[0].value, null);
});

test("US close timestamps handle daylight saving and never use incomplete sessions", () => {
  assert.equal(usCloseTime("2026-10-29"), "2026-10-29T20:00:00.000Z");
  assert.equal(usCloseTime("2026-11-02"), "2026-11-02T21:00:00.000Z");
  const y = { chart: { result: [{ meta: { symbol: "^IXIC", exchangeTimezoneName: "America/New_York" }, timestamp: [Date.parse("2026-10-29T13:30:00Z") / 1000], indicators: { quote: [{ close: [24000] }] } }] } };
  const rows = parseYahoo(y);
  assert.equal(completedCloseAt(rows, reportCutoff("2026-10-29")), null);
  assert.throws(() => parseYahoo({ chart: { result: [{ ...y.chart.result[0], meta: { ...y.chart.result[0].meta, symbol: "^NDX" } }] } }), /unavailable/);
});

test("missing baseline, null quotes and stopped feeds are not zero-filled or given invented returns", () => {
  const p = payload(); p.series[0].rows = [cnRow("2026-10-28", null), cnRow("2026-10-29", 9000)];
  const lines = buildComparison([{ date: "2026-10-27", netValue: 1 }, { date: "2026-10-29", netValue: 0.9 }], {}, p);
  assert.ok(lines[1].rows.every(row => row.value === null));
  assert.equal(completedCloseAt([cnRow("2026-09-01", 4000)], reportCutoff("2026-10-29")), null);
  assert.throws(() => normalizeBenchmarks({ version: 1, series: [{ ...BENCHMARKS[0], symbol: "SH510300", rows: [] }] }), /不匹配/);
  assert.throws(() => parseHiThink({ code: 2003, data: null }), /unavailable/);
});

test("failed refresh keeps genuine cached rows and marks the feed stale", async () => {
  const dir = await mkdtemp(join(tmpdir(), "etf-benchmark-test-"));
  try {
    const reportPath = join(dir, "report.json"), outputPath = join(dir, "benchmarks.json");
    const report = { type: "etf-rotation", status: "ok", date: "2026-10-29", netValue: 1, executionTime: "14:53", portfolioHistory: [{ date: "2026-10-27", netValue: 1 }, { date: "2026-10-29", netValue: 1 }], rebalance: [], holding: null };
    await writeFile(reportPath, JSON.stringify(report)); await writeFile(outputPath, JSON.stringify(payload()));
    const result = await exportBenchmarks({ reportPath, outputPath, key: "test-only-key", force: true, wait: async () => {}, print: () => {}, fetchImpl: async () => ({ ok: false, status: 403 }) });
    for (const series of result.series) { assert.equal(series.status, "stale"); assert.ok(series.rows.length > 0); }
    assert.ok(!(await readFile(outputPath, "utf8")).includes("test-only-key"));
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("etf-benchmark-test-"));
    await rm(dir, { recursive: true, force: true });
  }
});

