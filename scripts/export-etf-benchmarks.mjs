import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeReport } from "../outputs/etf-net-value.js";
import { BENCHMARKS, isoDate, reportCutoff, normalizeBenchmarks } from "../outputs/etf-benchmark-model.js";

const OUTPUT = resolve("outputs/data/etf-benchmarks.json");
const REPORT = resolve("outputs/data/reports/etf-rotation-latest.json");
const positive = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) && Number(value) > 0;
const dateIn = (time, zone) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(time));
const shiftDate = (date, days) => new Date(Date.parse(date + "T12:00:00Z") + days * 86400000).toISOString().slice(0, 10);

export function usCloseTime(date) {
  if (!isoDate(date)) throw new Error("Invalid US date");
  const part = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" }).formatToParts(new Date(date + "T12:00:00Z")).find(item => item.type === "timeZoneName").value;
  const match = part.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) throw new Error("Unknown New York offset");
  const offset = (Number(match[2]) * 60 + Number(match[3] || 0)) * (match[1] === "+" ? 1 : -1);
  // A normal 16:00 close is conservative for early-close sessions too.
  return new Date(Date.parse(date + "T16:00:00Z") - offset * 60000).toISOString();
}

export function parseHiThink(payload) {
  if (payload?.code !== 0 || payload.data?.thscode !== "000300.SH" || !Array.isArray(payload.data.item)) throw new Error("CSI 300 provider response unavailable");
  return payload.data.item.filter(row => positive(row.close_price) && Number.isFinite(Number(row.date_ms))).map(row => {
    const date = dateIn(Number(row.date_ms), "Asia/Shanghai");
    return { date, close: Number(row.close_price), availableAt: new Date(Date.parse(date + "T15:00:00+08:00")).toISOString() };
  });
}

export function parseTencent(payload) {
  const data = payload?.data?.sh000300;
  if (payload?.code !== 0 || !Array.isArray(data?.day)) throw new Error("CSI 300 backup response unavailable");
  return data.day.filter(row => isoDate(row[0]) && positive(row[2])).map(row => ({ date: row[0], close: Number(row[2]), availableAt: new Date(Date.parse(row[0] + "T15:00:00+08:00")).toISOString() }));
}

export function parseYahoo(payload) {
  const data = payload?.chart?.result?.[0];
  if (payload?.chart?.error || data?.meta?.symbol !== "^IXIC" || data.meta.exchangeTimezoneName !== "America/New_York" || !Array.isArray(data.timestamp)) throw new Error("Nasdaq Composite response unavailable");
  const close = data.indicators?.quote?.[0]?.close || [];
  return data.timestamp.flatMap((stamp, i) => {
    if (!positive(close[i])) return [];
    const date = dateIn(Number(stamp) * 1000, "America/New_York");
    return [{ date, close: Number(close[i]), availableAt: usCloseTime(date) }];
  });
}

async function getJson(url, { fetchImpl, key, wait }) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetchImpl(url, { headers: key ? { "X-api-key": key } : {}, redirect: "error", signal: AbortSignal.timeout(20000) });
      if (!response.ok) {
        if (attempt < 2 && [429, 502, 503, 504].includes(response.status)) { await response.body?.cancel(); await wait(10000); continue; }
        const error = new Error("Provider HTTP failure"); error.retryable = [429, 502, 503, 504].includes(response.status); throw error;
      }
      const payload = await response.json();
      if (attempt < 2 && (payload?.code === 4001 || (payload?.code >= 5000 && payload?.code < 6000))) { await wait(10000); continue; }
      return payload;
    } catch (error) {
      if (error.retryable === false) throw error;
      if (attempt < 2) { await wait(10000); continue; }
      throw new Error("Provider data unavailable after bounded retries");
    }
  }
}

function usableRows(rows, cutoff, firstDate) {
  const valid = rows.filter(row => Date.parse(row.availableAt) <= cutoff).sort((a, b) => a.date.localeCompare(b.date));
  if (!valid.length || Date.parse(valid[0].availableAt) > reportCutoff(firstDate) || cutoff - Date.parse(valid.at(-1).availableAt) > 14 * 86400000) throw new Error("Insufficient completed index history");
  return valid;
}

export async function exportBenchmarks({
  reportPath = REPORT, outputPath = OUTPUT, fetchImpl = fetch, key = process.env.HITHINK_FINANCE_API_KEY,
  now = new Date(), force = false, producer = process.env.GITHUB_ACTIONS === "true" ? "github-actions" : "local",
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), print = console.log
} = {}) {
  const report = normalizeReport(JSON.parse(await readFile(reportPath, "utf8")));
  const start = shiftDate(report.portfolioHistory[0].date, -21), cutoff = reportCutoff(report.date, report.executionTime || "14:53");
  let previous = null;
  try { previous = normalizeBenchmarks(JSON.parse(await readFile(outputPath, "utf8"))); } catch {}
  if (!force && previous?.cutoffAt === new Date(cutoff).toISOString() && previous.requestedStart === start && previous.generatedBy === producer) {
    if (previous.series.every(item => item.status === "ok") || now.getTime() - Date.parse(previous.generatedAt) < 1800000) {
      print(JSON.stringify({ benchmarkCache: "reused", reportDate: report.date })); return previous;
    }
  }
  const series = [];
  for (const expected of BENCHMARKS) {
    try {
      let rows, source;
      if (expected.id === "csi300") {
        if (key) {
          try {
            const params = new URLSearchParams({ thscode: "000300.SH", interval: "1d", start: String(Date.parse(start + "T00:00:00+08:00")), end: String(cutoff + 86400000) });
            rows = usableRows(parseHiThink(await getJson("https://fuyao.aicubes.cn/api/a-share-index/prices/historical?" + params, { fetchImpl, key, wait })), cutoff, report.portfolioHistory[0].date);
            source = "同花顺 Financial API";
          } catch { rows = null; }
        }
        if (!rows) {
          rows = usableRows(parseTencent(await getJson("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000300,day,,,640,", { fetchImpl, wait })), cutoff, report.portfolioHistory[0].date);
          source = "腾讯财经";
        }
      } else {
        const params = new URLSearchParams({ period1: String(Math.floor(Date.parse(start + "T00:00:00Z") / 1000)), period2: String(Math.floor((cutoff + 86400000) / 1000)), interval: "1d" });
        rows = usableRows(parseYahoo(await getJson("https://query1.finance.yahoo.com/v8/finance/chart/%5EIXIC?" + params, { fetchImpl, wait })), cutoff, report.portfolioHistory[0].date);
        source = "Yahoo Finance";
      }
      series.push({ ...expected, source, status: "ok", lastSuccessfulAt: now.toISOString(), rows });
    } catch {
      const old = previous?.series.find(item => item.id === expected.id);
      series.push({ ...expected, ...(old || {}), status: old?.rows.length ? "stale" : "unavailable", error: "行情源暂不可用", rows: old?.rows || [] });
    }
  }
  const result = normalizeBenchmarks({ version: 1, generatedAt: now.toISOString(), generatedBy: producer, reportDate: report.date, cutoffAt: new Date(cutoff).toISOString(), requestedStart: start, basis: "latest-completed-close-at-report-time", series });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  print(JSON.stringify({ benchmarkDataSaved: true, reportDate: report.date, series: result.series.map(item => ({ id: item.id, source: item.source || null, status: item.status, rows: item.rows.length, latestDate: item.rows.at(-1)?.date || null })) }));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const reportIndex = process.argv.indexOf("--report");
  exportBenchmarks({ force: process.argv.includes("--force"), ...(reportIndex >= 0 ? { reportPath: resolve(process.argv[reportIndex + 1]) } : {}) }).catch(() => { console.error("指数对比缓存更新失败；未输出凭据，请保留已生成报告。"); process.exitCode = 1; });
}
