const ETFS = [
  { symbol: "SZ159915", name: "\u521b\u4e1a\u677fETF", eastmoneySecid: "0.159915", yahooSymbol: "159915.SZ", sinaSymbol: "sz159915" },
  { symbol: "SH510300", name: "\u6caa\u6df1300ETF", eastmoneySecid: "1.510300", yahooSymbol: "510300.SS", sinaSymbol: "sh510300" },
  { symbol: "SH518880", name: "\u9ec4\u91d1ETF", eastmoneySecid: "1.518880", yahooSymbol: "518880.SS", sinaSymbol: "sh518880" },
  { symbol: "SZ159941", name: "\u7eb3\u6307ETF", eastmoneySecid: "0.159941", yahooSymbol: "159941.SZ", sinaSymbol: "sz159941" },
  { symbol: "SH513050", name: "\u4e2d\u56fd\u4e92\u8054\u7f51ETF", eastmoneySecid: "1.513050", yahooSymbol: "513050.SS", sinaSymbol: "sh513050" },
  { symbol: "SH511260", name: "\u5341\u5e74\u56fd\u503aETF", eastmoneySecid: "1.511260", yahooSymbol: "511260.SS", sinaSymbol: "sh511260" }
];

const CLOSED_DATES = new Set([
  "2025-01-01","2025-01-28","2025-01-29","2025-01-30","2025-01-31","2025-02-03","2025-02-04",
  "2025-04-04","2025-05-01","2025-05-02","2025-05-05","2025-06-02","2025-10-01","2025-10-02","2025-10-03","2025-10-06","2025-10-07","2025-10-08",
  "2026-01-01","2026-01-02","2026-02-16","2026-02-17","2026-02-18","2026-02-19","2026-02-20",
  "2026-04-06","2026-05-01","2026-05-04","2026-05-05","2026-06-19","2026-10-01","2026-10-02","2026-10-05","2026-10-06","2026-10-07"
]);
const FEE_RATE = 0.0001;

export function isEtfRotationTradingDate(date) {
  const day = new Date(`${date}T12:00:00+08:00`).getUTCDay();
  return day >= 1 && day <= 5 && !CLOSED_DATES.has(date);
}

export async function generateEtfRotation({ date, now, portfolio, executionPriceMode = "intraday" }) {
  if (!["intraday", "close-backfill"].includes(executionPriceMode)) throw new Error("Unsupported ETF execution price mode");
  if (!isEtfRotationTradingDate(date)) {
    throw new Error("非 A 股交易日，ETF 轮动报告已跳过。");
  }
  const useCloseBackfill = executionPriceMode === "close-backfill";
  const shanghai = shanghaiParts(now);
  if (!useCloseBackfill && (date !== shanghai.date || shanghai.hour < 14 || (shanghai.hour === 14 && shanghai.minute < 53))) {
    throw new Error("ETF 轮动报告仅在当日 14:53 后生成，不使用伪造的历史分钟价。");
  }

  const useMinuteBackfill = !useCloseBackfill && (shanghai.hour > 14 || shanghai.minute > 53);
  const quoteTask = useCloseBackfill ? null : useMinuteBackfill
    ? fetchExecutionMinuteQuotes(ETFS, date)
    : fetchQuotesWithFallback(ETFS, date).catch(() => fetchExecutionMinuteQuotes(ETFS, date));
  const [klineSets, intradayQuotes] = await Promise.all([
    Promise.all(ETFS.map((etf) => fetchDailyKline(etf))), quoteTask
  ]);
  const quotes = useCloseBackfill
    ? await fetchHistoricalCloseWithFallback(ETFS, klineSets, date)
    : intradayQuotes;
  const minuteBackfilled = !useCloseBackfill && quotes.every((quote) => quote.executionPriceBasis === "minute_1453_open_backfill");
  const quoteMap = new Map(quotes.map((quote) => [quote.symbol, quote]));
  const indicators = ETFS.map((etf, index) => {
    const quote = quoteMap.get(etf.symbol);
    const rows = klineSets[index].filter((row) => row.date < date);
    if (!quote || !Number.isFinite(quote.price) || rows.length < 28) {
      throw new Error(`${etf.symbol} \u884c\u60c5\u6216\u65e5 K \u6570\u636e\u4e0d\u8db3\uff0c\u4e0d\u66f4\u65b0\u6a21\u62df\u76d8\u3002`);
    }
    const ma28 = average(rows.slice(-28).map((row) => row.close));
    const base = rows.at(-20)?.close;
    if (!Number.isFinite(base) || base <= 0) throw new Error(`${etf.symbol} \u65e0\u6cd5\u8ba1\u7b97 20 \u65e5\u6da8\u8dcc\u5e45\u3002`);
    const momentum20Pct = ((quote.price - base) / base) * 100;
    return {
      symbol: etf.symbol, name: etf.name, price: quote.price, quoteSource: quote.source, quoteTime: quote.quoteTime || null,
      momentum20Pct, ma28, aboveMa28: quote.price > ma28
    };
  });

  const leader = [...indicators].sort((a, b) => b.momentum20Pct - a.momentum20Pct)[0];
  const target = leader.aboveMa28 ? leader : null;
  const next = rebalance(portfolio, date, target, quoteMap);
  const report = {
    type: "etf-rotation", date, generatedAt: now.toISOString(), executionTime: useCloseBackfill ? "收盘价补生成" : minuteBackfilled ? "14:53分钟行情补报" : "14:53",
    executionPriceBasis: useCloseBackfill ? "daily_close_backfill" : minuteBackfilled ? "minute_1453_open_backfill" : "intraday_quote",
    status: "ok", parameters: { momentumDays: 20, maDays: 28 },
    etfs: indicators, leader: { symbol: leader.symbol, name: leader.name, momentum20Pct: leader.momentum20Pct, aboveMa28: leader.aboveMa28 },
    holding: next.holding, rebalance: next.trades,
    netValue: next.portfolio.netValue, portfolioHistory: next.portfolio.history
  };
  return { report, portfolio: next.portfolio };
}

function rebalance(previous, date, target, quoteMap) {
  const state = previous || { netValue: 1, cash: 1, holding: null, history: [] };
  let cash = Number(state.cash);
  const old = state.holding || null;
  const trades = [];
  if (old && old.symbol !== target?.symbol) {
    const quote = quoteMap.get(old.symbol);
    if (!quote?.price) throw new Error(`${old.symbol} \u7f3a\u5c11 14:53 \u5356\u51fa\u4ef7\u683c\u3002`);
    const gross = old.shares * quote.price;
    cash += gross * (1 - FEE_RATE);
    trades.push({ action: "sell", symbol: old.symbol, name: old.name, price: quote.price, returnPct: ((quote.price - old.entryPrice) / old.entryPrice) * 100 });
  }
  let holding = old && old.symbol === target?.symbol ? old : null;
  if (target && !holding) {
    const budget = cash;
    const shares = (budget * (1 - FEE_RATE)) / target.price;
    holding = { symbol: target.symbol, name: target.name, shares, entryPrice: target.price, entryDate: date };
    cash = 0;
    trades.push({ action: "buy", symbol: target.symbol, name: target.name, price: target.price });
  }
  if (!target) holding = null;
  const holdingValue = holding ? holding.shares * quoteMap.get(holding.symbol).price : 0;
  const netValue = cash + holdingValue;
  const history = [...(state.history || []).filter((item) => item.date !== date), {
    date,
    netValue,
    holding: holding ? holding.symbol : null,
    rebalanced: trades.length > 0,
    trades: trades.map((trade) => ({ ...trade }))
  }];
  return { trades, holding, portfolio: { netValue, cash, holding, history } };
}

async function fetchHistoricalCloseWithFallback(etfs, klineSets, date) {
  const eastmoney = await retry(async () => Promise.all(etfs.map(async (etf) => {
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${etf.eastmoneySecid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=0&beg=${date.replaceAll("-", "")}&end=${date.replaceAll("-", "")}`;
    const response = await fetchMarket(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!response.ok) throw new Error(`Eastmoney HTTP ${response.status}`);
    const rows = (await response.json())?.data?.klines || [];
    const row = rows.find((item) => item.startsWith(`${date},`));
    const close = number(row?.split(",")[2]);
    if (!(close > 0)) throw new Error(`${etf.symbol} 缺少 ${date} 的东方财富日K收盘价`);
    return { symbol: etf.symbol, price: close, source: "东方财富日K收盘价" };
  }))).catch(() => []);

  if (eastmoney.length === etfs.length && eastmoney.every((item) => item.price > 0)) return eastmoney;

  const hithink = await fetchHithinkDailyClose(etfs, date);
  if (hithink.length === etfs.length && hithink.every((item) => item.price > 0)) return hithink;

  return quotesFromYahooDailyClose(etfs, klineSets, date);
}

async function fetchHithinkDailyClose(etfs, date) {
  const apiKey = process.env.HITHINK_FINANCE_API_KEY || "";
  if (!apiKey) return [];

  const start = new Date(`${date}T00:00:00+08:00`).getTime();
  const end = new Date(`${date}T23:59:59.999+08:00`).getTime();
  const rows = [];
  for (const etf of etfs) {
    try {
      const url = new URL("https://fuyao.aicubes.cn/api/fund/market/historical");
      url.searchParams.set("thscode", toHithinkCode(etf.symbol));
      url.searchParams.set("interval", "1d");
      url.searchParams.set("start", String(start));
      url.searchParams.set("end", String(end));
      const response = await fetchMarket(url, { headers: { "X-api-key": apiKey } });
      const payload = await response.json();
      const item = payload?.code === 0 ? (payload.data?.item || []).find((point) => shanghaiParts(new Date(point.date_ms)).date === date) : null;
      const close = number(item?.close_price);
      if (!(close > 0)) return [];
      rows.push({ symbol: etf.symbol, price: close, source: "同花顺金融数据服务日K收盘价" });
    } catch {
      return [];
    }
  }
  return rows;
}

function toHithinkCode(symbol) {
  const code = String(symbol || "").replace(/[^0-9]/g, "");
  return `${code}.${symbol.startsWith("SH") ? "SH" : "SZ"}`;
}

function quotesFromYahooDailyClose(etfs, klineSets, date) {
  return etfs.map((etf, index) => {
    const close = klineSets[index].find((row) => row.date === date)?.close;
    if (!Number.isFinite(close) || close <= 0) {
      throw new Error(`${etf.symbol} 缺少 ${date} 的真实日 K 收盘价，无法补生成报告。`);
    }
    return { symbol: etf.symbol, price: close, source: "Yahoo 日K收盘价" };
  });
}

async function fetchQuotesWithFallback(etfs, date) {
  const eastmoney = await retry(async () => {
    const fields = "f12,f14,f2,f124";
    const secids = etfs.map((etf) => etf.eastmoneySecid).join(",");
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=${fields}&secids=${secids}`;
    const response = await fetchMarket(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!response.ok) throw new Error(`Eastmoney HTTP ${response.status}`);
    const data = await response.json();
    const rows = data?.data?.diff;
    if (!Array.isArray(rows) || rows.length !== etfs.length) throw new Error("Eastmoney quote response incomplete");
    return rows.map((row) => {
      const quoteTime = new Date(Number(row.f124) * 1000);
      assertExecutionMinute(quoteTime, date);
      return { symbol: normalizeSymbol(row.f12), price: number(row.f2), source: "Eastmoney", quoteTime: quoteTime.toISOString() };
    });
  }).catch(() => []);
  if (eastmoney.length === etfs.length && eastmoney.every((item) => item.price > 0)) return eastmoney;

  const sina = await retry(async () => {
    const url = `https://hq.sinajs.cn/list=${etfs.map((etf) => etf.sinaSymbol).join(",")}`;
    const response = await fetchMarket(url, { headers: { Referer: "https://finance.sina.com.cn/", "User-Agent": "Mozilla/5.0" } });
    if (!response.ok) throw new Error(`Sina HTTP ${response.status}`);
    const text = await response.text();
    const rows = text.split(/\r?\n/).filter(Boolean);
    const byCode = new Map(rows.map((row) => {
      const match = row.match(/hq_str_(\w+)="([^"]*)"/);
      const parts = match?.[2]?.split(",") || [];
      const quoteTime = new Date(`${parts[30]}T${parts[31]}+08:00`);
      assertExecutionMinute(quoteTime, date);
      return [normalizeSymbol(match?.[1]), { price: number(parts[3]), quoteTime: quoteTime.toISOString() }];
    }));
    const out = etfs.map((etf) => ({ symbol: etf.symbol, ...byCode.get(etf.symbol), source: "Sina" }));
    if (out.some((item) => !(item.price > 0))) throw new Error("Sina quote response incomplete");
    return out;
  });
  return sina;
}

function assertExecutionMinute(time, date) {
  if (!Number.isFinite(time.getTime())) throw new Error("ETF quote has no valid timestamp");
  const parts = shanghaiParts(time);
  if (parts.date !== date || parts.hour !== 14 || parts.minute !== 53) throw new Error("ETF quote is not from the requested 14:53 execution minute");
}

async function fetchExecutionMinuteQuotes(etfs, date) {
  return Promise.all(etfs.map((etf) => retry(async () => {
    const start = Math.floor(new Date(`${date}T00:00:00+08:00`).getTime() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${etf.yahooSymbol}?period1=${start}&period2=${start + 86400}&interval=1m`;
    const response = await fetchMarket(url);
    if (!response.ok) throw new Error(`Yahoo minute HTTP ${response.status}`);
    const result = (await response.json())?.chart?.result?.[0];
    if (result?.meta?.symbol?.toUpperCase() !== etf.yahooSymbol.toUpperCase()) throw new Error(`${etf.symbol} minute quote symbol mismatch`);
    const timestamp = Math.floor(new Date(`${date}T14:53:00+08:00`).getTime() / 1000);
    const index = result?.timestamp?.indexOf(timestamp) ?? -1;
    // The minute open is the first reported price of 14:53, not a later closing quote.
    const rawPrice = index >= 0 ? number(result?.indicators?.quote?.[0]?.open?.[index]) : null;
    if (!(rawPrice > 0)) throw new Error(`${etf.symbol} 缺少 ${date} 14:53 真实分钟行情，不使用当前价替代`);
    return { symbol: etf.symbol, price: Math.round(rawPrice * 1000) / 1000,
      source: "Yahoo 14:53分钟开盘价补报", quoteTime: new Date(timestamp * 1000).toISOString(), executionPriceBasis: "minute_1453_open_backfill" };
  })));
}

async function fetchDailyKline(etf) {
  return retry(async () => {
    const response = await fetchMarket(`https://query1.finance.yahoo.com/v8/finance/chart/${etf.yahooSymbol}?range=6mo&interval=1d`);
    if (!response.ok) throw new Error(`Yahoo HTTP ${response.status}`);
    const data = await response.json();
    const result = data?.chart?.result?.[0];
    const timestamps = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    return timestamps.map((timestamp, index) => ({
      date: shanghaiParts(new Date(timestamp * 1000)).date,
      close: number(closes[index])
    })).filter((row) => row.close > 0);
  });
}

function fetchMarket(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(12000) });
}

async function retry(fn) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await fn(); } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }
  throw lastError;
}

function shanghaiParts(input) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(input).reduce((acc, part) => (acc[part.type] = part.value, acc), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}
function normalizeSymbol(symbol) {
  const code = String(symbol || "").replace(/[^0-9]/g, "");
  return code.startsWith("6") || code.startsWith("5") ? `SH${code}` : `SZ${code}`;
}
function number(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function average(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }


