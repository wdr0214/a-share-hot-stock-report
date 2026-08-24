Exit code: 0
Wall time: 1.7 seconds
Total output lines: 2008
Output:
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
const ETF_ROTATION_ETFS = [
  { symbol: "SZ159915", name: "鍒涗笟鏉縀TF" },
  { symbol: "SH510300", name: "娌繁300ETF" },
  { symbol: "SH518880", name: "榛勯噾ETF" },
  { symbol: "SZ159941", name: "绾虫寚ETF" },
  { symbol: "SH513050", name: "涓浗浜掕仈缃慐TF" },
  { symbol: "SH511260", name: "鍗佸勾鍥藉€篍TF" }
];
const ETF_MOMENTUM_DAYS = 20;
const ETF_MA_DAYS = 28;
const ETF_ROTATION_FEE_RATE = 0.0001;
const A_SHARE_CLOSED_DATES = new Set([
  "2025-01-01", "2025-01-28", "2025-01-29", "2025-01-30", "2025-01-31", "2025-02-03", "2025-02-04",
  "2025-04-04", "2025-05-01", "2025-05-02", "2025-05-05", "2025-06-02",
  "2025-10-01", "2025-10-02", "2025-10-03", "2025-10-06", "2025-10-07", "2025-10-08",
  "2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-23",
  "2026-04-06", "2026-05-01", "2026-05-04", "2026-05-05", "2026-06-19", "2026-09-25",
  "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"
]);

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
    return await generateEtfRotationReport(date);
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

async function generateEtfRotationReport(date) {
  assertEtfRotationAllowed(date);
  const db = await readDb();
  const symbols = ETF_ROTATION_ETFS.map((item) => item.symbol);
  const quotes = await withRetry("etf rotation quotes", () => fetchQuotes(symbols));
  const quoteMap = new Map(quotes.map((quote) => [quote.symbol, quote]));
  const rows = [];

  for (const etf of ETF_ROTATION_ETFS) {
    const quote = quoteMap.get(etf.symbol);
    if (!quote?.close) throw new Error(`Missing 14:53 quote for ${etf.symbol}`);
    const kline = await withRetry(`etf rotation kline ${etf.symbol}`, () => fetchKline(etf.symbol));
    const completed = kline.filter((item) => item.date < date).sort((a, b) => a.date.localeCompare(b.date));
    if (completed.length < ETF_MA_DAYS) throw new Error(`Insufficient completed daily kline for ${etf.symbol}`);
    const maRows = completed.slice(-ETF_MA_DAYS);
    const momentumBase = completed.at(-ETF_MOMENTUM_DAYS);
    const executionPrice = number(quote.close);
    const ma28 = maRows.reduce((sum, item) => sum + number(item.close), 0) / ETF_MA_DAYS;
    const momentum20Pct = momentumBase?.close ? ((executionPrice - number(momentumBase.close)) / number(momentumBase.close)) * 100 : null;
    if (!Number.isFinite(momentum20Pct) || !ma28) throw new Error(`Unable to calculate rotation parameters for ${etf.symbol}`);
    rows.push({
      ...etf,
      executionPrice: round(executionPrice, 4),
      momentum20Pct: round(momentum20Pct, 4),
      ma28: round(ma28, 4),
      aboveMa28: executionPrice > ma28,
      quoteSource: quote.dataSource || "eastmoney",
      quoteTime: quote.time || "",
      quoteDate: quote.date || date
    });
  }

  const momentumLeader = [...rows].sort((a, b) => b.momentum20Pct - a.momentum20Pct)[0];
  const target = momentumLeader?.aboveMa28 ? momentumLeader : null;
  const snapshot = updateEtfRotationPortfolio(db, date, target, quoteMap);
  const generatedAt = new Date().toISOString();
  const report = {
    type: "etf-rotation",
    date,
    generatedAt,
    status: "ok",
    source: "real-time-free-market-data",
    executionTime: "14:53",
    quoteCapturedAt: generatedAt,
    parameters: {
      momentumDays: ETF_MOMENTUM_DAYS,
      movingAverageDays: ETF_MA_DAYS,
      feeRate: ETF_ROTATION_FEE_RATE
    },
    etfs: rows,
    momentumLeader: momentumLeader ? { symbol: momentumLeader.symbol, name: momentumLeader.name } : null,
    target: target ? { symbol: target.symbol, name: target.name, price: target.executionPrice } : null,
    rotationPortfolio: snapshot,
    notice: "鍩轰簬鐪熷疄琛屾儏蹇収鐢熸垚锛屼笉鏋勬垚鎶曡祫寤鸿銆?
  };
  db.etfRotationReports[date] = report;
  db.jobLogs.push({
    jobName: "etf-rotation",
    startedAt: generatedAt,
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

function updateEtfRotationPortfolio(db, date, target, quoteMap) {
  const state = db.etfRotationPortfolio || { netValue: 1, cash: 1, holding: null, history: [] };
  let cash = number(state.cash);
  let holding = state.holding || null;
  const trades = [];

  if (holding) {
    const mark = quoteMap.get(holding.symbol);
    if (!mark?.close) throw new Error(`Missing 14:53 quote for current holding ${holding.symbol}`);
    const markPrice = number(mark.close);
    if (target?.symbol !== holding.symbol) {
      const gross = number(holding.shares) * markPrice;
      const fee = gross * ETF_ROTATION_FEE_RATE;
      cash += gross - fee;
      trades.push({ action: "sell", symbol: holding.symbol, name: holding.name, price: round(markPrice, 4), fee: round(fee, 6) });
      holding = null;
    }
  }

  if (target && !holding) {
    const gross = cash;
    const fee = gross * ETF_ROTATION_FEE_RATE;
    const investment = gross - fee;
    const shares = investment / target.executionPrice;
    holding = { symbol: target.symbol, name: target.name, entryPrice: target.executionPrice, shares, date };
    cash = 0;
    trades.push({ action: "buy", symbol: target.symbol, name: target.name, price: target.executionPrice, fee: round(fee, 6) });
  }

  const holdingQuote = holding ? quoteMap.get(holding.symbol) : null;
  const markedHoldingValue = holding ? number(holding.shares) * number(holdingQuote?.close) : 0;
  const netValue = cash + markedHoldingValue;
  const snapshot = {
    date,
    netValue: round(netValue, 6),
    cash: round(cash, 6),
    holding,
    trades,
    rebalanced: trades.length > 0
  };
  db.etfRotationPortfolio = {
    netValue: snapshot.netValue,
    cash,
    holding,
    history: [...(state.history || []).filter((item) => item.date !== date), snapshot]
      .sort((a, b) => a.date.localeCompare(b.date))
  };
  return snapshot;
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
      ? "灏剧洏鎶ュ憡涓庢棩鎶ヤ娇鐢ㄥ悓涓€濂楄鎯呯儹搴﹁瘎鍒嗭紱鍛ㄦ姤榛樿姹囨€绘敹鐩樺悗鐨勬棩鎶ワ紝閬垮厤鍚屼竴浜ゆ槗鏃ラ噸澶嶈鏁般€?
      : "鏃ユ姤浣跨敤鏀剁洏鍚庤鎯呯儹搴﹁瘎鍒嗭紱鍛ㄦ姤榛樿姹囨€绘棩鎶ョ粨鏋溿€?,
    notice: "鍩轰簬鐪熷疄琛屾儏鏁版嵁鐢熸垚锛涘厤璐规簮涓嶄繚璇佺ǔ瀹氭€э紱涓嶆瀯鎴愭姇璧勫缓璁€?,
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
      buyRecords.push({ symbol: stock.symbol, name: stock.name, skipped: true, reason: "娑ㄥ仠鏃犳硶涔板叆" });
      continue;
    }
    const price = number(stock.close || stock.kline?.at(-1)?.close);
    const allocation = currentNetValue * 0.2;
    if (!price || allocation <= 0 || cash < allocation) {
      buyRecords.push({ symbol: stock.symbol, name: stock.name, skipped: true, reason: "浠锋牸鏁版嵁涓嶈冻鎴栫幇閲戜笉瓒? });
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
  re…9683 tokens truncated…ush(...parseSinaQuotePayload(payload));
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
    [/杩滀笢鑲′唤/, ["鐢电嚎鐢电紗", "鏅鸿兘缂嗙綉"]],
    [/閾滃啝閾滅當/, ["鐢靛瓙閾滅當", "閿傜數鏉愭枡"]],
    [/璇哄痉鑲′唤/, ["閾滅當鏉愭枡", "鏂拌兘婧愭潗鏂?]],
    [/鐩涘悲鐭夸笟/, ["鏈夎壊閲戝睘", "鐭夸骇璧勬簮"]],
    [/瀹楃敵鍔ㄥ姏/, ["閫氱敤鍔ㄥ姏", "鎽╂墭杞﹀姩鍔?]]
  ];
  for (const [pattern, labels] of known) {
    if (pattern.test(name)) concepts.push(...labels);
  }
  if (stock.industry) concepts.push(stock.industry);
  const text = `${stock.name}${stock.industry}`;
  const rules = [
    [/閾惰|璇佸埜|淇濋櫓|閲戣瀺|淇℃墭/, "閲戣瀺鏈嶅姟"],
    [/鍗婂浣搢鑺墖|闆嗘垚鐢佃矾|寰數瀛?, "鍗婂浣?],
    [/杞欢|淇℃伅|鏁版嵁|浜憒缃戠粶|绉戞妧/, "杞欢涓庝俊鎭湇鍔?],
    [/姹借溅|杞姹介厤|鐢垫睜|閿倈鏂拌兘婧?, "姹借溅涓庢柊鑳芥簮"],
    [/鍖昏嵂|鐢熺墿|鍖荤枟|鑽瘄鍒惰嵂/, "鍖昏嵂鐢熺墿"],
    [/鐢靛姏|鑳芥簮|鍏変紡|椋庣數|姘寸數|鐓鐭虫补|鐕冩皵/, "鑳芥簮鐢靛姏"],
    [/鍦颁骇|寤虹瓚|寤烘潗|姘存偿|宸ョ▼/, "鍦颁骇寤虹瓚"],
    [/娑堣垂|椋熷搧|楗枡|閰抾闆跺敭|瀹剁數|鏈嶉グ/, "娑堣垂"],
    [/鍐涘伐|鑸ぉ|鑸┖|鑸硅埗|鍏靛櫒/, "鍐涘伐瑁呭"],
    [/閽㈤搧|鏈夎壊|閲戝睘|鍖栧伐|鏉愭枡/, "鍛ㄦ湡鏉愭枡"],
    [/閫氫俊|鐢靛瓙|浼犲獟|娓告垙/, "TMT"]
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
  keyPoints.push(`褰撴棩娑ㄨ穼骞?${formatPercent(stock.changePct)}锛屾垚浜ら ${formatAmount(stock.amount)}銆俙);
  if (stock.bigOrderNetAmount > 0) {
    keyPoints.push(`澶у崟璧勯噾鍑€棰濅负 ${formatAmount(stock.bigOrderNetAmount)}銆俙);
    positiveFactors.push("澶у崟鍑€娴佸叆");
  } else if (stock.bigOrderNetAmount < 0) {
    keyPoints.push(`澶у崟璧勯噾鍑€棰濅负 ${formatAmount(stock.bigOrderNetAmount)}锛岃祫閲戝瓨鍦ㄥ垎姝с€俙);
  }
  if (stock.mainNetInflow > 0) positiveFactors.push("涓诲姏璧勯噾");
  if (stock.superLargeOrderNetAmount > 0) positiveFactors.push("瓒呭ぇ鍗曟椿璺?);
  if (stock.volumeRatio >= 1.5) positiveFactors.push("鏀鹃噺");
  if (stock.turnoverRate >= 5) positiveFactors.push("楂樻崲鎵?);
  if (trendScore(kline) >= 10) {
    keyPoints.push("杩戝崐骞翠环鏍艰秼鍔胯緝寮猴紝琛ㄦ槑涓湡瓒嬪娍鏈夋敼鍠勩€?);
    positiveFactors.push("寮鸿秼鍔?);
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
      etfRotationReports: db.etfRotationReports || {},
      latePortfolio: db.latePortfolio || null,
      dailyPortfolio: db.dailyPortfolio || null,
      etfRotationPortfolio: db.etfRotationPortfolio || null,
      jobLogs: db.jobLogs || []
    };
  } catch {
    return { dailyReports: {}, lateReports: {}, weeklyReports: {}, etfRotationReports: {}, latePortfolio: null, dailyPortfolio: null, etfRotationPortfolio: null, jobLogs: [] };
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
  db.etfRotationReports = pruneReportMap(db.etfRotationReports || {}, "date", REPORT_RETENTION_DAYS);
  db.jobLogs = (db.jobLogs || []).slice(-200);
  if (db.latePortfolio?.history) {
    db.latePortfolio.history = db.latePortfolio.history.slice(-REPORT_RETENTION_DAYS);
  }
  if (db.dailyPortfolio?.history) {
    db.dailyPortfolio.history = db.dailyPortfolio.history.slice(-REPORT_RETENTION_DAYS);
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
  if (!isWeekday(date)) throw new Error("鎶ュ憡鍙湪浜ゆ槗鏃ョ敓鎴愶紱鍛ㄦ湯涓嶇敓鎴愬綋澶╂姤鍛娿€?);
  if (date > now.date) throw new Error("涓嶈兘鐢熸垚鏈潵鏃ユ湡鐨勬姤鍛娿€?);
  if (date === now.date && (now.hour < hour || (now.hour === hour && now.minute < minute))) {
    throw new Error(`${type === "late" ? "灏剧洏鎶ュ憡" : "鏃ユ姤"}灏嗗湪浜ゆ槗鏃?${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} 鍚庣敓鎴愶紱褰撳墠鏈埌鑷姩鐢熸垚鏃堕棿銆俙);
  }
}

function assertEtfRotationAllowed(date) {
  const now = shanghaiParts(new Date());
  if (!isAshareTradingDate(date)) throw new Error("ETF杞姩鍙湪A鑲′氦鏄撴棩鐢熸垚锛涢潪浜ゆ槗鏃ヨ烦杩囥€?);
  if (date !== now.date) throw new Error("ETF杞姩鍙敓鎴愬綋鏃?4:53鐪熷疄琛屾儏蹇収锛屼笉鑳界敤褰撳墠鎶ヤ环琛ラ€犲巻鍙叉姤鍛娿€?);
  if (now.hour < 14 || (now.hour === 14 && now.minute < 53)) {
    throw new Error("ETF杞姩鎶ュ憡灏嗗湪浜ゆ槗鏃?4:53鍚庣敓鎴愶紱褰撳墠鏈埌鎵ц鏃堕棿銆?);
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

function isAshareTradingDate(date) {
  const configured = String(process.env.A_SHARE_CLOSED_DATES || process.env.A_SHARE_NON_TRADING_DATES || "")
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item));
  return isWeekday(date) && !A_SHARE_CLOSED_DATES.has(date) && !configured.includes(date);
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
  if (Math.abs(n) >= 100000000) return `${(n / 100000000).toFixed(1)} 浜縛;
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(0)} 涓嘸;
  return String(Math.round(n));
}

function formatPercent(value) {
  return `${number(value).toFixed(2)}%`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

