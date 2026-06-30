import { readFile, writeFile } from "node:fs/promises";

const file = "src/cli.js";
let source = await readFile(file, "utf8");

const replacements = [
  ['const REPORT_RETENTION_DAYS = 180;', 'const REPORT_RETENTION_DAYS = 90;'],
  [
    'const EASTMONEY_FIELDS = "f12,f14,f2,f3,f6,f7,f8,f10,f62,f66,f69,f72,f75,f100";',
    [
      'const PRIMARY_CANDIDATE_LIMIT = 100;',
      'const EASTMONEY_PAGE_SIZE = 100;',
      'const EASTMONEY_PAGE_DELAY_MS = 1000;',
      'const SINA_PAGE_SIZE = 80;',
      'const SINA_PAGE_DELAY_MS = 450;',
      'const MIN_FULL_MARKET_CANDIDATES = 3000;',
      'const EASTMONEY_FIELDS = "f12,f14,f2,f3,f6,f7,f8,f10,f62,f66,f69,f72,f75,f100";'
    ].join("\n")
  ]
];

for (const [from, to] of replacements) {
  source = source.replace(from, to);
}

source = source.replace(
  /async function fetchAllMarketStocks\(\) \{[\s\S]*?\n\}\n\nasync function fetchMarketPage/,
  `async function fetchAllMarketStocks() {
  try {
    return await fetchEastmoneyMarketStocks(PRIMARY_CANDIDATE_LIMIT);
  } catch (error) {
    throw new Error(\`Eastmoney top \${PRIMARY_CANDIDATE_LIMIT} fund-flow source failed: \${error.message}\`);
  }
}

async function fetchEastmoneyMarketStocks(limit = PRIMARY_CANDIDATE_LIMIT) {
  const first = await fetchMarketPage(1, EASTMONEY_PAGE_SIZE);
  const items = [...first.items];
  const total = Math.min(Number(first.total || items.length), limit);
  const pages = Math.ceil(total / EASTMONEY_PAGE_SIZE);
  for (let page = 2; page <= pages; page += 1) {
    try {
      const next = await fetchMarketPage(page, EASTMONEY_PAGE_SIZE);
      items.push(...next.items);
    } catch (error) {
      console.warn(\`Eastmoney page \${page} failed after retries; keeping \${items.length} fetched candidates: \${error.message}\`);
      break;
    }
    await sleep(EASTMONEY_PAGE_DELAY_MS);
  }
  const bySymbol = new Map();
  for (const item of items.map(normalizeEastmoney).filter(Boolean)) bySymbol.set(item.symbol, item);
  return [...bySymbol.values()].slice(0, limit);
}

async function fetchMarketPage`
);

source = source.replace(
  /async function fetchQuotes\(symbols\) \{[\s\S]*?\n\}\n\nasync function fetchKline/,
  `async function fetchSinaMarketStocks() {
  const items = [];
  for (let page = 1; page <= 90; page += 1) {
    const pageItems = await fetchSinaMarketPage(page, SINA_PAGE_SIZE);
    if (!pageItems.length) break;
    items.push(...pageItems);
    if (pageItems.length < SINA_PAGE_SIZE) break;
    await sleep(SINA_PAGE_DELAY_MS);
  }
  const bySymbol = new Map();
  for (const item of items.map(normalizeSina).filter(Boolean)) bySymbol.set(item.symbol, item);
  return [...bySymbol.values()];
}

async function fetchSinaMarketPage(page, pageSize) {
  const url = new URL("https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData");
  url.searchParams.set("page", String(page));
  url.searchParams.set("num", String(pageSize));
  url.searchParams.set("sort", "amount");
  url.searchParams.set("asc", "0");
  url.searchParams.set("node", "hs_a");
  url.searchParams.set("symbol", "");
  url.searchParams.set("_s_r_a", "init");
  const data = await fetchJson(url, { referer: "https://finance.sina.com.cn/" });
  if (!Array.isArray(data)) throw new Error("Sina response is not an array");
  return data;
}

function mergeStocks(primary, supplement) {
  const bySymbol = new Map();
  for (const stock of primary || []) bySymbol.set(stock.symbol, stock);
  for (const stock of supplement || []) {
    if (!bySymbol.has(stock.symbol)) bySymbol.set(stock.symbol, stock);
  }
  return [...bySymbol.values()];
}

async function fetchQuotes(symbols) {
  const primary = await fetchEastmoneyQuotes(symbols).catch((error) => {
    console.warn(\`eastmoney quote source failed, falling back to sina: \${error.message}\`);
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
  return all.map((item) => {
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
  }).filter((item) => item.symbol);
}

async function fetchSinaQuotes(symbols) {
  const all = [];
  const sinaSymbols = symbols.map(toSinaSymbol).filter(Boolean);
  for (let i = 0; i < sinaSymbols.length; i += 80) {
    const batch = sinaSymbols.slice(i, i + 80);
    const payload = await fetchText(\`https://hq.sinajs.cn/list=\${batch.join(",")}\`, { referer: "https://finance.sina.com.cn/" });
    all.push(...parseSinaQuotePayload(payload));
    await sleep(250);
  }
  return all;
}

async function fetchKline`
);

source = source.replace(
  /function normalizeSina\(item\) \{[\s\S]*?\n\}\n\nfunction parseSinaQuotePayload/,
  `function normalizeSina(item) {
  const symbol = normalizeSymbol(item.symbol || item.code);
  if (!symbol) return null;
  const settlement = number(item.settlement);
  const high = number(item.high);
  const low = number(item.low);
  const amplitude = settlement ? ((high - low) / settlement) * 100 : 0;
  return {
    symbol,
    name: String(item.name || symbol).trim(),
    industry: "",
    changePct: number(item.changepercent),
    turnoverRate: number(item.turnoverratio),
    amount: number(item.amount),
    volumeRatio: 1,
    amplitude,
    close: number(item.trade),
    mainNetInflow: 0,
    superLargeOrderNetAmount: 0,
    superLargeOrderNetRatio: 0,
    largeOrderNetAmount: 0,
    largeOrderNetRatio: 0,
    bigOrderNetAmount: 0,
    dataSource: "sina"
  };
}

function parseSinaQuotePayload`
);

if (!source.includes("function normalizeSina(item)")) {
  const marker = "\nfunction businessConcepts(stock) {";
  source = source.replace(marker, `
function normalizeSina(item) {
  const symbol = normalizeSymbol(item.symbol || item.code);
  if (!symbol) return null;
  const settlement = number(item.settlement);
  const high = number(item.high);
  const low = number(item.low);
  const amplitude = settlement ? ((high - low) / settlement) * 100 : 0;
  return {
    symbol,
    name: String(item.name || symbol).trim(),
    industry: "",
    changePct: number(item.changepercent),
    turnoverRate: number(item.turnoverratio),
    amount: number(item.amount),
    volumeRatio: 1,
    amplitude,
    close: number(item.trade),
    mainNetInflow: 0,
    superLargeOrderNetAmount: 0,
    superLargeOrderNetRatio: 0,
    largeOrderNetAmount: 0,
    largeOrderNetRatio: 0,
    bigOrderNetAmount: 0,
    dataSource: "sina"
  };
}

function parseSinaQuotePayload(payload) {
  const rows = [];
  const pattern = /var hq_str_([a-z]{2}\\d{6})="([^"]*)";/g;
  let match;
  while ((match = pattern.exec(payload))) {
    const symbol = normalizeSymbol(match[1]);
    const fields = match[2].split(",");
    if (!symbol || fields.length < 32 || !fields[0]) continue;
    const open = number(fields[1]);
    const prevClose = number(fields[2]);
    const close = number(fields[3]);
    const high = number(fields[4]);
    const low = number(fields[5]);
    rows.push({
      symbol,
      name: fields[0],
      changePct: prevClose ? ((close - prevClose) / prevClose) * 100 : null,
      open,
      high,
      low,
      previousClose: prevClose,
      close,
      closeVsOpenPct: open ? ((close - open) / open) * 100 : null,
      dataSource: "sina"
    });
  }
  return rows;
}
${marker}`);
}

await writeFile(file, source, "utf8");
