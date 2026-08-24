import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DATA_FILE = "data/reports.json";
const OUT_DIR = "outputs/data/reports";
const REPORT_RETENTION_DAYS = 180;
const REQUEST_RETRIES = 3;
const REQUEST_RETRY_DELAY_MS = 10000;
const DAILY_SELL_OPEN_RETRIES = 2;
const DAILY_SELL_OPEN_RETRY_DELAY_MS = 120000;
const EASTMONEY_FIELDS = "f12,f14,f2,f3,f6,f7,f8,f10,f62,f66,f69,f72,f75,f100";
const QUOTE_FIELDS = "f12,f14,f2,f3,f15,f16,f17,f18";

const command = process.argv[2] || "check";
const argDate = process.argv[3];

if (command === "late") console.log(JSON.stringify(await runReportJob("late", argDate || today(), { force: true }), null, 2));
else if (command === "daily") console.log(JSON.stringify(await runReportJob("daily", argDate || today(), { force: true }), null, 2));
else if (command === "weekly") console.log(JSON.stringify(await runWeeklyJob(argDate || today()), null, 2));
else if (command === "etf-rotation") console.log(JSON.stringify(await runEtfRotationJob(argDate || today()), null, 2));
else if (command === "news-midday") console.log(JSON.stringify(await runNewsJob("midday", argDate || today()), null, 2));
else if (command === "news-close") console.log(JSON.stringify(await runNewsJob("close", argDate || today()), null, 2));
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

async function runEtfRotationJob(date) {
  const db = await readDb();
  if (db.etfRotationReports?.[date]?.status === "ok") {
    return { skipped: true, reason: "report_already_ok", type: "etf-rotation", date };
  }
  try {
    const { generateEtfRotation } = await import("./etf-rotation.js");
    const { report, portfolio } = await generateEtfRotation({ date, now: new Date(), portfolio: db.etfRotationPortfolio });
    db.etfRotationReports ||= {};
    db.etfRotationReports[date] = report;
    db.etfRotationPortfolio = portfolio;
    const now = new Date().toISOString();
    db.jobLogs.push({ jobName: "etf-rotation", startedAt: now, finishedAt: now, status: "ok", errorMessage: "", reportKey: date, attempts: 1 });
    db.jobLogs = db.jobLogs.slice(-200);
    await writeDb(db);
    await exportStatic(db);
    return report;
  } catch (error) {
    await recordFailureLog("etf-rotation", date, error);
    throw error;
  }
}

async function runNewsJob(session, date) {
  try {
    return await generateNewsReport(session, date);
  } catch (error) {
    await recordFailureLog(`news-${session}`, `${date}-${session}`, error);
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
    report.dailyPortfolio = await updateDailyPortfolio(db, report);
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

async function updateDailyPortfolio(db, report) {
  const state = db.dailyPortfolio || { netValue: 1, cash: 1, holdings: [], history: [] };
  const expectedStateDate = latestDailyReportDateBefore(db, report.date);
  const latestStateDate = latestPortfolioStateDate(state);
  if (latestStateDate && latestStateDate !== expectedStateDate) {
    throw new Error(`Missing daily portfolio state for ${expectedStateDate}; latest state is ${latestStateDate}`);
  }
  let cash = number(state.cash);
  const sellRecords = [];
  if (state.holdings?.length) {
    const quotes = await fetchQuotes(state.holdings.map((holding) => holding.symbol));
    const quoteMap = new Map(quotes.map((quote) => [quote.symbol, quote]));
    for (const holding of state.holdings) {
      const quote = quoteMap.get(holding.symbol);
      const sellMarket = await dailySellMarketWithRetry(db, report.date, holding.symbol, quote);
      const sellPrice = sellMarket.open;
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

  const previousDate = previousWeekday(report.date);
  const previousReport = db.dailyReports?.[previousDate];
  const previousStocks = previousReport?.stocks || [];
  const currentNetValue = cash;
  const holdings = [];
  const buyRecords = [];
  if (!previousStocks.length) {
    buyRecords.push({ skipped: true, reason: "missing_previous_daily_report", previousDate });
  } else {
    const quotes = await fetchQuotes(previousStocks.map((stock) => stock.symbol));
    const quoteMap = new Map(quotes.map((quote) => [quote.symbol, quote]));
    for (const stock of previousStocks.slice(0, 5)) {
      const quote = quoteMap.get(stock.symbol);
      const buyDecision = dailyBuyPrice(stock, quote);
      if (!buyDecision.price) {
        buyRecords.push({
          symbol: stock.symbol,
          name: stock.name,
          skipped: true,
          reason: buyDecision.reason,
          open: quote?.open ?? null,
          low: quote?.low ?? null,
          limitUpPrice: buyDecision.limitUpPrice ?? null
        });
        continue;
      }
      const allocation = currentNetValue * 0.2;
      if (allocation <= 0 || cash < allocation) {
        buyRecords.push({ symbol: stock.symbol, name: stock.name, skipped: true, reason: "cash_or_allocation_insufficient" });
        continue;
      }
      const shares = allocation / buyDecision.price;
      cash -= allocation;
      holdings.push({
        symbol: stock.symbol,
        name: stock.name,
        entryPrice: buyDecision.price,
        shares,
        allocation,
        date: report.date,
        sourceReportDate: previousDate
      });
      buyRecords.push({
        symbol: stock.symbol,
        name: stock.name,
        skipped: false,
        buyPrice: buyDecision.price,
        allocation,
        open: quote?.open ?? null,
        low: quote?.low ?? null,
        limitUpPrice: buyDecision.limitUpPrice ?? null,
        buyReason: buyDecision.reason
      });
    }
  }

  const snapshot = {
    date: report.date,
    previousDate,
    netValue: round(currentNetValue, 4),
    cash: round(cash, 6),
    holdings,
    sold: sellRecords,
    bought: buyRecords
  };
  db.dailyPortfolio = { netValue: snapshot.netValue, cash, holdings, history: [...(state.history || []), snapshot].slice(-REPORT_RETENTION_DAYS) };
  return snapshot;
}

function dailyBuyPrice(stock, quote) {
  const open = number(quote?.open);
  if (!open) return { price: null, reason: "open_price_missing" };
  const threshold = limitUpThreshold(stock);
  const previousClose = number(quote?.previousClose || stock.kline?.at(-1)?.close);
  const limitUpPrice = previousClose ? round(previousClose * (1 + threshold / 100), 2) : null;
  if (limitUpPrice && open >= limitUpPrice - 0.01) {
    const low = number(quote?.low);
    if (low && low < limitUpPrice - 0.01) return { price: limitUpPrice, reason: "limit_up_open_but_tradable_low", limitUpPrice };
    return { price: null, reason: "limit_up_open_untradable", limitUpPrice };
  }
  return { price: open, reason: "open_price", limitUpPrice };
}

async function dailySellMarketWithRetry(db, date, symbol, initialMarket = null) {
  if (initialMarket?.open) return initialMarket;
  let sellMarket = null;
  const retryDelay = date === today() ? DAILY_SELL_OPEN_RETRY_DELAY_MS : 0;
  for (let attempt = 0; attempt <= DAILY_SELL_OPEN_RETRIES; attempt += 1) {
    if (attempt > 0 && retryDelay) {
      console.warn(`Missing daily sell open price for ${symbol} on ${date}, retrying in ${retryDelay / 1000}s (${attempt}/${DAILY_SELL_OPEN_RETRIES})`);
      await sleep(retryDelay);
    }
    sellMarket = await dailySellMarketForHolding(db, date, symbol);
    if (sellMarket?.open) return sellMarket;
  }
  throw new Error(`Missing daily sell open price for ${symbol} on ${date} after ${DAILY_SELL_OPEN_RETRIES} retries`);
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
    stocks,
    dailyPortfolioTrades: buildWeeklyPortfolioTrades(db, dates, "daily"),
    latePortfolioTrades: buildWeeklyPortfolioTrades(db, dates, "late")
  };
  db.weeklyReports[report.week] = report;
  db.jobLogs.push({ jobName: "weekly-report", startedAt: report.generatedAt, finishedAt: new Date().toISOString(), status: "success", errorMessage: "", reportKey: report.week });
  db.jobLogs = db.jobLogs.slice(-200);
  pruneDb(db);
  await writeDb(db);
  await exportStatic(db);
  return report;
}

async function generateNewsReport(session, date) {
  if (!["midday", "close"].includes(session)) throw new Error("unsupported news session");
  const db = await readDb();
  db.newsReports ||= {};
  if (!isWeekday(date)) {
    const skipped = {
      type: "sector-news",
      session,
      date,
      generatedAt: new Date().toISOString(),
      status: "skipped",
      reason: "weekend",
      message: "资讯报告仅在周一至周五更新；本次未覆盖历史报告。"
    };
    db.jobLogs.push({ jobName: `news-${session}`, startedAt: skipped.generatedAt, finishedAt: new Date().toISOString(), status: "skipped", errorMessage: "weekend", reportKey: `${date}-${session}` });
    db.jobLogs = db.jobLogs.slice(-200);
    pruneDb(db);
    await writeDb(db);
    await exportStatic(db);
    return skipped;
  }

  const candidates = await fetchMarketStocksForNews(db, date);
  const existingDay = db.newsReports[date] || {};
  const midday = session === "close" ? existingDay.midday : null;
  const excludedSectorNames = new Set((midday?.sectors || []).map((sector) => sector.name));
  const excludedNewsKeys = new Set((midday?.sectors || []).flatMap((sector) => (sector.news || []).map(newsFingerprint)));
  const sectors = buildHotSectors(candidates, {
    excludeNames: session === "close" ? excludedSectorNames : new Set()
  }).slice(0, 3);

  const enrichedSectors = [];
  for (const sector of sectors) {
    const rawNews = await collectSectorNews(sector, date);
    const news = selectSectorNews(rawNews, {
      excludeKeys: session === "close" ? excludedNewsKeys : new Set()
    }).slice(0, 3);
    const deepseek = await analyzeSectorWithDeepSeek(sector, news, session, date);
    enrichedSectors.push({ ...sector, news, deepseek });
    for (const item of news) excludedNewsKeys.add(newsFingerprint(item));
  }

  const report = {
    type: "sector-news",
    session,
    date,
    generatedAt: new Date().toISOString(),
    source: "free-sources-gdelt-rss-plus-market-sector-heat",
    dataPolicy: "免费源优先 + 结合现有行情行业/概念推导热门板块",
    status: enrichedSectors.length ? "ok" : "partial",
    totalCandidates: candidates.length,
    model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
    sectors: enrichedSectors,
    excludedMidday: session === "close" ? { sectorCount: excludedSectorNames.size, newsCount: excludedNewsKeys.size } : null,
    notice: "新闻只展示标题、摘要、来源、时间和链接；不复刻全文；不构成投资建议。"
  };

  db.newsReports[date] = { ...existingDay, [session]: report };
  db.jobLogs.push({ jobName: `news-${session}`, startedAt: report.generatedAt, finishedAt: new Date().toISOString(), status: "success", errorMessage: "", reportKey: `${date}-${session}` });
  db.jobLogs = db.jobLogs.slice(-200);
  pruneDb(db);
  await writeDb(db);
  await exportStatic(db);
  return report;
}

async function fetchMarketStocksForNews(db, date) {
  try {
    return await fetchAllMarketStocks();
  } catch (error) {
    const sameDayReports = [db.lateReports?.[date], db.dailyReports?.[date]].filter(Boolean);
    const stocks = sameDayReports.flatMap((report) => report.stocks || []);
    if (!stocks.length) throw error;
    const bySymbol = new Map();
    for (const stock of stocks) {
      bySymbol.set(normalizeSymbol(stock.symbol), {
        ...stock,
        symbol: normalizeSymbol(stock.symbol),
        heatScore: stock.heatScore || scoreStock(stock, stock.kline || [])
      });
    }
    return [...bySymbol.values()];
  }
}

function buildWeeklyPortfolioTrades(db, dates, type) {
  const collection = type === "daily" ? db.dailyReports : db.lateReports;
  const portfolioField = type === "daily" ? "dailyPortfolio" : "latePortfolio";
  const orderedDates = [...dates].reverse();
  const groups = [];
  const openBuys = new Map();

  for (const date of orderedDates) {
    const report = collection?.[date];
    const portfolio = report?.[portfolioField];
    if (!report || !portfolio) continue;
    const trades = [];

    for (const sold of portfolio.sold || []) {
      const symbol = normalizeSymbol(sold.symbol);
      const row = openBuys.get(symbol);
      if (row) {
        row.sellDate = date;
        row.sellPrice = number(sold.sellPrice) || null;
        row.profitPct = finiteOrNull(sold.returnPct);
        row.status = "已卖出";
        openBuys.delete(symbol);
      } else {
        trades.push(portfolioTradeRowFromSell(report, sold));
      }
    }

    for (const bought of portfolio.bought || []) {
      const row = portfolioTradeRowFromBuy(report, bought, type);
      trades.push(row);
      if (row.action === "buy" && row.symbol) openBuys.set(row.symbol, row);
    }

    if (trades.length) {
      groups.push({
        date,
        netValue: portfolio.netValue ?? null,
        trades
      });
    }
  }

  return groups;
}

function portfolioTradeRowFromBuy(report, row, type) {
  const skipped = Boolean(row.skipped);
  const symbol = normalizeSymbol(row.symbol);
  const buyPrice = number(row.buyPrice);
  const markPrice = !skipped ? markPriceForReport(report, symbol, type) : null;
  return {
    date: report.date,
    buyDate: report.date,
    sellDate: "",
    action: skipped ? "skipped" : "buy",
    symbol,
    name: row.name || findReportStock(report, symbol)?.name || "",
    buyPrice: buyPrice || null,
    sellPrice: null,
    markPrice: markPrice || null,
    profitPct: buyPrice && markPrice ? ((markPrice - buyPrice) / buyPrice) * 100 : null,
    status: skipped ? "未成交" : "持仓中",
    reason: row.reason || row.buyReason || ""
  };
}

function portfolioTradeRowFromSell(report, row) {
  const symbol = normalizeSymbol(row.symbol);
  return {
    date: report.date,
    buyDate: "",
    sellDate: report.date,
    action: "sell",
    symbol,
    name: row.name || findReportStock(report, symbol)?.name || "",
    buyPrice: number(row.entryPrice) || null,
    sellPrice: number(row.sellPrice) || null,
    markPrice: null,
    profitPct: finiteOrNull(row.returnPct),
    status: "已卖出",
    reason: ""
  };
}

function markPriceForReport(report, symbol, type) {
  const normalized = normalizeSymbol(symbol);
  if (type === "daily") {
    const previousItem = (report.previousDayStocksTodayChange?.items || []).find((item) => normalizeSymbol(item.symbol) === normalized);
    if (previousItem?.todayClose) return number(previousItem.todayClose);
  }
  const stock = findReportStock(report, normalized);
  return number(stock?.close || stock?.kline?.at(-1)?.close);
}

function findReportStock(report, symbol) {
  const normalized = normalizeSymbol(symbol);
  return (report.stocks || []).find((stock) => normalizeSymbol(stock.symbol) === normalized);
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function exportStatic(existingDb) {
  const db = existingDb || await readDb();
  await backfillMissingDailyPortfolios(db);
  await writeDb(db);
  await mkdir(join(OUT_DIR, "daily"), { recursive: true });
  await mkdir(join(OUT_DIR, "late"), { recursive: true });
  await mkdir(join(OUT_DIR, "weekly"), { recursive: true });
  await mkdir(join(OUT_DIR, "news"), { recursive: true });
  await mkdir(join(OUT_DIR, "etf-rotation"), { recursive: true });

  pruneDb(db);
  await cleanReportDir(join(OUT_DIR, "daily"));
  await cleanReportDir(join(OUT_DIR, "late"));
  await cleanReportDir(join(OUT_DIR, "weekly"));
  await cleanReportDir(join(OUT_DIR, "news"));
  await cleanReportDir(join(OUT_DIR, "etf-rotation"));

  const recentDaily = Object.values(db.dailyReports).sort((a, b) => b.date.localeCompare(a.date)).slice(0, REPORT_RETENTION_DAYS);
  const recentLate = Object.values(db.lateReports).sort((a, b) => b.date.localeCompare(a.date)).slice(0, REPORT_RETENTION_DAYS);
  const recentWeekly = Object.values(db.weeklyReports || {}).sort((a, b) => String(b.rangeEnd || b.week).localeCompare(String(a.rangeEnd || a.week))).slice(0, REPORT_RETENTION_DAYS);
  const recentNews = Object.entries(db.newsReports || {})
    .map(([date, report]) => ({ date, midday: report.midday || null, close: report.close || null }))
    .filter((item) => item.midday || item.close)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, REPORT_RETENTION_DAYS);
  const recentEtfRotation = Object.values(db.etfRotationReports || {}).sort((a, b) => b.date.localeCompare(a.date));
  const latePortfolioHistory = db.latePortfolio?.history || [];
  const dailyPortfolioHistory = db.dailyPortfolio?.history || [];
  await writeJson(join(OUT_DIR, "recent.json"), { reports: recentDaily.map(reportIndexItem), lateReports: recentLate.map(reportIndexItem), weeklyReports: recentWeekly.map(weeklyIndexItem), newsReports: recentNews.map(newsIndexItem), etfRotationReports: recentEtfRotation.map(etfRotationIndexItem) });
  await writeJson(join(OUT_DIR, "logs.json"), { logs: db.jobLogs.slice(-30).reverse() });
  for (const report of recentDaily) await writeJson(join(OUT_DIR, "daily", `${report.date}.json`), withPortfolioHistory(report, dailyPortfolioHistory));
  for (const report of recentLate) await writeJson(join(OUT_DIR, "late", `${report.date}.json`), withPortfolioHistory(report, latePortfolioHistory));
  for (const report of recentWeekly) await writeJson(join(OUT_DIR, "weekly", `${report.week}.json`), report);
  for (const report of recentEtfRotation) await writeJson(join(OUT_DIR, "etf-rotation", `${report.date}.json`), { ...report, portfolioHistory: db.etfRotationPortfolio?.history || report.portfolioHistory || [] });
  for (const item of recentNews) {
    if (item.midday) await writeJson(join(OUT_DIR, "news", `${item.date}-midday.json`), item.midday);
    if (item.close) await writeJson(join(OUT_DIR, "news", `${item.date}-close.json`), item.close);
    await writeJson(join(OUT_DIR, "news", `${item.date}.json`), item);
  }
  if (recentDaily[0]) await writeJson(join(OUT_DIR, "daily-latest.json"), withPortfolioHistory(recentDaily[0], dailyPortfolioHistory));
  if (recentLate[0]) await writeJson(join(OUT_DIR, "late-latest.json"), withPortfolioHistory(recentLate[0], latePortfolioHistory));
  const latestWeek = recentWeekly[0];
  if (latestWeek) await writeJson(join(OUT_DIR, "weekly-latest.json"), latestWeek);
  if (recentEtfRotation[0]) await writeJson(join(OUT_DIR, "etf-rotation-latest.json"), { ...recentEtfRotation[0], portfolioHistory: db.etfRotationPortfolio?.history || recentEtfRotation[0].portfolioHistory || [] });
  await writeJson(join(OUT_DIR, "news-index.json"), { reports: recentNews.map(newsIndexItem) });
  if (recentNews[0]) await writeJson(join(OUT_DIR, "news-latest.json"), recentNews[0]);
  return {
    recentDailyCount: recentDaily.length,
    recentLateCount: recentLate.length,
    recentNewsCount: recentNews.length,
    recentEtfRotationCount: recentEtfRotation.length,
    latestDailyDate: recentDaily[0]?.date || null,
    latestLateDate: recentLate[0]?.date || null,
    latestNewsDate: recentNews[0]?.date || null,
    latestEtfRotationDate: recentEtfRotation[0]?.date || null,
    hasWeekly: Boolean(latestWeek)
  };
}

function etfRotationIndexItem(report) {
  return { date: report.date, generatedAt: report.generatedAt, status: report.status, netValue: report.netValue, holding: report.holding || null };
}

function weeklyIndexItem(report) {
  return {
    week: report.week,
    rangeStart: report.rangeStart,
    rangeEnd: report.rangeEnd,
    generatedAt: report.generatedAt,
    status: report.status,
    stocks: (report.stocks || []).slice(0, 5).map((stock) => ({
      rank: stock.rank,
      symbol: stock.symbol,
      name: stock.name,
      appearances: stock.appearances,
      weeklyHeatScore: stock.weeklyHeatScore
    }))
  };
}

async function backfillMissingDailyPortfolios(db) {
  const dates = Object.keys(db.dailyReports || {}).sort();
  if (!dates.length) return;
  const firstMissingIndex = dates.findIndex((date) => {
    const portfolio = db.dailyReports[date]?.dailyPortfolio;
    return !portfolio || portfolio.status === "pricing_pending";
  });
  const firstRebuildIndex = firstMissingIndex < 0 ? dates.length : firstMissingIndex;

  let state = { netValue: 1, cash: 1, holdings: [], history: [] };
  const historyByDate = new Map();

  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    const report = db.dailyReports[date];
    if (!report) continue;
    let snapshot = index < firstRebuildIndex && report.dailyPortfolio ? report.dailyPortfolio : null;
    if (!snapshot) {
      try {
        snapshot = await rebuildDailyPortfolioSnapshot(db, report, state);
      } catch (error) {
        delete report.dailyPortfolio;
        report.dailyPortfolioError = error.message;
        console.warn(`daily portfolio backfill skipped for ${date}: ${error.message}`);
        continue;
      }
    }
    report.dailyPortfolio = snapshot;
    delete report.dailyPortfolioError;
    state = {
      netValue: snapshot.netValue,
      cash: snapshot.cash,
      holdings: snapshot.holdings,
      history: [...(state.history || []).filter((item) => item.date !== date), snapshot]
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
        .slice(-REPORT_RETENTION_DAYS)
    };
    historyByDate.set(date, snapshot);
  }

  db.dailyPortfolio = {
    netValue: state.netValue || 1,
    cash: state.cash ?? state.netValue ?? 1,
    holdings: state.holdings || [],
    history: [...historyByDate.values()]
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-REPORT_RETENTION_DAYS)
  };
}

function latestPortfolioStateDate(state) {
  const history = (state?.history || []).filter((item) => item?.date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return history.at(-1)?.date || null;
}

function latestDailyReportDateBefore(db, date) {
  return Object.keys(db.dailyReports || {}).filter((item) => item < date).sort().at(-1) || null;
}

async function rebuildDailyPortfolioSnapshot(db, report, state) {
  let cash = number(state.cash);
  const sellRecords = [];
  for (const holding of state.holdings || []) {
    const sellMarket = await dailySellMarketWithRetry(db, report.date, holding.symbol);
    const sellPrice = sellMarket.open;
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

  const previous = findPreviousReport(db, "daily", report.date);
  const previousStocks = previous?.stocks || [];
  const currentNetValue = cash;
  const holdings = [];
  const buyRecords = [];
  if (!previousStocks.length) {
    buyRecords.push({ skipped: true, reason: "missing_previous_daily_report", previousDate: previousWeekday(report.date) });
  } else {
    for (const stock of previousStocks.slice(0, 5)) {
      let market = historicalDailyMarketFromReports(db, report.date, stock.symbol);
      if (!market?.low) {
        const klineMarket = await historicalDailyMarketFromKline(stock.symbol, report.date);
        market = market ? { ...klineMarket, ...market, low: market.low || klineMarket?.low || 0, high: market.high || klineMarket?.high || 0 } : klineMarket;
      }
      if (!market?.low) {
        const sinaMarket = await sinaMarketForDate(stock.symbol, report.date);
        market = market ? { ...sinaMarket, ...market, low: market.low || sinaMarket?.low || 0, high: market.high || sinaMarket?.high || 0 } : sinaMarket;
      }
      const buyDecision = dailyBuyPrice(stock, market);
      if (!buyDecision.price) {
        buyRecords.push({
          symbol: stock.symbol,
          name: stock.name,
          skipped: true,
          reason: buyDecision.reason,
          open: market?.open ?? null,
          low: market?.low ?? null,
          limitUpPrice: buyDecision.limitUpPrice ?? null
        });
        continue;
      }
      const allocation = currentNetValue * 0.2;
      if (allocation <= 0 || cash < allocation) {
        buyRecords.push({ symbol: stock.symbol, name: stock.name, skipped: true, reason: "cash_or_allocation_insufficient" });
        continue;
      }
      const shares = allocation / buyDecision.price;
      cash -= allocation;
      holdings.push({
        symbol: stock.symbol,
        name: stock.name,
        entryPrice: buyDecision.price,
        shares,
        allocation,
        date: report.date,
        sourceReportDate: previous.date
      });
      buyRecords.push({
        symbol: stock.symbol,
        name: stock.name,
        skipped: false,
        buyPrice: buyDecision.price,
        allocation,
        open: market?.open ?? null,
        low: market?.low ?? null,
        limitUpPrice: buyDecision.limitUpPrice ?? null,
        buyReason: buyDecision.reason
      });
    }
  }

  return {
    date: report.date,
    previousDate: previous?.date || previousWeekday(report.date),
    netValue: round(currentNetValue, 4),
    cash: round(cash, 6),
    holdings,
    sold: sellRecords,
    bought: buyRecords
  };
}

async function dailySellMarketForHolding(db, date, symbol) {
  const normalized = normalizeSymbol(symbol);
  if (date === today()) {
    try {
      const [quote] = await fetchQuotes([normalized]);
      if (quote?.open) return quote;
    } catch {
      // Fall through to stored report data and historical kline.
    }
  }
  return historicalDailyMarketFromReports(db, date, normalized)
    || await historicalDailyMarketFromKline(normalized, date)
    || await sinaMarketForDate(normalized, date);
}

function historicalOpenFromReports(db, date, symbol) {
  return historicalDailyMarketFromReports(db, date, symbol)?.open || null;
}

function historicalDailyMarketFromReports(db, date, symbol) {
  const normalized = normalizeSymbol(symbol);
  const report = db.dailyReports?.[date];
  const previousItem = (report?.previousDayStocksTodayChange?.items || []).find((item) => normalizeSymbol(item.symbol) === normalized);
  const currentStock = (report?.stocks || []).find((item) => normalizeSymbol(item.symbol) === normalized);
  const klineRow = currentStock?.kline?.find((row) => row.date === date);
  const open = number(previousItem?.todayOpen ?? klineRow?.open);
  if (!open) return null;
  return {
    symbol: normalized,
    name: previousItem?.name || currentStock?.name || normalized,
    open,
    high: number(klineRow?.high),
    low: number(klineRow?.low),
    close: number(previousItem?.todayClose ?? klineRow?.close),
    previousClose: number(klineRow?.previousClose),
    changePct: previousItem?.todayChangePct ?? currentStock?.changePct ?? null
  };
}

async function historicalDailyMarketFromKline(symbol, date) {
  try {
    const rows = await fetchKline(symbol);
    const row = rows.find((item) => item.date === date);
    if (!row) return null;
    return {
      symbol: normalizeSymbol(symbol),
      open: number(row.open),
      high: number(row.high),
      low: number(row.low),
      close: number(row.close),
      previousClose: 0
    };
  } catch {
    return null;
  }
}

async function sinaMarketForDate(symbol, date) {
  try {
    const [quote] = await fetchSinaQuotes([symbol]);
    if (quote?.open && quote.date === date) return quote;
  } catch {
    // Sina is a fallback only; keep normal missing-price handling if it fails.
  }
  return null;
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

function buildHotSectors(candidates, { excludeNames = new Set() } = {}) {
  const map = new Map();
  for (const stock of candidates || []) {
    const labels = sectorLabels(stock);
    const stockScore = scoreStock(stock, []);
    for (const label of labels) {
      if (!label || excludeNames.has(label)) continue;
      const item = map.get(label) || { name: label, heatScore: 0, stockCount: 0, amount: 0, bigOrderNetAmount: 0, stocks: [] };
      item.heatScore += stockScore + Math.max(number(stock.changePct), 0) * 2 + clamp(Math.log10(Math.max(number(stock.amount), 1)) * 4 - 25, 0, 25);
      item.stockCount += 1;
      item.amount += number(stock.amount);
      item.bigOrderNetAmount += number(stock.bigOrderNetAmount);
      item.stocks.push({
        symbol: stock.symbol,
        name: stock.name,
        heatScore: stockScore,
        changePct: stock.changePct,
        amount: stock.amount,
        turnoverRate: stock.turnoverRate,
        bigOrderNetAmount: stock.bigOrderNetAmount
      });
      map.set(label, item);
    }
  }
  return [...map.values()]
    .map((item) => ({
      ...item,
      heatScore: Math.round(item.heatScore),
      amount: round(item.amount, 2),
      bigOrderNetAmount: round(item.bigOrderNetAmount, 2),
      topStocks: item.stocks.sort((a, b) => b.heatScore - a.heatScore).slice(0, 5),
      stocks: undefined
    }))
    .sort((a, b) => b.heatScore - a.heatScore || b.amount - a.amount);
}

function sectorLabels(stock) {
  const labels = [];
  if (stock.industry) labels.push(String(stock.industry).trim());
  for (const label of businessConcepts(stock) || []) labels.push(String(label).trim());
  return [...new Set(labels.filter(Boolean))].slice(0, 3);
}

async function collectSectorNews(sector, date) {
  const queries = [sector.name, ...(sector.topStocks || []).slice(0, 3).map((stock) => stock.name)].filter(Boolean);
  const results = [];
  for (const query of queries.slice(0, 4)) {
    const gdelt = await fetchGdeltNews(query, date).catch((error) => {
      console.warn(`gdelt news failed for ${query}: ${error.message}`);
      return [];
    });
    results.push(...gdelt);
  }
  const rss = await fetchConfiguredRssNews(queries, date).catch((error) => {
    console.warn(`rss news failed for ${sector.name}: ${error.message}`);
    return [];
  });
  results.push(...rss);
  return results;
}

async function fetchGdeltNews(query, date) {
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", query);
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("format", "json");
  url.searchParams.set("maxrecords", "25");
  url.searchParams.set("sort", "hybridrel");
  url.searchParams.set("startdatetime", `${date.replace(/-/g, "")}000000`);
  url.searchParams.set("enddatetime", `${date.replace(/-/g, "")}235959`);
  const data = await fetchJson(url);
  return (data?.articles || []).map((article) => normalizeNewsArticle({
    title: article.title,
    url: article.url,
    source: article.domain || article.sourceCountry || "GDELT",
    publishedAt: gdeltDate(article.seendate),
    summary: article.snippet || "",
    provider: "gdelt",
    query
  })).filter(Boolean);
}

async function fetchConfiguredRssNews(queries, date) {
  const urls = newsRssUrls();
  if (!urls.length) return [];
  const rows = [];
  for (const url of urls) {
    const xml = await fetchText(url).catch((error) => {
      console.warn(`rss source failed ${url}: ${error.message}`);
      return "";
    });
    if (!xml) continue;
    rows.push(...parseRssItems(xml, url)
      .filter((item) => isNewsOnDate(item, date))
      .filter((item) => queries.some((query) => newsText(item).includes(query)))
      .map((item) => normalizeNewsArticle({ ...item, provider: "rss", query: queries[0] })));
  }
  return rows;
}

function newsRssUrls() {
  const configured = String(process.env.NEWS_RSS_URLS || "").split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  if (configured.length) return configured;
  return [
    "https://www.chinanews.com.cn/rss/finance.xml",
    "https://www.gov.cn/rss/yaowen.xml"
  ];
}

function parseRssItems(xml, sourceUrl) {
  const items = [];
  for (const match of String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const item = match[0];
    items.push({
      title: xmlText(item, "title"),
      url: xmlText(item, "link") || xmlText(item, "guid"),
      source: hostname(sourceUrl),
      publishedAt: parseRssDate(xmlText(item, "pubDate") || xmlText(item, "published") || xmlText(item, "updated")),
      summary: xmlText(item, "description")
    });
  }
  return items;
}

function selectSectorNews(items, { excludeKeys = new Set() } = {}) {
  const byKey = new Map();
  for (const item of items.map(normalizeNewsArticle).filter(Boolean)) {
    const key = newsFingerprint(item);
    if (!key || excludeKeys.has(key) || byKey.has(key)) continue;
    byKey.set(key, item);
  }
  const rows = [...byKey.values()].map((item) => {
    const related = [...byKey.values()]
      .filter((other) => other !== item && similarNews(item, other))
      .slice(0, 3)
      .map(compactRelatedNews);
    return {
      ...item,
      discussionScore: 1 + related.length,
      impactScore: newsImpactScore(item, related),
      relatedReports: related.slice(0, 3)
    };
  });
  return rows.sort((a, b) => b.impactScore - a.impactScore || String(b.publishedAt).localeCompare(String(a.publishedAt)))
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

async function analyzeSectorWithDeepSeek(sector, news, session, date) {
  const apiKey = process.env.DEEPSEEK_API_KEY || "";
  const model = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
  if (!apiKey) return { status: "skipped", reason: "DEEPSEEK_API_KEY is not configured", model };
  if (!news.length) return { status: "skipped", reason: "no news to analyze", model };
  const payload = {
    model,
    messages: [
      { role: "system", content: "你是A股资讯分析助手。只基于用户提供的新闻标题、摘要、来源和行情板块信息做简洁总结，不编造事实，不输出投资建议。" },
      { role: "user", content: JSON.stringify({ date, session, sector, news }, null, 2) }
    ],
    temperature: 0.2,
    max_tokens: 900
  };
  try {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`DeepSeek request failed ${response.status}: ${(await response.text()).slice(0, 160)}`);
    const data = await response.json();
    return { status: "ok", model, summary: data?.choices?.[0]?.message?.content || "" };
  } catch (error) {
    return { status: "failed", model, error: error.message };
  }
}

function normalizeNewsArticle(input) {
  const title = decodeEntities(String(input?.title || "").replace(/\s+/g, " ").trim());
  const url = String(input?.url || "").trim();
  if (!title || !url) return null;
  return {
    title,
    url,
    source: String(input.source || hostname(url) || "").trim(),
    publishedAt: input.publishedAt || "",
    summary: decodeEntities(String(input.summary || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 220),
    provider: input.provider || "",
    query: input.query || ""
  };
}

function newsIndexItem(item) {
  return {
    date: item.date,
    midday: item.midday ? newsSessionIndexItem(item.midday) : null,
    close: item.close ? newsSessionIndexItem(item.close) : null
  };
}

function newsSessionIndexItem(report) {
  return {
    session: report.session,
    generatedAt: report.generatedAt,
    status: report.status,
    sectorCount: (report.sectors || []).length,
    sectors: (report.sectors || []).map((sector) => ({ name: sector.name, heatScore: sector.heatScore, newsCount: (sector.news || []).length }))
  };
}

function compactRelatedNews(item) {
  return {
    title: item.title,
    url: item.url,
    source: item.source,
    publishedAt: item.publishedAt
  };
}

function newsFingerprint(item) {
  const url = String(item?.url || "").replace(/^https?:\/\//, "").replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
  if (url) return url;
  return normalizeNewsTitle(item?.title || "");
}

function normalizeNewsTitle(title) {
  return String(title || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 80);
}

function similarNews(a, b) {
  const ta = normalizeNewsTitle(a.title);
  const tb = normalizeNewsTitle(b.title);
  if (!ta || !tb) return false;
  return ta.includes(tb.slice(0, 16)) || tb.includes(ta.slice(0, 16)) || a.source !== b.source && a.query && a.query === b.query;
}

function newsImpactScore(item, related) {
  const sourceBoost = /新华社|证券|财经|财联社|上证|中证|时报|gov|xinhuanet|stcn|cnstock|cs\.com/.test(`${item.source} ${item.url}`) ? 3 : 0;
  const recencyBoost = item.publishedAt ? 2 : 0;
  return 10 + related.length * 8 + sourceBoost + recencyBoost;
}

function newsText(item) {
  return `${item.title || ""}${item.summary || ""}`;
}

function isNewsOnDate(item, date) {
  if (!item.publishedAt) return true;
  return String(item.publishedAt).slice(0, 10) === date;
}

function gdeltDate(value) {
  const raw = String(value || "");
  if (/^\d{8}T\d{6}Z$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`;
  return raw;
}

function parseRssDate(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function xmlText(xml, tag) {
  const match = String(xml).match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) return "";
  return decodeEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim());
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
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
  const primary = await fetchEastmoneyQuotes(symbols).catch((error) => {
    console.warn(`eastmoney quote source failed, falling back to sina: ${error.message}`);
    return [];
  });
  const bySymbol = new Map(primary.map((item) => [item.symbol, item]));
  const missing = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))]
    .filter((symbol) => {
      const quote = bySymbol.get(symbol);
      return !quote || !quote.open || !quote.close || !quote.high || !quote.low;
    });
  if (missing.length) {
    const fallback = await fetchSinaQuotes(missing).catch((error) => {
      console.warn(`sina quote fallback failed: ${error.message}`);
      return [];
    });
    for (const quote of fallback) {
      const current = bySymbol.get(quote.symbol) || {};
      bySymbol.set(quote.symbol, {
        ...current,
        symbol: quote.symbol,
        name: current.name || quote.name,
        changePct: current.changePct ?? quote.changePct,
        open: current.open || quote.open,
        high: current.high || quote.high,
        low: current.low || quote.low,
        previousClose: current.previousClose || quote.previousClose,
        close: current.close || quote.close,
        closeVsOpenPct: current.closeVsOpenPct ?? quote.closeVsOpenPct,
        dataSource: current.dataSource || quote.dataSource
      });
    }
  }
  return [...bySymbol.values()].filter((item) => item.symbol);
}

async function fetchEastmoneyQuotes(symbols) {
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
  return all.map(normalizeEastmoneyQuote).filter((item) => item.symbol);
}

function normalizeEastmoneyQuote(item) {
  const close = number(item.f2);
  const open = number(item.f17);
  const high = number(item.f15);
  const low = number(item.f16);
  const previousClose = number(item.f18);
  return {
    symbol: normalizeSymbol(item.f12),
    name: String(item.f14 || "").trim(),
    changePct: number(item.f3),
    open,
    high,
    low,
    previousClose,
    close,
    closeVsOpenPct: open ? ((close - open) / open) * 100 : null
  };
}

async function fetchSinaQuotes(symbols) {
  const all = [];
  const sinaSymbols = symbols.map(toSinaSymbol).filter(Boolean);
  for (let i = 0; i < sinaSymbols.length; i += 80) {
    const batch = sinaSymbols.slice(i, i + 80);
    const payload = await fetchText(`https://hq.sinajs.cn/list=${batch.join(",")}`);
    all.push(...parseSinaQuotePayload(payload));
    await sleep(250);
  }
  return all;
}

function parseSinaQuotePayload(payload) {
  const rows = [];
  const pattern = /var hq_str_([a-z]{2}\d{6})="([^"]*)";/g;
  let match;
  while ((match = pattern.exec(payload))) {
    const symbol = normalizeSymbol(match[1]);
    const fields = match[2].split(",");
    if (!symbol || fields.length < 32 || !fields[0]) continue;
    const open = number(fields[1]);
    const previousClose = number(fields[2]);
    const close = number(fields[3]);
    const high = number(fields[4]);
    const low = number(fields[5]);
    rows.push({
      symbol,
      name: fields[0],
      date: fields[30] || "",
      time: fields[31] || "",
      changePct: previousClose ? ((close - previousClose) / previousClose) * 100 : null,
      open,
      high,
      low,
      previousClose,
      close,
      closeVsOpenPct: open ? ((close - open) / open) * 100 : null,
      dataSource: "sina"
    });
  }
  return rows;
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
  const previous = findPreviousReport(db, type, date);
  const sourceDate = previous?.date || previousDate;
  const previousStocks = previous?.stocks || [];
  if (!previousStocks.length) return { previousDate, date, status: "missing_previous_report", items: [] };
  try {
    const quotes = await fetchQuotes(previousStocks.map((stock) => stock.symbol));
    const map = new Map(quotes.map((quote) => [quote.symbol, quote]));
    return {
      previousDate: sourceDate,
      expectedPreviousDate: previousDate,
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
      previousDate: sourceDate,
      expectedPreviousDate: previousDate,
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

function findPreviousReport(db, type, date) {
  const exactDate = previousWeekday(date);
  const primary = type === "late" ? db.lateReports : db.dailyReports;
  const secondary = type === "late" ? db.dailyReports : db.lateReports;
  return primary?.[exactDate]
    || secondary?.[exactDate]
    || latestReportBefore(primary, date)
    || latestReportBefore(secondary, date)
    || null;
}

function latestReportBefore(collection, date) {
  return Object.values(collection || {})
    .filter((report) => report?.date && report.date < date && report?.stocks?.length)
    .sort((a, b) => b.date.localeCompare(a.date))[0] || null;
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

async function fetchText(url) {
  let lastError;
  for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "text/plain,*/*",
          Referer: "https://finance.sina.com.cn/",
          "User-Agent": "Mozilla/5.0 github-pages-stock-report/1.0"
        }
      });
      if (!response.ok) throw new Error(`Request failed ${response.status}: ${(await response.text()).slice(0, 160)}`);
      return response.text();
    } catch (error) {
      lastError = error;
      if (attempt < REQUEST_RETRIES) {
        console.warn(`external text request failed, retrying in ${REQUEST_RETRY_DELAY_MS / 1000}s: ${error.message}`);
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
      newsReports: db.newsReports || {},
      etfRotationReports: db.etfRotationReports || {},
      etfRotationPortfolio: db.etfRotationPortfolio || null,
      latePortfolio: db.latePortfolio || null,
      dailyPortfolio: db.dailyPortfolio || null,
      jobLogs: db.jobLogs || []
    };
  } catch {
    return { dailyReports: {}, lateReports: {}, weeklyReports: {}, newsReports: {}, etfRotationReports: {}, etfRotationPortfolio: null, latePortfolio: null, dailyPortfolio: null, jobLogs: [] };
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
  db.newsReports = pruneNewsReports(db.newsReports || {}, REPORT_RETENTION_DAYS);
  db.etfRotationReports = pruneReportMap(db.etfRotationReports || {}, "date", REPORT_RETENTION_DAYS);
  db.jobLogs = (db.jobLogs || []).slice(-200);
  if (db.latePortfolio?.history) {
    db.latePortfolio.history = db.latePortfolio.history.slice(-REPORT_RETENTION_DAYS);
  }
  if (db.dailyPortfolio?.history) {
    db.dailyPortfolio.history = db.dailyPortfolio.history.slice(-REPORT_RETENTION_DAYS);
  }
}

function pruneNewsReports(map, limit) {
  return Object.fromEntries(
    Object.entries(map)
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, limit)
  );
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

function toSinaSymbol(symbol) {
  const normalized = normalizeSymbol(symbol);
  const code = normalized.slice(2);
  if (normalized.startsWith("SH")) return `sh${code}`;
  if (normalized.startsWith("SZ")) return `sz${code}`;
  if (normalized.startsWith("BJ")) return `bj${code}`;
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
