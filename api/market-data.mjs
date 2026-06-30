const EASTMONEY_FIELDS = "f12,f14,f2,f3,f6,f7,f8,f10,f62,f66,f69,f72,f75,f100";
const QUOTE_FIELDS = "f12,f14,f2,f3,f15,f16,f17,f18";

export default async function handler(req, res) {
  try {
    const resource = String(req.query?.resource || req.query?.type || "hot-stocks");
    if (resource === "hot-stocks" || resource === "hot") {
      const limit = Math.max(1, Math.min(Number(req.query?.limit || 500), 500));
      const items = await fetchEastmoneyHotStocks(limit);
      return res.status(200).json({ ok: true, runtime: "vercel", resource: "hot-stocks", source: "eastmoney", count: items.length, items });
    }

    if (resource === "quotes") {
      const symbols = String(req.query?.symbols || "").split(",").map((symbol) => symbol.trim()).filter(Boolean);
      const items = await fetchQuotes(symbols);
      return res.status(200).json({ ok: true, runtime: "vercel", resource: "quotes", source: "eastmoney+sina", count: items.length, items });
    }

    if (resource === "kline") {
      const symbol = normalizeSymbol(req.query?.symbol);
      if (!symbol) return res.status(400).json({ ok: false, error: "symbol is required" });
      const items = await fetchYahooKline(symbol);
      return res.status(200).json({ ok: true, runtime: "vercel", resource: "kline", source: "yahoo", symbol, count: items.length, items });
    }

    return res.status(404).json({ ok: false, error: "Not found" });
  } catch (error) {
    return res.status(502).json({ ok: false, runtime: "vercel", error: error.message });
  }
}

async function fetchEastmoneyHotStocks(limit) {
  const pageSize = 100;
  const pages = Math.ceil(limit / pageSize);
  const items = [];
  for (let page = 1; page <= pages; page += 1) {
    const rows = await withRetry(`eastmoney hot-stocks page ${page}`, () => fetchEastmoneyHotStocksPage(page, pageSize));
    items.push(...rows);
    if (rows.length < pageSize) break;
    if (page < pages) await sleep(350);
  }
  return items.map(normalizeEastmoneyStock).filter(Boolean).slice(0, limit);
}

async function fetchEastmoneyHotStocksPage(page, pageSize) {
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
  const payload = await fetchJson(url);
  const rows = payload?.data?.diff;
  if (!Array.isArray(rows)) throw new Error("Eastmoney response missing data.diff");
  return rows;
}

async function fetchQuotes(symbols) {
  const primary = await fetchEastmoneyQuotes(symbols).catch(() => []);
  const bySymbol = new Map(primary.map((item) => [item.symbol, item]));
  const missing = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))]
    .filter((symbol) => {
      const quote = bySymbol.get(symbol);
      return !quote || !quote.open || !quote.close || !quote.high || !quote.low;
    });
  if (missing.length) {
    const fallback = await fetchSinaQuotes(missing).catch(() => []);
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
  if (!secids.length) return [];
  const items = [];
  for (let index = 0; index < secids.length; index += 50) {
    const url = new URL("https://push2.eastmoney.com/api/qt/ulist.np/get");
    url.searchParams.set("fltt", "2");
    url.searchParams.set("invt", "2");
    url.searchParams.set("secids", secids.slice(index, index + 50).join(","));
    url.searchParams.set("fields", QUOTE_FIELDS);
    const payload = await fetchJson(url);
    const rows = payload?.data?.diff || [];
    items.push(...rows.map(normalizeEastmoneyQuote).filter(Boolean));
  }
  return items;
}

async function fetchYahooKline(symbol) {
  const yahoo = toYahooSymbol(symbol);
  const payload = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${yahoo}?range=6mo&interval=1d`);
  const result = payload?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  return timestamps.map((timestamp, index) => ({
    date: new Date(timestamp * 1000).toISOString().slice(0, 10),
    open: number(quote.open?.[index]),
    high: number(quote.high?.[index]),
    low: number(quote.low?.[index]),
    close: number(quote.close?.[index]),
    volume: number(quote.volume?.[index])
  })).filter((row) => row.open && row.high && row.low && row.close);
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json,text/plain,*/*", Referer: "https://quote.eastmoney.com/", "User-Agent": "Mozilla/5.0 vercel-stock-report/1.0" } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`request failed ${response.status}: ${text.slice(0, 180)}`);
  }
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { Accept: "text/plain,*/*", Referer: "https://finance.sina.com.cn/", "User-Agent": "Mozilla/5.0 vercel-stock-report/1.0" } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`request failed ${response.status}: ${text.slice(0, 180)}`);
  }
  return response.text();
}

async function withRetry(label, task) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(800);
    }
  }
  throw new Error(`${label} failed after retries: ${lastError.message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeEastmoneyStock(item = {}) {
  const symbol = normalizeSymbol(item.f12);
  if (!symbol) return null;
  const superLargeOrderNetAmount = number(item.f66);
  const largeOrderNetAmount = number(item.f72);
  return {
    symbol,
    name: String(item.f14 || symbol).trim(),
    changePct: number(item.f3),
    close: number(item.f2),
    amount: number(item.f6),
    turnoverRate: number(item.f8),
    volumeRatio: number(item.f10 || 1),
    amplitude: number(item.f7),
    industry: String(item.f100 || "").trim(),
    mainNetInflow: number(item.f62),
    superLargeOrderNetAmount,
    superLargeOrderNetRatio: number(item.f69),
    largeOrderNetAmount,
    largeOrderNetRatio: number(item.f75),
    bigOrderNetAmount: superLargeOrderNetAmount + largeOrderNetAmount,
    dataSource: "vercel-eastmoney"
  };
}

function normalizeEastmoneyQuote(item = {}) {
  const symbol = normalizeSymbol(item.f12);
  const open = number(item.f17);
  const high = number(item.f15);
  const low = number(item.f16);
  const previousClose = number(item.f18);
  const close = number(item.f2);
  if (!symbol) return null;
  return { symbol, name: String(item.f14 || symbol).trim(), changePct: number(item.f3), open, high, low, previousClose, close, closeVsOpenPct: open ? ((close - open) / open) * 100 : null };
}

async function fetchSinaQuotes(symbols) {
  const items = [];
  const sinaSymbols = symbols.map(toSinaSymbol).filter(Boolean);
  for (let index = 0; index < sinaSymbols.length; index += 80) {
    const batch = sinaSymbols.slice(index, index + 80);
    const payload = await fetchText(`https://hq.sinajs.cn/list=${batch.join(",")}`);
    items.push(...parseSinaQuotePayload(payload));
    if (index + 80 < sinaSymbols.length) await sleep(250);
  }
  return items;
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

function normalizeSymbol(symbol) {
  const raw = String(symbol || "").trim().toUpperCase().replace(".", "");
  if (/^(SH|SZ|BJ)\d{6}$/.test(raw)) return raw;
  if (/^6\d{5}$/.test(raw)) return `SH${raw}`;
  if (/^[038]\d{5}$/.test(raw)) return `SZ${raw}`;
  if (/^[492]\d{5}$/.test(raw)) return `BJ${raw}`;
  return "";
}

function toEastmoneySecid(symbol) {
  const normalized = normalizeSymbol(symbol);
  if (normalized.startsWith("SH")) return `1.${normalized.slice(2)}`;
  if (normalized.startsWith("SZ")) return `0.${normalized.slice(2)}`;
  if (normalized.startsWith("BJ")) return `0.${normalized.slice(2)}`;
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

function toYahooSymbol(symbol) {
  const normalized = normalizeSymbol(symbol);
  if (normalized.startsWith("SH")) return `${normalized.slice(2)}.SS`;
  if (normalized.startsWith("SZ")) return `${normalized.slice(2)}.SZ`;
  if (normalized.startsWith("BJ")) return `${normalized.slice(2)}.BJ`;
  return normalized;
}

function number(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}
