import { readFile, writeFile } from "node:fs/promises";

const file = "src/cli.js";
let source = await readFile(file, "utf8");

source = ensureProxyConstants(source);
source = ensureProxyHotStocks(source);
source = ensureProxyQuotes(source);
source = ensureProxyKline(source);
source = ensureProxyHelpers(source);
source = ensureProxyHeaders(source);

await writeFile(file, source, "utf8");

function ensureProxyConstants(text) {
  if (text.includes("const NETLIFY_DATA_PROXY_BASE")) return text;
  return text.replace(
    'const QUOTE_FIELDS = "f12,f14,f2,f3,f17";',
    [
      'const QUOTE_FIELDS = "f12,f14,f2,f3,f17";',
      'const NETLIFY_DATA_PROXY_BASE = cleanEnvUrl(process.env.NETLIFY_DATA_PROXY_BASE || "");',
      'const NETLIFY_DATA_PROXY_TOKEN = process.env.NETLIFY_DATA_PROXY_TOKEN || process.env.DATA_PROXY_TOKEN || "";'
    ].join("\n")
  );
}

function ensureProxyHotStocks(text) {
  return text.replace(
    /async function fetchAllMarketStocks\(\) \{[\s\S]*?\n\}\n\nasync function fetchEastmoneyMarketStocks/,
    `async function fetchAllMarketStocks() {
  if (NETLIFY_DATA_PROXY_BASE) {
    try {
      return await fetchProxyHotStocks(PRIMARY_CANDIDATE_LIMIT);
    } catch (error) {
      console.warn(\`netlify market-data proxy failed, falling back to direct Eastmoney: \${error.message}\`);
    }
  }
  try {
    return await fetchEastmoneyMarketStocks(PRIMARY_CANDIDATE_LIMIT);
  } catch (error) {
    throw new Error(\`Eastmoney top \${PRIMARY_CANDIDATE_LIMIT} fund-flow source failed: \${error.message}\`);
  }
}

async function fetchProxyHotStocks(limit = PRIMARY_CANDIDATE_LIMIT) {
  const payload = await fetchNetlifyMarketData("hot-stocks", { limit });
  const items = Array.isArray(payload) ? payload : payload.items || payload.stocks;
  if (!Array.isArray(items)) throw new Error("Netlify market-data proxy hot-stocks response missing items");
  return items.map(normalizeProxyStock).filter(Boolean).slice(0, limit);
}

async function fetchEastmoneyMarketStocks`
  );
}

function ensureProxyQuotes(text) {
  return text.replace(
    /async function fetchQuotes\(symbols\) \{[\s\S]*?\n\}\n\nasync function fetchEastmoneyQuotes/,
    `async function fetchQuotes(symbols) {
  let primary = [];
  if (NETLIFY_DATA_PROXY_BASE) {
    try {
      primary = await fetchProxyQuotes(symbols);
    } catch (error) {
      console.warn(\`netlify market-data proxy quotes failed, falling back to direct quotes: \${error.message}\`);
    }
  }
  if (!primary.length) {
    primary = await fetchEastmoneyQuotes(symbols).catch((error) => {
      console.warn(\`eastmoney quote source failed, falling back to sina: \${error.message}\`);
      return [];
    });
  }
  const bySymbol = new Map(primary.map((item) => [item.symbol, item]));
  const missing = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))]
    .filter((symbol) => {
      const quote = bySymbol.get(symbol);
      return !quote || !quote.open || !quote.close || !quote.high || !quote.low;
    });
  if (missing.length) {
    const fallback = await fetchSinaQuotes(missing).catch((error) => {
      console.warn(\`sina quote fallback failed: \${error.message}\`);
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

async function fetchProxyQuotes(symbols) {
  const payload = await fetchNetlifyMarketData("quotes", { symbols: symbols.join(",") });
  const items = Array.isArray(payload) ? payload : payload.items || payload.quotes || payload.stocks;
  if (!Array.isArray(items)) throw new Error("Netlify market-data proxy quotes response missing items");
  return items.map(normalizeProxyQuote).filter(Boolean);
}

async function fetchEastmoneyQuotes`
  );
}

function ensureProxyKline(text) {
  if (text.includes('fetchNetlifyMarketData("kline"')) return text;
  return text.replace(
    "async function fetchKline(symbol) {\n",
    `async function fetchKline(symbol) {
  if (NETLIFY_DATA_PROXY_BASE) {
    try {
      const payload = await fetchNetlifyMarketData("kline", { symbol });
      const rows = Array.isArray(payload) ? payload : payload.items || payload.kline || payload.rows;
      if (!Array.isArray(rows) || !rows.length) throw new Error(\`Netlify market-data proxy kline response missing rows for \${symbol}\`);
      return rows.map(normalizeProxyKline).filter(Boolean);
    } catch (error) {
      console.warn(\`netlify market-data proxy kline failed for \${symbol}, falling back to Yahoo: \${error.message}\`);
    }
  }
`
  );
}

function ensureProxyHelpers(text) {
  if (text.includes("async function fetchNetlifyMarketData")) return text;
  const marker = "\nasync function previousSelectionChange";
  return text.replace(marker, `
async function fetchNetlifyMarketData(resource, params = {}) {
  const url = netlifyMarketDataUrl();
  url.searchParams.set("resource", resource);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return fetchJson(url, {
    headers: NETLIFY_DATA_PROXY_TOKEN
      ? {
          Authorization: \`Bearer \${NETLIFY_DATA_PROXY_TOKEN}\`,
          "x-data-proxy-token": NETLIFY_DATA_PROXY_TOKEN
        }
      : {}
  });
}

function netlifyMarketDataUrl() {
  const base = NETLIFY_DATA_PROXY_BASE;
  if (!base) throw new Error("NETLIFY_DATA_PROXY_BASE is not configured");
  const url = new URL(base);
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/api/market-data";
  } else if (!url.pathname.endsWith("/market-data")) {
    url.pathname = \`\${url.pathname.replace(/\\/$/, "")}/market-data\`;
  }
  url.search = "";
  return url;
}

function normalizeProxyStock(item) {
  const symbol = normalizeSymbol(item.symbol || item.stockSymbol || item.code || item.tsCode);
  if (!symbol) return null;
  const superLargeOrderNetAmount = number(item.superLargeOrderNetAmount ?? item.superLargeOrderAmount);
  const largeOrderNetAmount = number(item.largeOrderNetAmount ?? item.largeOrderAmount);
  return {
    symbol,
    name: String(item.name || item.stockName || item.symbolName || symbol).trim(),
    industry: String(item.industry || item.concept || "").trim(),
    changePct: number(item.changePct ?? item.pctChg ?? item.percent ?? item.chgPct),
    turnoverRate: number(item.turnoverRate ?? item.turnover ?? item.turnover_ratio),
    amount: number(item.amount ?? item.turnoverAmount ?? item.tradeAmount),
    volumeRatio: number(item.volumeRatio ?? item.volRatio ?? item.volume_ratio ?? 1),
    amplitude: number(item.amplitude ?? item.amp ?? item.swing),
    close: number(item.close ?? item.price ?? item.last),
    marketCap: number(item.marketCap ?? item.totalMarketCap),
    mainNetInflow: number(item.mainNetInflow ?? item.mainNetAmount),
    superLargeOrderNetAmount,
    superLargeOrderNetRatio: number(item.superLargeOrderNetRatio),
    largeOrderNetAmount,
    largeOrderNetRatio: number(item.largeOrderNetRatio),
    bigOrderNetAmount: number(item.bigOrderNetAmount ?? superLargeOrderNetAmount + largeOrderNetAmount),
    dataSource: item.dataSource || "netlify-proxy"
  };
}

function normalizeProxyQuote(item) {
  const symbol = normalizeSymbol(item.symbol || item.stockSymbol || item.code || item.tsCode);
  if (!symbol) return null;
  const open = number(item.open);
  const high = number(item.high);
  const low = number(item.low);
  const previousClose = number(item.previousClose ?? item.preClose ?? item.pre_close);
  const close = number(item.close ?? item.price ?? item.last);
  return {
    symbol,
    name: String(item.name || item.stockName || item.symbolName || symbol).trim(),
    changePct: number(item.changePct ?? item.pctChg ?? item.percent ?? item.chgPct),
    open,
    high,
    low,
    previousClose,
    close,
    closeVsOpenPct: item.closeVsOpenPct ?? (open ? ((close - open) / open) * 100 : null)
  };
}

function normalizeProxyKline(row) {
  const date = String(row.date || row.time || row.timestamp || row.tradeDate || "").slice(0, 10);
  const open = number(row.open);
  const high = number(row.high);
  const low = number(row.low);
  const close = number(row.close);
  const volume = number(row.volume ?? row.vol);
  const amount = number(row.amount ?? row.turnoverAmount);
  if (!date || !open || !high || !low || !close) return null;
  return { date, open, high, low, close, volume, amount };
}
${marker}`);
}

function ensureProxyHeaders(text) {
  if (!text.includes("...(options.headers || {})")) {
    text = text.replace(
      /const response = await fetch\(url, \{\n\s*headers: \{\n\s*Accept: "application\/json,text\/plain,\*\/\*",\n\s*Referer: options\.referer \|\| "https:\/\/quote\.eastmoney\.com\/",\n\s*"User-Agent": options\.userAgent \|\| "Mozilla\/5\.0 github-pages-stock-report\/1\.0"\n\s*\}\n\s*\}\);/,
      `const headers = {
        Accept: "application/json,text/plain,*/*",
        Referer: options.referer || "https://quote.eastmoney.com/",
        "User-Agent": options.userAgent || "Mozilla/5.0 github-pages-stock-report/1.0",
        ...(options.headers || {})
      };
      const response = await fetch(url, { headers });`
    );
  }
  if (!text.includes("function cleanEnvUrl")) {
    text = text.replace(
      "\nasync function recordFailureLog",
      `\nfunction cleanEnvUrl(value) {
  return String(value || "").trim().replace(/\\/+$/, "");
}

async function recordFailureLog`
    );
  }
  return text;
}
