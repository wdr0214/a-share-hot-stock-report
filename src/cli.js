import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DATA_FILE = "data/reports.json";
const OUT_DIR = "outputs/data/reports";
const EASTMONEY_FIELDS = "f12,f14,f2,f3,f6,f7,f8,f10,f62,f66,f69,f72,f75";

const command = process.argv[2] || "check";
const argDate = process.argv[3];

if (command === "daily") console.log(JSON.stringify(await generateDaily(argDate || today()), null, 2));
else if (command === "weekly") console.log(JSON.stringify(await generateWeekly(argDate || today()), null, 2));
else if (command === "export-static") console.log(JSON.stringify(await exportStatic(), null, 2));
else if (command === "check") console.log(JSON.stringify({ ok: true, runtime: "github-pages-actions" }, null, 2));
else throw new Error(`Unknown command: ${command}`);

async function generateDaily(date) {
  assertDailyAllowed(date);
  const db = await readDb();
  const candidates = await fetchHotStocks();
  const enriched = [];
  for (const stock of candidates) {
    let kline = [];
    let dataStatus = "ok";
    let dataError = "";
    try { kline = await fetchKline(stock.symbol); }
    catch (error) { dataStatus = "kline_failed"; dataError = error.message; }
    const heatScore = scoreStock(stock, kline);
    const summary = summarize(stock, kline);
    enriched.push({
      rank: 0,
      symbol: stock.symbol,
      name: stock.name,
      heatScore,
      activityScore: Math.round(heatScore * 0.7 + stock.turnoverRate * 5 + Math.log10(Math.max(stock.amount, 1)) * 3),
      momentumScore: momentumScore(stock, kline),
      changePct: stock.changePct,
      turnoverRate: stock.turnoverRate,
      amount: stock.amount,
      volumeRatio: stock.volumeRatio,
      amplitude: stock.amplitude,
      mainNetInflow: stock.mainNetInflow,
      superLargeOrderNetAmount: stock.superLargeOrderNetAmount,
      superLargeOrderNetRatio: stock.superLargeOrderNetRatio,
      largeOrderNetAmount: stock.largeOrderNetAmount,
      largeOrderNetRatio: stock.largeOrderNetRatio,
      bigOrderNetAmount: stock.bigOrderNetAmount,
      keyPoints: summary.keyPoints,
      positiveFactors: summary.positiveFactors,
      kline,
      dataStatus,
      dataError
    });
  }
  const stocks = enriched.filter((stock) => stock.changePct >= 0)
    .sort((a, b) => b.heatScore - a.heatScore)
    .slice(0, 5)
    .map((stock, index) => ({ ...stock, rank: index + 1 }));
  const report = {
    date,
    generatedAt: new Date().toISOString(),
    source: "github-actions-free-eastmoney-yahoo",
    status: stocks.length === 5 ? "ok" : "partial",
    notice: "基于真实行情数据生成；免费源不保证稳定性；不构成投资建议。",
    stocks,
    previousDayStocksTodayChange: await previousDayChange(db, date)
  };
  db.dailyReports[date] = report;
  db.jobLogs.push({ jobName: "daily-report", startedAt: report.generatedAt, finishedAt: new Date().toISOString(), status: "success", errorMessage: "", reportKey: date });
  db.jobLogs = db.jobLogs.slice(-200);
  await writeDb(db);
  await exportStatic(db);
  return report;
}

async function generateWeekly(date) {
  const db = await readDb();
  const dates = Array.from({ length: 7 }, (_, index) => addDays(date, -index));
  const reports = dates.map((day) => db.dailyReports[day]).filter(Boolean);
  const map = new Map();
  for (const report of reports) {
    for (const stock of report.stocks || []) {
      const item = map.get(stock.symbol) || { symbol: stock.symbol, name: stock.name, weeklyHeatScore: 0, appearances: 0, momentumTotal: 0, factors: new Map() };
      item.weeklyHeatScore += stock.heatScore || 0;
      item.appearances += 1;
      item.momentumTotal += stock.momentumScore || 0;
      for (const factor of stock.positiveFactors || []) item.factors.set(factor, (item.factors.get(factor) || 0) + 1);
      map.set(stock.symbol, item);
    }
  }
  const stocks = [...map.values()].map((item) => {
    const topFactors = [...item.factors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([factor]) => factor);
    return { rank: 0, symbol: item.symbol, name: item.name, weeklyHeatScore: Math.round(item.weeklyHeatScore + item.appearances * 20), appearances: item.appearances, avgMomentumScore: Math.round(item.momentumTotal / item.appearances), weeklySummary: `本周高频行情特征集中在 ${topFactors.join("、") || "成交活跃"}，累计入选 ${item.appearances} 天。` };
  }).sort((a, b) => b.weeklyHeatScore - a.weeklyHeatScore).map((item, index) => ({ ...item, rank: index + 1 }));
  const report = { week: weekKey(date), rangeStart: addDays(date, -6), rangeEnd: date, generatedAt: new Date().toISOString(), source: "github-actions-daily-reports", status: reports.length ? "ok" : "empty", stocks };
  db.weeklyReports[report.week] = report;
  db.jobLogs.push({ jobName: "weekly-report", startedAt: report.generatedAt, finishedAt: new Date().toISOString(), status: "success", errorMessage: "", reportKey: report.week });
  db.jobLogs = db.jobLogs.slice(-200);
  await writeDb(db);
  await exportStatic(db);
  return report;
}

async function exportStatic(existingDb) {
  const db = existingDb || await readDb();
  await mkdir(join(OUT_DIR, "daily"), { recursive: true });
  const recent = Object.values(db.dailyReports).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7);
  await writeJson(join(OUT_DIR, "recent.json"), { reports: recent });
  await writeJson(join(OUT_DIR, "logs.json"), { logs: db.jobLogs.slice(-30).reverse() });
  for (const report of recent) await writeJson(join(OUT_DIR, "daily", `${report.date}.json`), report);
  if (recent[0]) await writeJson(join(OUT_DIR, "daily-latest.json"), recent[0]);
  const latestWeek = Object.values(db.weeklyReports).sort((a, b) => b.week.localeCompare(a.week))[0];
  if (latestWeek) await writeJson(join(OUT_DIR, "weekly-latest.json"), latestWeek);
  return { recentDailyCount: recent.length, latestDailyDate: recent[0]?.date || null, hasWeekly: Boolean(latestWeek) };
}

async function fetchHotStocks() {
  const url = new URL("https://push2.eastmoney.com/api/qt/clist/get");
  url.searchParams.set("pn", "1");
  url.searchParams.set("pz", "80");
  url.searchParams.set("po", "1");
  url.searchParams.set("np", "1");
  url.searchParams.set("fltt", "2");
  url.searchParams.set("invt", "2");
  url.searchParams.set("fid", "f62");
  url.searchParams.set("fs", "m:1+t:2,m:0+t:6,m:0+t:80,m:0+t:81");
  url.searchParams.set("fields", EASTMONEY_FIELDS);
  const items = (await fetchJson(url))?.data?.diff;
  if (!Array.isArray(items)) throw new Error("Eastmoney response missing data.diff");
  return items.map(normalizeEastmoney).filter(Boolean);
}

async function fetchQuotes(symbols) {
  const url = new URL("https://push2.eastmoney.com/api/qt/ulist.np/get");
  url.searchParams.set("fltt", "2");
  url.searchParams.set("invt", "2");
  url.searchParams.set("fields", "f12,f14,f3");
  url.searchParams.set("secids", symbols.map(toEastmoneySecid).filter(Boolean).join(","));
  const items = (await fetchJson(url))?.data?.diff;
  if (!Array.isArray(items)) throw new Error("Eastmoney quote response missing data.diff");
  return items.map((item) => ({ symbol: normalizeSymbol(item.f12), name: String(item.f14 || "").trim(), changePct: number(item.f3) })).filter((item) => item.symbol);
}

async function fetchKline(symbol) {
  const yahoo = toYahooSymbol(symbol);
  const payload = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${yahoo}?range=6mo&interval=1d`);
  const result = payload?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  if (!timestamps.length || !quote.open?.length) throw new Error(`No Yahoo kline rows for ${symbol}`);
  return timestamps.map((ts, index) => {
    const open = number(quote.open[index]);
    const high = number(quote.high[index]);
    const low = number(quote.low[index]);
    const close = number(quote.close[index]);
    const volume = number(quote.volume[index]);
    if (!open || !high || !low || !close) return null;
    return { date: new Date(ts * 1000).toISOString().slice(0, 10), open, high, low, close, volume, amount: 0 };
  }).filter(Boolean);
}

async function previousDayChange(db, date) {
  const previousDate = addDays(date, -1);
  const previous = db.dailyReports[previousDate];
  const previousStocks = previous?.stocks || [];
  if (!previousStocks.length) return { previousDate, date, status: "missing_previous_report", items: [] };
  try {
    const quotes = await fetchQuotes(previousStocks.map((stock) => stock.symbol));
    const map = new Map(quotes.map((quote) => [quote.symbol, quote]));
    return { previousDate, date, status: "ok", items: previousStocks.slice(0, 5).map((stock) => ({ symbol: stock.symbol, name: map.get(stock.symbol)?.name || stock.name, changePct: map.get(stock.symbol)?.changePct ?? null })) };
  } catch (error) {
    return { previousDate, date, status: "quote_failed", error: error.message, items: previousStocks.slice(0, 5).map((stock) => ({ symbol: stock.symbol, name: stock.name, changePct: null })) };
  }
}

function normalizeEastmoney(item) {
  const symbol = normalizeSymbol(item.f12);
  if (!symbol) return null;
  const superLargeOrderNetAmount = number(item.f66);
  const largeOrderNetAmount = number(item.f72);
  return { symbol, name: String(item.f14 || symbol).trim(), changePct: number(item.f3), turnoverRate: number(item.f8), amount: number(item.f6), volumeRatio: number(item.f10 || 1), amplitude: number(item.f7), close: number(item.f2), mainNetInflow: number(item.f62), superLargeOrderNetAmount, superLargeOrderNetRatio: number(item.f69), largeOrderNetAmount, largeOrderNetRatio: number(item.f75), bigOrderNetAmount: superLargeOrderNetAmount + largeOrderNetAmount };
}

function scoreStock(stock, kline) {
  const amount = clamp(Math.log10(Math.max(stock.amount, 1)) * 9 - 55, 0, 35);
  const change = clamp(stock.changePct * 2.5, 0, 25);
  const turnover = clamp(stock.turnoverRate * 1.8, 0, 15);
  const volume = clamp((stock.volumeRatio - 1) * 6, 0, 12);
  const amplitude = clamp(stock.amplitude * 0.8, 0, 8);
  const bigOrder = clamp(Math.max(stock.bigOrderNetAmount || 0, 0) / 100000000 * 5 + Math.max(stock.largeOrderNetRatio || 0, 0), 0, 20);
  const trend = trendScore(kline);
  return Math.round(amount + change + turnover + volume + amplitude + bigOrder + trend);
}

function momentumScore(stock, kline) {
  return Math.round(clamp(50 + stock.changePct * 4 + (stock.volumeRatio - 1) * 8 + trendScore(kline), 0, 100));
}

function summarize(stock, kline) {
  const keyPoints = [];
  const positiveFactors = [];
  keyPoints.push(`当日涨跌幅 ${formatPercent(stock.changePct)}，成交额 ${formatAmount(stock.amount)}。`);
  if (stock.bigOrderNetAmount > 0) { keyPoints.push(`大单资金净额为 ${formatAmount(stock.bigOrderNetAmount)}。`); positiveFactors.push("大单净流入"); }
  else if (stock.bigOrderNetAmount < 0) keyPoints.push(`大单资金净额为 ${formatAmount(stock.bigOrderNetAmount)}，资金存在分歧。`);
  if (stock.mainNetInflow > 0) positiveFactors.push("主力资金");
  if (stock.superLargeOrderNetAmount > 0) positiveFactors.push("超大单活跃");
  if (stock.volumeRatio >= 1.5) positiveFactors.push("放量");
  if (stock.turnoverRate >= 5) positiveFactors.push("高换手");
  if (trendScore(kline) >= 10) { keyPoints.push("近半年价格趋势较强。表明中期趋势有改善。"); positiveFactors.push("强趋势"); }
  return { keyPoints, positiveFactors: [...new Set(positiveFactors)].slice(0, 5) };
}

function trendScore(kline) {
  if (!Array.isArray(kline) || kline.length < 20) return 0;
  const last = kline[kline.length - 1].close;
  const prev20 = kline[Math.max(0, kline.length - 20)].close;
  const first = kline[0].close;
  return clamp(((last - prev20) / prev20) * 40 + ((last - first) / first) * 10, 0, 20);
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json,text/plain,*/*", "User-Agent": "Mozilla/5.0 github-pages-stock-report/1.0" } });
  if (!response.ok) throw new Error(`Request failed ${response.status}: ${(await response.text()).slice(0, 160)}`);
  return response.json();
}

async function readDb() {
  try { return JSON.parse(await readFile(DATA_FILE, "utf8")); }
  catch { return { dailyReports: {}, weeklyReports: {}, jobLogs: [] }; }
}
async function writeDb(db) { await mkdir("data", { recursive: true }); await writeFile(DATA_FILE, `${JSON.stringify(db, null, 2)}\n`, "utf8"); }
async function writeJson(path, payload) { await mkdir(join(path, "..").replace(/\\/g, "/"), { recursive: true }); await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8"); }

function today() { return shanghaiParts(new Date()).date; }
function shanghaiParts(input) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(input).reduce((acc, part) => (acc[part.type] = part.value, acc), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}
function assertDailyAllowed(date) {
  const now = shanghaiParts(new Date());
  if (!isWeekday(date)) throw new Error("日报只在交易日生成；周末不会生成当天日报。");
  if (date > now.date) throw new Error("不能生成未来日期的日报。");
  if (date === now.date && now.hour < 16) throw new Error("当天日报将在交易日 16:00 后生成；当前未到自动生成时间。");
}
function isWeekday(date) { const day = new Date(`${date}T00:00:00+08:00`).getUTCDay(); return day >= 1 && day <= 5; }
function addDays(date, days) { const d = new Date(`${date}T00:00:00+08:00`); d.setUTCDate(d.getUTCDate() + days); return shanghaiParts(d).date; }
function weekKey(date) { const d = new Date(`${date}T00:00:00+08:00`); const day = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - day); const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); const week = Math.ceil((((d - start) / 86400000) + 1) / 7); return `${d.getUTCFullYear()}-${String(week).padStart(2, "0")}`; }
function normalizeSymbol(symbol) { const raw = String(symbol || "").trim().toUpperCase().replace(".", ""); if (/^(SH|SZ|BJ)\d{6}$/.test(raw)) return raw; if (/^6\d{5}$/.test(raw)) return `SH${raw}`; if (/^[038]\d{5}$/.test(raw)) return `SZ${raw}`; if (/^[492]\d{5}$/.test(raw)) return `BJ${raw}`; return raw; }
function toYahooSymbol(symbol) { const normalized = normalizeSymbol(symbol); const code = normalized.slice(2); if (normalized.startsWith("SH")) return `${code}.SS`; if (normalized.startsWith("SZ")) return `${code}.SZ`; if (normalized.startsWith("BJ")) return `${code}.BJ`; return normalized; }
function toEastmoneySecid(symbol) { const normalized = normalizeSymbol(symbol); const code = normalized.slice(2); if (normalized.startsWith("SH")) return `1.${code}`; if (normalized.startsWith("SZ") || normalized.startsWith("BJ")) return `0.${code}`; return ""; }
function number(value) { const n = Number(value || 0); return Number.isFinite(n) ? n : 0; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function formatAmount(value) { const n = number(value); if (Math.abs(n) >= 100000000) return `${(n / 100000000).toFixed(1)} 亿`; if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(0)} 万`; return String(Math.round(n)); }
function formatPercent(value) { return `${number(value).toFixed(2)}%`; }
