import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DATA_FILE = "data/reports.json";
const OUT_DIR = "outputs/data/reports";
const REPORT_RETENTION_DAYS = 180;
const REQUEST_RETRIES = 3;
const REQUEST_RETRY_DELAY_MS = 10000;
const EASTMONEY_FIELDS = "f12,f14,f2,f3,f6,f7,f8,f10,f62,f66,f69,f72,f75,f100";
const QUOTE_FIELDS = "f12,f14,f2,f3,f17";

const command = process.argv[2] || "check";
const argDate = process.argv[3];

if (command === "late") console.log(JSON.stringify(await runReportJob("late", argDate || today(), { force: true }), null, 2));
else if (command === "daily") console.log(JSON.stringify(await runReportJob("daily", argDate || today(), { force: true }), null, 2));
else if (command === "weekly") console.log(JSON.stringify(await runWeeklyJob(argDate || today()), null, 2));
else if (command === "catchup") console.log(JSON.stringify(await catchupReports(), null, 2));
else if (command === "export-static") console.log(JSON.stringify(await exportStatic(), null, 2));
else if (command === "check") console.log(JSON.stringify({ ok: true, runtime: "github-pages-actions" }, null, 2));
else throw new Error(`Unknown command: ${command}`);

async function withRetry(label, task, retryDelayMs = REQUEST_RETRY_DELAY_MS) {
  let lastError;
  for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt >= REQUEST_RETRIES) break;
      console.warn(`${label} attempt ${attempt + 1} failed, retrying in ${Math.round(retryDelayMs / 1000)}s: ${error.message}`);
      await sleep(retryDelayMs);
    }
  }
  throw lastError;
}

async function runReportJob(type, date, { force = false } = {}) {
  const db = await readDb();
  const collection = type === "late" ? db.lateReports : db.dailyReports;
  if (!force && collection[date]?.status === "ok") {
    return { skipped: true, reason: "report_already_ok", type, date };
  }
  try {
    return await generateMarketReport(type, date);
  } catch (error) {
    await recordFailureLog(type === "late" ? "late-report" : "daily-report", date, error);
    throw error;
  }
}

async function runWeeklyJob(date) {
  try {
    return await generateWeekly(date);
  } catch (error) {
    await recordFailureLog("weekly-report", weekKey(date), error);
    throw error;
  }
}

async function catchupReports() {
  const now = shanghaiParts(new Date());
  const date = now.date;
  const results = [];
  if (!isWeekday(date)) return { date, results, skipped: "not_trading_weekday" };

  const db = await readDb();
  if (isMarketReportDue("late", now)) {
    const late = db.lateReports[date];
    if (!late || late.status !== "ok") {
      results.push(await catchupOne("late", date));
    } else {
      results.push({ type: "late", skipped: "already_ok" });
    }
  }
  if (isMarketReportDue("daily", now)) {
    const latestDb = await readDb();
    const daily = latestDb.dailyReports[date];
    if (!daily || daily.status !== "ok") {
      results.push(await catchupOne("daily", date));
    } else {
      results.push({ type: "daily", skipped: "already_ok" });
    }
  }
  if (!results.length) results.push({ skipped: "no_report_due_yet" });
  return { date, now, results };
}

async function catchupOne(type, date) {
  try {
    return { type, result: await runReportJob(type, date) };
  } catch (error) {
    return { type, status: "failed", error: error.message };
  }
}

async function generateMarketReport(type, date) {
  assertMarketReportAllowed(type, date);
  const db = await readDb();
  const candidates = await fetchAllMarketStocks();
  const preliminary = candidates
    .filter((stock) => stock.changePct >= 0)
    .map((stock) => ({ ...stock, preliminaryScore: scoreStock(stock, []) }))
    .sort((a, b) => b.preliminaryScore - a.preliminaryScore)
    .slice(0, 30);

  const enriched = [];
  for (const stock of preliminary) {
    let kline = [];
    let dataStatus = "ok";
    let dataError = "";
    try {
      kline = await fetchKline(stock.symbol);
    } catch (error) {
      dataStatus = "kline_failed";
      dataError = error.message;
    }
    const heatScore = scoreStock(stock, kline);
    const summary = summarize(stock, kline);
    enriched.push({
      rank: 0,
      symbol: stock.symbol,
      name: stock.name,
      industry: stock.industry,
      businessConcepts: businessConcepts(stock),
      isLimitUp: isLimitUp(stock),
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

  const stocks = enriched
    .sort((a, b) => b.heatScore - a.heatScore)
    .slice(0, 5)
    .map((stock, index) => ({ ...stock, rank: index + 1 }));

  const previousDayStocksTodayChange = await previousSelectionChange(db, type, date);
  const report = {
    type,
    date,
    generatedAt: new Date().toISOString(),
    source: "github-actions-free-eastmoney-yahoo",
    status: stocks.length === 5 ? "ok" : "partial",
    totalCandidates: candidates.length,
    ratingPolicy: type === "late"
      ? "尾盘报告与日报使用同一套行情热度评分；周报默认汇总收盘后的日报，避免同一交易日重复计数。"
      : "日报使用收盘后行情热度评分；周报默认汇总日报结果。",
    notice: "基于真实行情数据生成；免费源不保证稳定性；不构成投资建议。",
    stocks,
    previousDayStocksTodayChange
  };

  if (type === "late") {
    report.latePortfolio = await updateLatePortfolio(db, report);
    db.lateReports[date] = report;
  } else {
    db.dailyReports[date] = report;
  }
  db.jobLogs.push({
    jobName: type === "late" ? "late-report" : "daily-report",
    startedAt: report.generatedAt,
    finishedAt: new Date().toISOString(),
    status: "success",
    errorMessage: "",
    reportKey: date
  });
  db.jobLogs = db.jobLogs.slice(-200);
  pruneDb(db);
  await writeDb(db);
  await exportStatic(db);
  return report;
}

async function updateLatePortfolio(db, report) {
  const state = db.latePortfolio || { netValue: 1, cash: 1, holdings: [], history: [] };
  let cash = number(state.cash);
  const sellRecords = [];
  if (state.holdings?.length) {
    const quotes = await fetchQuotes(state.holdings.map((holding) => holding.symbol));
    const quoteMap = new Map(quotes.map((quote) => [quote.symbol, quote]));
    for (const holding of state.holdings) {
      const quote = quoteMap.get(holding.symbol);
      const sellPrice = quote?.close || holding.entryPrice;
      const sellValue = number(holding.shares) * sellPrice;
      cash += sellValue;
      sellRecords.push({
        symbol: holding.symbol,
        name: holding.name,
        entryPrice: holding.entryPrice,
        sellPrice,
        returnPct: holding.entryPrice ? ((sellPrice - holding.entryPrice) / holding.entryPrice) * 100 : null
      });
    }
  }

  const currentNetValue = cash;
  const holdings = [];
  const buyRecords = [];
  for (const stock of report.stocks || []) {
    if (stock.isLimitUp) {
      buyRecords.push({ symbol: stock.symbol, name: stock.name, skipped: true, reason: "涨停无法买入" });
      continue;
    }
    const price = number(stock.close || stock.kline?.at(-1)?.close);
    const allocation = currentNetValue * 0.2;
    if (!price || allocation <= 0 || cash < allocation) {
      buyRecords.push({ symbol: stock.symbol, name: stock.name, skipped: true, reason: "价格数据不足或现金不足" });
      continue;
    }
    const shares = allocation / price;
    cash -= allocation;
    holdings.push({ symbol: stock.symbol, name: stock.name, entryPrice: price, shares, allocation, date: report.date });
    buyRecords.push({ symbol: stock.symbol, name: stock.name, skipped: false, buyPrice: price, allocation });
  }

  const snapshot = {
    date: report.date,
    netValue: round(currentNetValue, 4),
    cash: round(cash, 6),
    holdings,
    sold: sellRecords,
    bought: buyRecords
  };
  db.latePortfolio = { netValue: snapshot.netValue, cash, holdings, history: [...(state.history || []), snapshot].slice(-REPORT_RETENTION_DAYS) };
  return snapshot;
}

async function generateWeekly(date) {
  const db = await readDb();
  const dates = Array.from({ length: 7 }, (_, index) => addDays(date, -index));
  const reports = dates.map((day) => db.dailyReports[day]).filter(Boolean);
  const map = new Map();
  for (const report of reports) {
    for (const stock of report.stocks || []) {
      const item = map.get(stock.symbol) || {
        symbol: stock.symbol,
        name: stock.name,
        weeklyHeatScore: 0,
        appearances: 0,
        momentumTotal: 0,
        factors: new Map()
      };
      item.weeklyHeatScore += stock.heatScore || 0;
      item.appearances += 1;
      item.momentumTotal += stock.momentumScore || 0;
      for (const factor of stock.positiveFactors || []) item.factors.set(factor, (item.factors.get(factor) || 0) + 1);
      map.set(stock.symbol, item);
    }
  }
  const stocks = [...map.values()]
    .map((item) => {
      const topFactors = [...item.factors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([factor]) => factor);
      return {
        rank: 0,
        symbol: item.symbol,
        name: item.name,
        weeklyHeatScore: Math.round(item.weeklyHeatScore + item.appearances * 20),
        appearances: item.appearances,
        avgMomentumScore: Math.round(item.momentumTotal / item.appearances),
        weeklySummary: `本周高频行情特征集中在 ${topFactors.join("、") || "成交活跃"}，累计入选 ${item.appearances} 天。`
      };
    })
    .sort((a, b) => b.weeklyHeatScore - a.weeklyHeatScore)
    .map((item, index) => ({ ...item, rank: index + 1 }));

  const report = {
    week: weekKey(date),
    rangeStart: addDays(date, -6),
    rangeEnd: date,
    generatedAt: new Date().toISOString(),
    source: "github-actions-daily-reports",
    status: reports.length ? "ok" : "empty",
    ratingPolicy: "周报汇总最近 7 天日报结果，不重复计入尾盘报告。",
    stocks
  };
  db.weeklyReports[report.week] = report;
  db.jobLogs.push({ jobName: "weekly-report", startedAt: report.generatedAt, finishedAt: new Date().toISOString(), status: "success", errorMessage: "", reportKey: report.week });
  db.jobLogs = db.jobLogs.slice(-200);
  pruneDb(db);
  await writeDb(db);
  await exportStatic(db);
  return report;
}

async function exportStatic(existingDb) {
  const db = existingDb || await readDb();
  await mkdir(join(OUT_DIR, "daily"), { recursive: true });
  await mkdir(join(OUT_DIR, "late"), { recursive: true });

  pruneDb(db);
  await cleanReportDir(join(OUT_DIR, "daily"));
  await cleanReportDir(join(OUT_DIR, "late"));

  const recentDaily = Object.values(db.dailyReports).sort((a, b) => b.date.localeCompare(a.date)).slice(0, REPORT_RETENTION_DAYS);
  const recentLate = Object.values(db.lateReports).sort((a, b) => b.date.localeCompare(a.date)).slice(0, REPORT_RETENTION_DAYS);
  const portfolioHistory = db.latePortfolio?.history || [];
  await writeJson(join(OUT_DIR, "recent.json"), { reports: recentDaily.map(reportIndexItem), lateReports: recentLate.map(reportIndexItem) });
  await writeJson(join(OUT_DIR, "logs.json"), { logs: db.jobLogs.slice(-30).reverse() });
  for (const report of recentDaily) await writeJson(join(OUT_DIR, "daily", `${report.date}.json`), report);
  for (const report of recentLate) await writeJson(join(OUT_DIR, "late", `${report.date}.json`), withPortfolioHistory(report, portfolioHistory));
  if (recentDaily[0]) await writeJson(join(OUT_DIR, "daily-latest.json"), recentDaily[0]);
  if (recentLate[0]) await writeJson(join(OUT_DIR, "late-latest.json"), withPortfolioHistory(recentLate[0], portfolioHistory));
  const latestWeek = Object.values(db.weeklyReports).sort((a, b) => b.week.localeCompare(a.week))[0];
  if (latestWeek) await writeJson(join(OUT_DIR, "weekly-latest.json"), latestWeek);
  return {
    recentDailyCount: recentDaily.length,
    recentLateCount: recentLate.length,
    latestDailyDate: recentDaily[0]?.date || null,
    latestLateDate: recentLate[0]?.date || null,
    hasWeekly: Boolean(latestWeek)
  };
}

function withPortfolioHistory(report, history) {
  const cutoff = report?.date || "";
  const portfolioHistory = (history || [])
    .filter((item) => !cutoff || String(item.date || "").localeCompare(cutoff) <= 0)
    .map((item) => ({
      date: item.date,
      netValue: item.netValue
    }))
    .filter((item) => item.date && Number.isFinite(Number(item.netValue)));
  return { ...report, portfolioHistory };
}

async function fetchAllMarketStocks() {
  const pageSize = 500;
  const first = await fetchMarketPage(1, pageSize);
  const items = [...first.items];
  const total = Number(first.total || items.length);
  const pages = Math.ceil(total / pageSize);
  for (let page = 2; page <= pages; page += 1) {
    const next = await fetchMarketPage(page, pageSize);
    items.push(...next.items);
    await sleep(180);
  }
  const bySymbol = new Map();
  for (const item of items.map(normalizeEastmoney).filter(Boolean)) bySymbol.set(item.symbol, item);
  return [...bySymbol.values()];
}

async function fetchMarketPage(page, pageSize) {
  const url = new URL("https://push2.eastmoney.com/api/qt/clist/get");
  url.searchParams.set("pn", String(page));
  url.searchParams.set("pz", String(pageSize));
  url.searchParams.set("po", "1");
  url.searchParams.set("np", "1");
  url.searchParams.set("fltt", "2");
  url.searchParams.set("invt", "2");
  url.searchParams.set("fid", "f62");
  url.searchParams.set("fs", "m:1+t:2,m:0+t:6,m:0+t:80,m:0+t:81");
  url.searchParams.set("fields", EASTMONEY_FIELDS);
  const data = (await fetchJson(url))?.data;
  if (!Array.isArray(data?.diff)) throw new Error("Eastmoney response missing data.diff");
  return { total: data.total, items: data.diff };
}

async function fetchQuotes(symbols) {
  const secids = symbols.map(toEastmoneySecid).filter(Boolean);
  const all = [];
  for (let i = 0; i < secids.length; i += 80) {
    const url = new URL("https://push2.eastmoney.com/api/qt/ulist.np/get");
    url.searchParams.set("fltt", "2");
    url.searchParams.set("invt", "2");
    url.searchParams.set("fields", QUOTE_FIELDS);
    url.searchParams.set("secids", secids.slice(i, i + 80).join(","));
    const items = (await fetchJson(url))?.data?.diff;
    if (!Array.isArray(items)) throw new Error("Eastmoney quote response missing data.diff");
    all.push(...items);
  }
  return all.map((item) => {
    const close = number(item.f2);
    const open = number(item.f17);
    return {
      symbol: normalizeSymbol(item.f12),
      name: String(item.f14 || "").trim(),
      changePct: number(item.f3),
      open,
      close,
      closeVsOpenPct: open ? ((close - open) / open) * 100 : null
    };
  }).filter((item) => item.symbol);
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

async function previousSelectionChange(db, type, date) {
  const previousDate = previousWeekday(date);
  const preferred = type === "late" ? db.lateReports[previousDate] : db.dailyReports[previousDate];
  const previous = preferred || db.dailyReports[previousDate] || db.lateReports[previousDate];
  const previousStocks = previous?.stocks || [];
  if (!previousStocks.length) return { previousDate, date, status: "missing_previous_report", items: [] };
  try {
    const quotes = await fetchQuotes(previousStocks.map((stock) => stock.symbol));
    const map = new Map(quotes.map((quote) => [quote.symbol, quote]));
    return {
      previousDate,
      date,
      sourceReportType: previous.type || "daily",
      status: "ok",
      items: previousStocks.slice(0, 5).map((stock) => {
        const quote = map.get(stock.symbol);
        return {
          symbol: stock.symbol,
          name: quote?.name || stock.name,
          yesterdayChangePct: stock.changePct,
          wasLimitUpYesterday: Boolean(stock.isLimitUp ?? isLimitUp(stock)),
          todayChangePct: quote?.changePct ?? null,
          todayOpen: quote?.open ?? null,
          todayClose: quote?.close ?? null,
          todayCloseVsOpenPct: quote?.closeVsOpenPct ?? null
        };
      })
    };
  } catch (error) {
    return {
      previousDate,
      date,
      sourceReportType: previous.type || "daily",
      status: "quote_failed",
      error: error.message,
      items: previousStocks.slice(0, 5).map((stock) => ({
        symbol: stock.symbol,
        name: stock.name,
        yesterdayChangePct: stock.changePct,
        wasLimitUpYesterday: Boolean(stock.isLimitUp ?? isLimitUp(stock)),
        todayChangePct: null,
        todayOpen: null,
        todayClose: null,
        todayCloseVsOpenPct: null
      }))
    };
  }
}

function normalizeEastmoney(item) {
  const symbol = normalizeSymbol(item.f12);
  if (!symbol) return null;
  const superLargeOrderNetAmount = number(item.f66);
  const largeOrderNetAmount = number(item.f72);
  return {
    symbol,
    name: String(item.f14 || symbol).trim(),
    industry: String(item.f100 || "").trim(),
    changePct: number(item.f3),
    turnoverRate: number(item.f8),
    amount: number(item.f6),
    volumeRatio: number(item.f10 || 1),
    amplitude: number(item.f7),
    close: number(item.f2),
    mainNetInflow: number(item.f62),
    superLargeOrderNetAmount,
    superLargeOrderNetRatio: number(item.f69),
    largeOrderNetAmount,
    largeOrderNetRatio: number(item.f75),
    bigOrderNetAmount: superLargeOrderNetAmount + largeOrderNetAmount
  };
}

function businessConcepts(stock) {
  const concepts = [];
  const name = String(stock.name || "");
  const known = [
    [/远东股份/, ["电线电缆", "智能缆网"]],
    [/铜冠铜箔/, ["电子铜箔", "锂电材料"]],
    [/诺德股份/, ["铜箔材料", "新能源材料"]],
    [/盛屯矿业/, ["有色金属", "矿产资源"]],
    [/宗申动力/, ["通用动力", "摩托车动力"]]
  ];
  for (const [pattern, labels] of known) {
    if (pattern.test(name)) concepts.push(...labels);
  }
  if (stock.industry) concepts.push(stock.industry);
  const text = `${stock.name}${stock.industry}`;
  const rules = [
    [/银行|证券|保险|金融|信托/, "金融服务"],
    [/半导体|芯片|集成电路|微电子/, "半导体"],
    [/软件|信息|数据|云|网络|科技/, "软件与信息服务"],
    [/汽车|车|汽配|电池|锂|新能源/, "汽车与新能源"],
    [/医药|生物|医疗|药|制药/, "医药生物"],
    [/电力|能源|光伏|风电|水电|煤|石油|燃气/, "能源电力"],
    [/地产|建筑|建材|水泥|工程/, "地产建筑"],
    [/消费|食品|饮料|酒|零售|家电|服饰/, "消费"],
    [/军工|航天|航空|船舶|兵器/, "军工装备"],
    [/钢铁|有色|金属|化工|材料/, "周期材料"],
    [/通信|电子|传媒|游戏/, "TMT"]
  ];
  for (const [pattern, label] of rules) if (pattern.test(text)) concepts.push(label);
  return [...new Set(concepts)].slice(0, 2);
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
  if (stock.bigOrderNetAmount > 0) {
    keyPoints.push(`大单资金净额为 ${formatAmount(stock.bigOrderNetAmount)}。`);
    positiveFactors.push("大单净流入");
  } else if (stock.bigOrderNetAmount < 0) {
    keyPoints.push(`大单资金净额为 ${formatAmount(stock.bigOrderNetAmount)}，资金存在分歧。`);
  }
  if (stock.mainNetInflow > 0) positiveFactors.push("主力资金");
  if (stock.superLargeOrderNetAmount > 0) positiveFactors.push("超大单活跃");
  if (stock.volumeRatio >= 1.5) positiveFactors.push("放量");
  if (stock.turnoverRate >= 5) positiveFactors.push("高换手");
  if (trendScore(kline) >= 10) {
    keyPoints.push("近半年价格趋势较强，表明中期趋势有改善。");
    positiveFactors.push("强趋势");
  }
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
  let lastError;
  for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json,text/plain,*/*",
          Referer: "https://quote.eastmoney.com/",
          "User-Agent": "Mozilla/5.0 github-pages-stock-report/1.0"
        }
      });
      if (!response.ok) throw new Error(`Request failed ${response.status}: ${(await response.text()).slice(0, 160)}`);
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < REQUEST_RETRIES) {
        console.warn(`external request failed, retrying in ${REQUEST_RETRY_DELAY_MS / 1000}s: ${error.message}`);
        await sleep(REQUEST_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

async function recordFailureLog(jobName, reportKey, error) {
  const db = await readDb();
  const now = new Date().toISOString();
  db.jobLogs.push({
    jobName,
    startedAt: now,
    finishedAt: now,
    status: "failed",
    errorMessage: error.message,
    reportKey,
    attempts: REQUEST_RETRIES + 1,
    nextRetryHint: "scheduled catchup or one-hour rerun"
  });
  db.jobLogs = db.jobLogs.slice(-200);
  pruneDb(db);
  await writeDb(db);
  await exportStatic(db);
}

async function readDb() {
  try {
    const db = JSON.parse(await readFile(DATA_FILE, "utf8"));
    return {
      dailyReports: db.dailyReports || {},
      lateReports: db.lateReports || {},
      weeklyReports: db.weeklyReports || {},
      latePortfolio: db.latePortfolio || null,
      jobLogs: db.jobLogs || []
    };
  } catch {
    return { dailyReports: {}, lateReports: {}, weeklyReports: {}, latePortfolio: null, jobLogs: [] };
  }
}

async function writeDb(db) {
  pruneDb(db);
  await mkdir("data", { recursive: true });
  await writeFile(DATA_FILE, `${JSON.stringify(db, null, 2)}\n`, "utf8");
}

async function writeJson(path, payload) {
  await mkdir(join(path, "..").replace(/\\/g, "/"), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function cleanReportDir(dir) {
  try {
    const files = await readdir(dir);
    await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => rm(join(dir, file), { force: true })));
  } catch {
    await mkdir(dir, { recursive: true });
  }
}

function pruneDb(db) {
  db.dailyReports = pruneReportMap(db.dailyReports || {}, "date", REPORT_RETENTION_DAYS);
  db.lateReports = pruneReportMap(db.lateReports || {}, "date", REPORT_RETENTION_DAYS);
  db.weeklyReports = pruneReportMap(db.weeklyReports || {}, "rangeEnd", REPORT_RETENTION_DAYS);
  db.jobLogs = (db.jobLogs || []).slice(-200);
  if (db.latePortfolio?.history) {
    db.latePortfolio.history = db.latePortfolio.history.slice(-REPORT_RETENTION_DAYS);
  }
}

function pruneReportMap(map, dateField, limit) {
  return Object.fromEntries(
    Object.entries(map)
      .sort(([, a], [, b]) => String(b?.[dateField] || b?.date || "").localeCompare(String(a?.[dateField] || a?.date || "")))
      .slice(0, limit)
  );
}

function reportIndexItem(report) {
  return {
    type: report.type,
    date: report.date,
    week: report.week,
    generatedAt: report.generatedAt,
    status: report.status,
    totalCandidates: report.totalCandidates,
    stocks: (report.stocks || []).slice(0, 5).map((stock) => ({
      rank: stock.rank,
      symbol: stock.symbol,
      name: stock.name,
      heatScore: stock.heatScore,
      weeklyHeatScore: stock.weeklyHeatScore
    }))
  };
}

function isMarketReportDue(type, now = shanghaiParts(new Date())) {
  const hour = type === "late" ? 14 : 16;
  const minute = type === "late" ? 50 : 0;
  return now.hour > hour || (now.hour === hour && now.minute >= minute);
}

function today() {
  return shanghaiParts(new Date()).date;
}

function shanghaiParts(input) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(input).reduce((acc, part) => (acc[part.type] = part.value, acc), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}

function assertMarketReportAllowed(type, date) {
  const now = shanghaiParts(new Date());
  const hour = type === "late" ? 14 : 16;
  const minute = type === "late" ? 50 : 0;
  if (!isWeekday(date)) throw new Error("报告只在交易日生成；周末不生成当天报告。");
  if (date > now.date) throw new Error("不能生成未来日期的报告。");
  if (date === now.date && (now.hour < hour || (now.hour === hour && now.minute < minute))) {
    throw new Error(`${type === "late" ? "尾盘报告" : "日报"}将在交易日 ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} 后生成；当前未到自动生成时间。`);
  }
}

function previousWeekday(date) {
  let d = addDays(date, -1);
  while (!isWeekday(d)) d = addDays(d, -1);
  return d;
}

function isWeekday(date) {
  const day = new Date(`${date}T12:00:00+08:00`).getUTCDay();
  return day >= 1 && day <= 5;
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return shanghaiParts(d).date;
}

function weekKey(date) {
  const d = new Date(`${date}T12:00:00+08:00`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - start) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-${String(week).padStart(2, "0")}`;
}

function isLimitUp(stock) {
  const threshold = limitUpThreshold(stock);
  return Number(stock.changePct) >= threshold - 0.15;
}

function limitUpThreshold(stock) {
  const name = String(stock.name || "").toUpperCase();
  const symbol = normalizeSymbol(stock.symbol);
  if (name.includes("ST")) return 5;
  if (symbol.startsWith("BJ")) return 30;
  if (/^(SZ30|SH68|SH69)/.test(symbol)) return 20;
  return 10;
}

function normalizeSymbol(symbol) {
  const raw = String(symbol || "").trim().toUpperCase().replace(".", "");
  if (/^(SH|SZ|BJ)\d{6}$/.test(raw)) return raw;
  if (/^6\d{5}$/.test(raw)) return `SH${raw}`;
  if (/^[038]\d{5}$/.test(raw)) return `SZ${raw}`;
  if (/^[492]\d{5}$/.test(raw)) return `BJ${raw}`;
  return raw;
}

function toYahooSymbol(symbol) {
  const normalized = normalizeSymbol(symbol);
  const code = normalized.slice(2);
  if (normalized.startsWith("SH")) return `${code}.SS`;
  if (normalized.startsWith("SZ")) return `${code}.SZ`;
  if (normalized.startsWith("BJ")) return `${code}.BJ`;
  return normalized;
}

function toEastmoneySecid(symbol) {
  const normalized = normalizeSymbol(symbol);
  const code = normalized.slice(2);
  if (normalized.startsWith("SH")) return `1.${code}`;
  if (normalized.startsWith("SZ") || normalized.startsWith("BJ")) return `0.${code}`;
  return "";
}

function number(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function round(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatAmount(value) {
  const n = number(value);
  if (Math.abs(n) >= 100000000) return `${(n / 100000000).toFixed(1)} 亿`;
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(0)} 万`;
  return String(Math.round(n));
}

function formatPercent(value) {
  return `${number(value).toFixed(2)}%`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
