import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { BENCHMARKS, reportCutoff, normalizeBenchmarks, buildComparison, completedCloseAt } from "../../outputs/etf-benchmark-model.js";
import { usCloseTime, parseYahoo, parseHiThink, exportBenchmarks } from "../../scripts/export-etf-benchmarks.mjs";

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
  assert.equal(lines[1].rows[2].value, 1.05);
  assert.equal(lines[2].rows[2].value, 1.15);
  assert.equal(lines[1].rows[2].sourceDate, "2026-10-28");
  assert.equal(lines[2].rows[2].sourceDate, "2026-10-28");
  assert.equal(completedCloseAt(normalizeBenchmarks(payload()).series[0].rows, reportCutoff("2026-10-29", "15:01")).date, "2026-10-29");
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
