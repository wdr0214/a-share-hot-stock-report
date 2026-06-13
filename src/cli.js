import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DATA_FILE = "data/reports.json";
const OUT_DIR = "outputs/data/reports";
const TZ = "Asia/Shanghai";
const PAGE_SIZE = 500;
const FS_ALL_A = "m:1+t:2,m:0+t:6,m:0+t:80,m:0+t:81";
const EM_FIELDS = "f12,f14,f2,f3,f6,f7,f8,f10,f62,f66,f69,f72,f75";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const num = v => (v === undefined || v === null || v === "-" ? null : Number(v));
const finite = v => Number.isFinite(v) ? v : null;
const round = (v, d = 2) => finite(v) === null ? null : Number(v.toFixed(d));
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const todayCN = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

function cnParts() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute), weekday: p.weekday };
}

function isWeekday(date) {
  const d = new Date(`${date}T00:00:00+08:00`).getUTCDay();
  return d >= 1 && d <= 5;
}

function prevWeekday(date) {
  const d = new Date(`${date}T00:00:00+08:00`);
  do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

function currentWeek(date) {
  const d = new Date(`${date}T00:00:00+08:00`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-${String(week).padStart(2, "0")}`;
}

function rangeForWeek(date) {
  const d = new Date(`${date}T00:00:00+08:00`);
  const day = d.getUTCDay() || 7;
  const start = new Date(d); start.setUTCDate(d.getUTCDate() - day + 1);
  const end = new Date(start); end.setUTCDate(start.getUTCDate() + 4);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

async function readDb() {
  try {
    const db = JSON.parse(await readFile(DATA_FILE, "utf8"));
    return { dailyReports: {}, lateReports: {}, weeklyReports: {}, jobLogs: [], ...db };
  } catch {
    return { dailyReports: {}, lateReports: {}, weeklyReports: {}, jobLogs: [] };
  }
}

async function saveDb(db) {
  await mkdir("data", { recursive: true });
  await writeFile(DATA_FILE, `${JSON.stringify(db, null, 2)}\n`, "utf8");
}

async function fetchJson(url, options = {}, retries = 1) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", accept: "application/json,text/plain,*/*" }, ...options });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      last = err;
      if (attempt < retries) await wait(1200);
    }
  }
  throw last;
}

async function withJobRetry(fn) {
  try { return await fn(); }
  catch (err) {
    console.log(`first run failed, retrying once: ${err.message}`);
    await wait(3000);
    return await fn();
  }
}

function allowRun(type, date) {
  if (!isWeekday(date)) return { ok: false, reason: "not a trading weekday" };
  const now = cnParts();
  if (date !== now.date) return { ok: true };
  const threshold = type === "late" ? 14 * 60 + 55 : 16 * 60;
  if (now.minute < threshold) return { ok: false, reason: `before ${type === "late" ? "14:55" : "16:00"} Asia/Shanghai` };
  return { ok: true };
}

async function fetchMarketPage(pn) {
  const url = new URL("https://push2.eastmoney.com/api/qt/clist/get");
  url.search = new URLSearchParams({ pn: String(pn), pz: String(PAGE_SIZE), po: "1", np: "1", fltt: "2", invt: "2", fid: "f62", fs: FS_ALL_A, fields: EM_FIELDS }).toString();
  const json = await fetchJson(url);
  return json.data || { diff: [], total: 0 };
}

async function fetchAllMarketHotStocks() {
  const first = await fetchMarketPage(1);
  const total = Number(first.total || first.diff?.length || 0);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const all = [...(first.diff || [])];
  for (let pn = 2; pn <= pages; pn += 1) {
    const data = await fetchMarketPage(pn);
    all.push(...(data.diff || []));
    await wait(180);
  }
  return all.map(normalizeStock).filter(s => s.symbol && s.name && s.price > 0 && s.amount > 0);
}

function normalizeStock(x) {
  const superNet = num(x.f66) || 0;
  const largeNet = num(x.f72) || 0;
  const bigNet = superNet + largeNet;
  return {
    symbol: String(x.f12 || ""), name: String(x.f14 || ""), price: num(x.f2), changePct: num(x.f3), amount: num(x.f6), amplitude: num(x.f7), turnoverRate: num(x.f8), volumeRatio: num(x.f10), mainNetInflow: num(x.f62), superLargeOrderNetAmount: superNet, superLargeOrderNetRatio: num(x.f69), largeOrderNetAmount: largeNet, largeOrderNetRatio: num(x.f75), bigOrderNetAmount: bigNet
  };
}

function baseScore(s) {
  const positive = Math.max(0, s.changePct || 0);
  const bigRatio = Math.max(0, s.largeOrderNetRatio || 0) + Math.max(0, s.superLargeOrderNetRatio || 0);
  return round(
    clamp((s.amount || 0) / 20000000000, 0, 1) * 24 +
    clamp(positive / 10, 0, 1) * 22 +
    clamp((s.turnoverRate || 0) / 20, 0, 1) * 16 +
    clamp((s.volumeRatio || 0) / 5, 0, 1) * 14 +
    clamp((s.amplitude || 0) / 15, 0, 1) * 8 +
    clamp(Math.max(0, s.bigOrderNetAmount || 0) / 500000000, 0, 1) * 10 +
    clamp(bigRatio / 12, 0, 1) * 6
  );
}

function yahooSymbol(symbol) {
  if (/^[036]/.test(symbol)) return `${symbol}.${symbol.startsWith("6") ? "SS" : "SZ"}`;
  if (/^[489]/.test(symbol)) return `${symbol}.BJ`;
  return `${symbol}.SS`;
}

async function fetchKline(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol(symbol)}?range=6mo&interval=1d`;
  const json = await fetchJson(url);
  const result = json.chart?.result?.[0];
  const ts = result?.timestamp || [];
  const q = result?.indicators?.quote?.[0] || {};
  return ts.map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), open: round(q.open?.[i]), high: round(q.high?.[i]), low: round(q.low?.[i]), close: round(q.close?.[i]), volume: q.volume?.[i] ?? null })).filter(k => [k.open, k.high, k.low, k.close].every(v => v !== null));
}

function trendScore(kline) {
  if (kline.length < 20) return 0;
  const first = kline[0].close;
  const last = kline.at(-1).close;
  const pct = first ? (last - first) / first * 100 : 0;
  return round(clamp(pct / 30, -1, 1) * 8);
}

function isLimitUp(symbol, name, pct) {
  if (!Number.isFinite(pct)) return false;
  let limit = 10;
  if (name.includes("ST")) limit = 5;
  else if (/^(8|4|9)/.test(symbol)) limit = 30;
  else if (/^(30|68|69)/.test(symbol)) limit = 20;
  return pct >= limit - 0.15;
}

async function fetchQuotes(symbols) {
  if (!symbols.length) return new Map();
  const secids = symbols.map(s => `${s.startsWith("6") ? "1" : "0"}.${s}`).join(",");
  const url = new URL("https://push2.eastmoney.com/api/qt/ulist.np/get");
  url.search = new URLSearchParams({ fltt: "2", fields: "f12,f14,f2,f3,f17", secids }).toString();
  const json = await fetchJson(url);
  return new Map((json.data?.diff || []).map(x => [String(x.f12), { symbol: String(x.f12), name: String(x.f14), close: num(x.f2), changePct: num(x.f3), open: num(x.f17) }]));
}

async function previousStats(db, type, date) {
  const prev = prevWeekday(date);
  const source = (type === "late" ? db.lateReports?.[prev] : db.dailyReports?.[prev]) || db.dailyReports?.[prev] || db.lateReports?.[prev];
  if (!source?.stocks?.length) return [];
  const quotes = await fetchQuotes(source.stocks.map(s => s.symbol));
  return source.stocks.slice(0, 5).map(s => {
    const q = quotes.get(s.symbol) || {};
    const openClose = q.open && q.close ? (q.close - q.open) / q.open * 100 : null;
    return { symbol: s.symbol, name: s.name, yesterdayChangePct: round(s.changePct), wasLimitUpYesterday: isLimitUp(s.symbol, s.name, s.changePct), todayChangePct: round(q.changePct), todayOpen: q.open ?? null, todayClose: q.close ?? null, todayCloseVsOpenPct: round(openClose) };
  });
}

function keyPoints(s, kline) {
  const points = [];
  if ((s.amount || 0) > 10000000000) points.push("成交额居前");
  if ((s.changePct || 0) > 3) points.push("价格正向表现较强");
  if ((s.turnoverRate || 0) > 8) points.push("换手活跃");
  if ((s.volumeRatio || 0) > 1.5) points.push("量能放大");
  if ((s.bigOrderNetAmount || 0) > 0) points.push("大单资金净流入"); else points.push("大单资金为负，热度主要来自价格或成交活跃");
  if (trendScore(kline) > 0) points.push("近半年趋势改善");
  return points.slice(0, 5);
}

function factors(s) {
  const f = [];
  if ((s.bigOrderNetAmount || 0) > 0) f.push("大单净流入");
  if ((s.superLargeOrderNetAmount || 0) > 0) f.push("超大单活跃");
  if ((s.mainNetInflow || 0) > 0) f.push("主力资金");
  if ((s.changePct || 0) > 0) f.push("正向涨幅");
  if ((s.volumeRatio || 0) > 1.5) f.push("放量");
  return f;
}

async function generateMarketReport(type, date = todayCN()) {
  const gate = allowRun(type, date);
  if (!gate.ok) return { skipped: true, type, date, reason: gate.reason };
  const db = await readDb();
  const market = await fetchAllMarketHotStocks();
  const candidates = market.map(s => ({ ...s, activityScore: baseScore(s) })).sort((a, b) => b.activityScore - a.activityScore).slice(0, 30);
  const enriched = [];
  for (const s of candidates) {
    let kline = [];
    try { kline = await fetchKline(s.symbol); } catch (err) { console.log(`kline failed ${s.symbol}: ${err.message}`); }
    const t = trendScore(kline);
    enriched.push({ ...s, kline, trendScore: t, heatScore: round(s.activityScore + Math.max(0, t)) });
    await wait(120);
  }
  const stocks = enriched.sort((a, b) => b.heatScore - a.heatScore).slice(0, 5).map((s, i) => ({ rank: i + 1, symbol: s.symbol, name: s.name, heatScore: s.heatScore, activityScore: s.activityScore, momentumScore: s.trendScore, changePct: round(s.changePct), turnoverRate: round(s.turnoverRate), amount: s.amount, volumeRatio: round(s.volumeRatio), amplitude: round(s.amplitude), mainNetInflow: s.mainNetInflow, superLargeOrderNetAmount: s.superLargeOrderNetAmount, largeOrderNetAmount: s.largeOrderNetAmount, largeOrderNetRatio: round(s.largeOrderNetRatio), bigOrderNetAmount: s.bigOrderNetAmount, keyPoints: keyPoints(s, s.kline), positiveFactors: factors(s), kline: s.kline, klineStatus: s.kline.length ? "ok" : "行情数据异常" }));
  const report = { type, date, generatedAt: new Date().toISOString(), source: "Eastmoney free market data + Yahoo Finance kline", ratingPolicy: "尾盘报告和日报使用同一热度评分；周报只汇总16:00日报，不把14:55尾盘报告重复计入周排行。", totalCandidates: market.length, stocks, previousDayStocksTodayChange: await previousStats(db, type, date), status: "ok" };
  if (type === "late") db.lateReports[date] = report; else db.dailyReports[date] = report;
  db.jobLogs.unshift({ jobName: `${type}-report`, startedAt: report.generatedAt, finishedAt: new Date().toISOString(), status: "ok", errorMessage: null });
  db.jobLogs = db.jobLogs.slice(0, 60);
  await saveDb(db);
  await exportStatic(db);
  return report;
}

async function generateWeekly(date = todayCN()) {
  const db = await readDb();
  const { start, end } = rangeForWeek(date);
  const reports = Object.values(db.dailyReports || {}).filter(r => r.date >= start && r.date <= end && r.status === "ok");
  const map = new Map();
  for (const r of reports) for (const s of r.stocks || []) {
    const item = map.get(s.symbol) || { symbol: s.symbol, name: s.name, weeklyHeatScore: 0, appearances: 0, avgMomentumScore: 0 };
    item.weeklyHeatScore += s.heatScore || 0;
    item.avgMomentumScore += s.momentumScore || 0;
    item.appearances += 1;
    map.set(s.symbol, item);
  }
  const stocks = [...map.values()].map(s => ({ ...s, weeklyHeatScore: round(s.weeklyHeatScore), avgMomentumScore: round(s.avgMomentumScore / s.appearances), weeklySummary: `本周入选日报${s.appearances}次，周热度按16:00日报累计，不含尾盘报告重复计数。` })).sort((a, b) => b.weeklyHeatScore - a.weeklyHeatScore).slice(0, 10).map((s, i) => ({ rank: i + 1, ...s }));
  const week = currentWeek(date);
  const report = { type: "weekly", week, rangeStart: start, rangeEnd: end, generatedAt: new Date().toISOString(), ratingPolicy: "周报只汇总16:00日报；14:55尾盘报告用于盘中观察和昨日股票统计，不参与周评级重复计分。", stocks, status: "ok" };
  db.weeklyReports[week] = report;
  db.jobLogs.unshift({ jobName: "weekly-report", startedAt: report.generatedAt, finishedAt: new Date().toISOString(), status: "ok", errorMessage: null });
  db.jobLogs = db.jobLogs.slice(0, 60);
  await saveDb(db);
  await exportStatic(db);
  return report;
}

async function exportStatic(db = null) {
  db ||= await readDb();
  await mkdir(join(OUT_DIR, "daily"), { recursive: true });
  await mkdir(join(OUT_DIR, "late"), { recursive: true });
  await mkdir(join(OUT_DIR, "weekly"), { recursive: true });
  const dailyDates = Object.keys(db.dailyReports || {}).sort();
  const lateDates = Object.keys(db.lateReports || {}).sort();
  const weeks = Object.keys(db.weeklyReports || {}).sort();
  for (const d of dailyDates) await writeFile(join(OUT_DIR, "daily", `${d}.json`), JSON.stringify(db.dailyReports[d], null, 2));
  for (const d of lateDates) await writeFile(join(OUT_DIR, "late", `${d}.json`), JSON.stringify(db.lateReports[d], null, 2));
  for (const w of weeks) await writeFile(join(OUT_DIR, "weekly", `${w}.json`), JSON.stringify(db.weeklyReports[w], null, 2));
  const recent = { generatedAt: new Date().toISOString(), latestDailyDate: dailyDates.at(-1) || null, latestLateDate: lateDates.at(-1) || null, latestWeek: weeks.at(-1) || null, dailyReports: dailyDates.slice(-7).reverse(), lateReports: lateDates.slice(-7).reverse(), weeklyReports: weeks.slice(-8).reverse(), jobLogs: (db.jobLogs || []).slice(0, 20) };
  await writeFile(join(OUT_DIR, "recent.json"), JSON.stringify(recent, null, 2));
  if (weeks.at(-1)) await writeFile(join(OUT_DIR, "weekly-latest.json"), JSON.stringify(db.weeklyReports[weeks.at(-1)], null, 2));
}

async function main() {
  const [cmd, argDate] = process.argv.slice(2);
  if (cmd === "late") console.log(JSON.stringify(await withJobRetry(() => generateMarketReport("late", argDate || todayCN())), null, 2));
  else if (cmd === "daily") console.log(JSON.stringify(await withJobRetry(() => generateMarketReport("daily", argDate || todayCN())), null, 2));
  else if (cmd === "weekly") console.log(JSON.stringify(await withJobRetry(() => generateWeekly(argDate || todayCN())), null, 2));
  else if (cmd === "export-static") { await exportStatic(); console.log("exported static report data"); }
  else if (cmd === "check") console.log("ok");
  else throw new Error("Usage: node src/cli.js late|daily|weekly|export-static|check [YYYY-MM-DD]");
}

main().catch(err => { console.error(err); process.exit(1); });
