import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const START = "2025-01-01";
const END = process.argv[2] || today();
const CACHE_DIR = "data/backtest-cache";
const OUT_JSON = "outputs/data/reports/backtest-2025.json";
const OUT_HTML = "outputs/backtest-2025.html";
const CONCURRENCY = Number(process.env.BACKTEST_CONCURRENCY || 8);
const MAX_STOCKS = Number(process.env.BACKTEST_MAX_STOCKS || 0);
const FIELDS = "f12,f14,f100";

await mkdir(CACHE_DIR, { recursive: true });
await mkdir("outputs/data/reports", { recursive: true });

const stocks = await fetchStockList();
const universe = MAX_STOCKS ? stocks.slice(0, MAX_STOCKS) : stocks;
console.log(`universe=${universe.length}, start=${START}, end=${END}, concurrency=${CONCURRENCY}`);

const byDate = new Map();
let completed = 0;
await mapLimit(universe, CONCURRENCY, async (stock) => {
  const rows = await loadStockHistory(stock);
  for (const row of rows) {
    if (row.date < START || row.date > END || row.changePct < 0) continue;
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }
  completed += 1;
  if (completed % 100 === 0 || completed === universe.length) {
    console.log(`loaded ${completed}/${universe.length}, dates=${byDate.size}`);
  }
});

const dates = [...byDate.keys()].sort();
const selections = dates.map((date) => {
  const rows = byDate.get(date) || [];
  const top = rows
    .map((stock) => ({ ...stock, heatScore: scoreStock(stock, stock.history) }))
    .sort((a, b) => b.heatScore - a.heatScore)
    .slice(0, 5);
  return { date, stocks: top };
});

const marketByDate = new Map([...byDate.entries()].map(([date, rows]) => [date, new Map(rows.map((row) => [row.symbol, row]))]));
const lateCurve = simulateLate(selections, marketByDate);
const dailyCurve = simulateDaily(selections, marketByDate);
const fundFlowFirstDate = minDate(universe.map((stock) => stock._fundFlowFirstDate).filter(Boolean));
const result = {
  generatedAt: new Date().toISOString(),
  start: START,
  end: END,
  universeCount: universe.length,
  tradingDays: dates.length,
  dataSource: {
    kline: "Eastmoney historical daily kline",
    fundFlow: "Eastmoney individual fund-flow daykline where available",
    limitation: "Free Eastmoney fund-flow endpoint returned only recent rows during validation; earlier dates use real OHLC/turnover/amount/volume metrics with fund-flow fields left at 0."
  },
  fundFlowFirstDate: fundFlowFirstDate || null,
  selectionFundFlowCoverage: fundFlowCoverage(selections),
  late: summarizeCurve(lateCurve),
  daily: summarizeCurve(dailyCurve),
  selections: selections.map((item) => ({
    date: item.date,
    stocks: item.stocks.map(reportStock)
  })),
  lateCurve,
  dailyCurve
};

await writeFile(OUT_JSON, `${JSON.stringify(result, null, 2)}\n`, "utf8");
await writeFile(OUT_HTML, renderHtml(result), "utf8");
console.log(JSON.stringify({
  outJson: OUT_JSON,
  outHtml: OUT_HTML,
  late: result.late,
  daily: result.daily,
  fundFlowFirstDate: result.fundFlowFirstDate
}, null, 2));

async function fetchStockList() {
  const cached = await readJson(join(CACHE_DIR, "stock-list.json"));
  if (cached?.length) return cached;
  const first = await fetchMarketPage(1, 500);
  const pages = Math.ceil(Number(first.total || first.items.length) / 500);
  const items = [...first.items];
  for (let page = 2; page <= pages; page += 1) {
    const next = await fetchMarketPage(page, 500);
    items.push(...next.items);
    await sleep(120);
  }
  const seen = new Map();
  for (const item of items) {
    const symbol = normalizeSymbol(item.f12);
    if (!/^(SH|SZ|BJ)\d{6}$/.test(symbol)) continue;
    if (String(item.f14 || "").includes("退")) continue;
    seen.set(symbol, { symbol, code: symbol.slice(2), name: String(item.f14 || symbol).trim(), industry: String(item.f100 || "").trim() });
  }
  const stocks = [...seen.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  await writeJson(join(CACHE_DIR, "stock-list.json"), stocks);
  return stocks;
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
  url.searchParams.set("fields", FIELDS);
  const data = (await fetchJson(url))?.data;
  if (!Array.isArray(data?.diff)) throw new Error("stock list missing data.diff");
  return { total: data.total, items: data.diff };
}

async function loadStockHistory(stock) {
  const file = join(CACHE_DIR, `${stock.symbol}.json`);
  const cached = await readJson(file);
  if (cached?.end === END && Array.isArray(cached.rows)) {
    stock._fundFlowFirstDate = cached.fundFlowFirstDate || null;
    return cached.rows;
  }
  const [kline, funds] = await Promise.all([
    fetchKline(stock),
    fetchFundFlow(stock).catch(() => [])
  ]);
  const fundMap = new Map(funds.map((row) => [row.date, row]));
  const rows = kline.map((row, index) => {
    const fund = fundMap.get(row.date) || {};
    const history = kline.slice(Math.max(0, index - 119), index + 1).map((item) => ({ close: item.close }));
    const volumeRatio = average(kline.slice(Math.max(0, index - 5), index).map((item) => item.volume));
    return {
      ...stock,
      ...row,
      volumeRatio: volumeRatio ? row.volume / volumeRatio : 1,
      mainNetInflow: fund.mainNetInflow || 0,
      largeOrderNetAmount: fund.largeOrderNetAmount || 0,
      superLargeOrderNetAmount: fund.superLargeOrderNetAmount || 0,
      largeOrderNetRatio: fund.largeOrderNetRatio || 0,
      bigOrderNetAmount: (fund.largeOrderNetAmount || 0) + (fund.superLargeOrderNetAmount || 0),
      history
    };
  });
  const fundFlowFirstDate = minDate(funds.map((row) => row.date));
  stock._fundFlowFirstDate = fundFlowFirstDate;
  await writeJson(file, { symbol: stock.symbol, end: END, fundFlowFirstDate, rows });
  return rows;
}

async function fetchKline(stock) {
  const url = new URL("https://push2his.eastmoney.com/api/qt/stock/kline/get");
  url.searchParams.set("fields1", "f1,f2,f3,f4,f5,f6");
  url.searchParams.set("fields2", "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f116");
  url.searchParams.set("ut", "7eea3edcaed734bea9cbfc24409ed989");
  url.searchParams.set("klt", "101");
  url.searchParams.set("fqt", "0");
  url.searchParams.set("secid", toEastmoneySecid(stock.symbol));
  url.searchParams.set("beg", START.replaceAll("-", ""));
  url.searchParams.set("end", END.replaceAll("-", ""));
  const rows = (await fetchJson(url))?.data?.klines || [];
  return rows.map((line) => {
    const [date, open, close, high, low, volume, amount, amplitude, changePct, changeAmount, turnoverRate] = line.split(",");
    return {
      date,
      open: num(open),
      close: num(close),
      high: num(high),
      low: num(low),
      volume: num(volume),
      amount: num(amount),
      amplitude: num(amplitude),
      changePct: num(changePct),
      turnoverRate: num(turnoverRate)
    };
  }).filter((row) => row.date && row.open && row.close);
}

async function fetchFundFlow(stock) {
  const url = new URL("https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get");
  url.searchParams.set("lmt", "0");
  url.searchParams.set("klt", "101");
  url.searchParams.set("secid", toEastmoneySecid(stock.symbol));
  url.searchParams.set("fields1", "f1,f2,f3,f7");
  url.searchParams.set("fields2", "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65");
  url.searchParams.set("ut", "b2884a393a59ad64002292a3e90d46a5");
  const rows = (await fetchJson(url))?.data?.klines || [];
  return rows.map((line) => {
    const [date, main, small, medium, large, superLarge, mainRatio, smallRatio, mediumRatio, largeRatio, superLargeRatio] = line.split(",");
    return {
      date,
      mainNetInflow: num(main),
      largeOrderNetAmount: num(large),
      superLargeOrderNetAmount: num(superLarge),
      largeOrderNetRatio: num(largeRatio) + num(superLargeRatio)
    };
  }).filter((row) => row.date >= START && row.date <= END);
}

function simulateLate(selections, marketByDate) {
  const curve = [];
  let netValue = 1;
  let cash = 1;
  let holdings = [];
  for (const item of selections) {
    const stockMap = marketByDate.get(item.date) || new Map();
    for (const holding of holdings) {
      const price = stockMap.get(holding.symbol)?.close || holding.entryPrice;
      cash += holding.shares * price;
    }
    netValue = cash;
    const allocation = netValue * 0.2;
    holdings = [];
    for (const stock of item.stocks) {
      if (isLimitUp(stock) || !stock.close) continue;
      if (cash < allocation) continue;
      cash -= allocation;
      holdings.push({ symbol: stock.symbol, name: stock.name, entryPrice: stock.close, shares: allocation / stock.close });
    }
    curve.push({ date: item.date, netValue: round(netValue, 4), cash: round(cash, 6), selected: item.stocks.map(reportStock), holdings: holdings.map((h) => h.symbol) });
  }
  return curve;
}

function simulateDaily(selections, marketByDate) {
  const curve = [];
  let netValue = 1;
  let cash = 1;
  let holdings = [];
  for (let index = 0; index < selections.length; index += 1) {
    const item = selections[index];
    const stockMap = marketByDate.get(item.date) || new Map();
    for (const holding of holdings) {
      const price = stockMap.get(holding.symbol)?.open || holding.entryPrice;
      cash += holding.shares * price;
    }
    netValue = cash;
    const previous = selections[index - 1];
    const allocation = netValue * 0.2;
    holdings = [];
    if (previous) {
      for (const picked of previous.stocks) {
        const stock = stockMap.get(picked.symbol);
        if (!stock?.open) continue;
        const previousClose = stock.changePct === -100 ? 0 : stock.close / (1 + stock.changePct / 100);
        const limitUpPrice = previousClose ? round(previousClose * (1 + limitUpThreshold(stock) / 100), 2) : null;
        let price = stock.open;
        if (limitUpPrice && stock.open >= limitUpPrice - 0.01) {
          price = stock.low < limitUpPrice - 0.01 ? limitUpPrice : null;
        }
        if (!price) continue;
        if (cash < allocation) continue;
        cash -= allocation;
        holdings.push({ symbol: stock.symbol, name: stock.name, entryPrice: price, shares: allocation / price });
      }
    }
    curve.push({ date: item.date, netValue: round(netValue, 4), cash: round(cash, 6), selected: item.stocks.map(reportStock), holdings: holdings.map((h) => h.symbol) });
  }
  return curve;
}

function reportStock(stock) {
  return {
    symbol: stock.symbol,
    name: stock.name,
    heatScore: stock.heatScore,
    changePct: stock.changePct,
    amount: stock.amount,
    turnoverRate: stock.turnoverRate,
    volumeRatio: stock.volumeRatio,
    amplitude: stock.amplitude,
    bigOrderNetAmount: stock.bigOrderNetAmount,
    largeOrderNetRatio: stock.largeOrderNetRatio
  };
}

function scoreStock(stock, history) {
  const amount = clamp(Math.log10(Math.max(stock.amount, 1)) * 9 - 55, 0, 35);
  const change = clamp(stock.changePct * 2.5, 0, 25);
  const turnover = clamp(stock.turnoverRate * 1.8, 0, 15);
  const volume = clamp((stock.volumeRatio - 1) * 6, 0, 12);
  const amplitude = clamp(stock.amplitude * 0.8, 0, 8);
  const bigOrder = clamp(Math.max(stock.bigOrderNetAmount || 0, 0) / 100000000 * 5 + Math.max(stock.largeOrderNetRatio || 0, 0), 0, 20);
  return Math.round(amount + change + turnover + volume + amplitude + bigOrder + trendScore(history));
}

function trendScore(history) {
  if (!Array.isArray(history) || history.length < 20) return 0;
  const last = history.at(-1).close;
  const prev20 = history[Math.max(0, history.length - 20)].close;
  const first = history[0].close;
  return clamp(((last - prev20) / prev20) * 40 + ((last - first) / first) * 10, 0, 20);
}

function isLimitUp(stock) {
  return stock.changePct >= limitUpThreshold(stock) - 0.15;
}

function limitUpThreshold(stock) {
  const name = String(stock.name || "").toUpperCase();
  if (name.includes("ST")) return 5;
  if (stock.symbol.startsWith("BJ")) return 30;
  if (/^(SZ30|SH68|SH69)/.test(stock.symbol)) return 20;
  return 10;
}

function summarizeCurve(curve) {
  const first = curve[0], last = curve.at(-1);
  return {
    startDate: first?.date || null,
    endDate: last?.date || null,
    startNetValue: first?.netValue ?? 1,
    endNetValue: last?.netValue ?? 1,
    totalReturnPct: last ? round((last.netValue / 1 - 1) * 100, 2) : 0,
    maxDrawdownPct: maxDrawdown(curve)
  };
}

function maxDrawdown(curve) {
  let peak = 1;
  let mdd = 0;
  for (const row of curve) {
    peak = Math.max(peak, row.netValue);
    mdd = Math.min(mdd, row.netValue / peak - 1);
  }
  return round(mdd * 100, 2);
}

function fundFlowCoverage(selections) {
  const days = selections.map((item) => ({
    date: item.date,
    count: item.stocks.filter((stock) => Number(stock.bigOrderNetAmount)).length
  }));
  const daysWithAnyFundFlow = days.filter((item) => item.count > 0);
  return {
    days: days.length,
    daysWithAnyFundFlow: daysWithAnyFundFlow.length,
    firstDateWithAnyFundFlow: daysWithAnyFundFlow[0]?.date || null,
    lastDateWithoutFundFlow: [...days].reverse().find((item) => item.count === 0)?.date || null
  };
}

function renderHtml(result) {
  const payload = JSON.stringify(result).replaceAll("</", "<\\/");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>2025 至今模拟盘回测</title>
<style>body{margin:0;background:#eef2f6;color:#17202c;font-family:"Microsoft YaHei",Arial,sans-serif}main{max-width:1180px;margin:0 auto;padding:24px}h1{margin:0 0 12px}.meta,.panel{background:#fff;border:1px solid #d8dee8;border-radius:8px;box-shadow:0 10px 28px rgba(26,32,44,.08);padding:16px;margin-bottom:14px}.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.card{background:#fff;border:1px solid #d8dee8;border-radius:8px;padding:14px}.card span{display:block;color:#667085;font-size:13px}.card b{font-size:26px}canvas{width:100%;height:420px;background:#fbfcfe;border:1px solid #e2e7ef;border-radius:8px}.warn{color:#92400e;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:10px 12px;line-height:1.6}@media(max-width:640px){main{padding:16px}.cards{grid-template-columns:1fr}}</style></head>
<body><main><h1>2025 至今模拟盘回测</h1><div class="meta"><div>区间：${result.start} 至 ${result.end}；股票数：${result.universeCount}；交易日：${result.tradingDays}</div><div class="warn">说明：历史日行情为真实东方财富数据；免费资金流接口在 Top5 中有资金流覆盖的交易日为 ${result.selectionFundFlowCoverage.daysWithAnyFundFlow}/${result.selectionFundFlowCoverage.days}，最早覆盖 ${result.selectionFundFlowCoverage.firstDateWithAnyFundFlow || "无"}。无资金流日期不伪造，按 0 参与原评分公式。尾盘回测使用当日行情信号，结果天然偏乐观。</div></div>
<div class="cards"><div class="card"><span>尾盘模拟盘最终净值</span><b>${result.late.endNetValue}</b><span>收益 ${result.late.totalReturnPct}% / 最大回撤 ${result.late.maxDrawdownPct}%</span></div><div class="card"><span>日报模拟盘最终净值</span><b>${result.daily.endNetValue}</b><span>收益 ${result.daily.totalReturnPct}% / 最大回撤 ${result.daily.maxDrawdownPct}%</span></div></div>
<div class="panel"><canvas id="chart" width="1180" height="520"></canvas></div></main>
<script>const DATA=${payload};const c=document.getElementById('chart'),x=c.getContext('2d'),w=c.width,h=c.height,p={l:58,r:24,t:24,b:42};const rows=DATA.lateCurve.map((r,i)=>({date:r.date,late:r.netValue,daily:DATA.dailyCurve[i]?.netValue}));const vals=rows.flatMap(r=>[r.late,r.daily]).filter(Number.isFinite);const mn=Math.min(...vals,1)*.98,mx=Math.max(...vals,1)*1.02,span=mx-mn||1;const y=v=>p.t+(mx-v)/span*(h-p.t-p.b),px=i=>p.l+i/(rows.length-1)*(w-p.l-p.r);x.clearRect(0,0,w,h);x.fillStyle='#fbfcfe';x.fillRect(0,0,w,h);x.strokeStyle='#e4e9f0';x.fillStyle='#657082';x.font='12px Arial';for(let k=0;k<=5;k++){const gy=p.t+k*(h-p.t-p.b)/5;x.beginPath();x.moveTo(p.l,gy);x.lineTo(w-p.r,gy);x.stroke();x.fillText((mx-k*span/5).toFixed(3),8,gy+4)}function line(key,color){x.strokeStyle=color;x.lineWidth=2;x.beginPath();rows.forEach((r,i)=>{const yy=y(r[key]);if(i)x.lineTo(px(i),yy);else x.moveTo(px(i),yy)});x.stroke()}line('late','#d84b47');line('daily','#1769aa');x.fillStyle='#d84b47';x.fillRect(p.l,12,18,4);x.fillText('尾盘',p.l+24,18);x.fillStyle='#1769aa';x.fillRect(p.l+74,12,18,4);x.fillText('日报',p.l+98,18);x.fillStyle='#657082';x.fillText(rows[0]?.date||'',p.l,h-14);x.fillText(rows.at(-1)?.date||'',w-p.r-80,h-14);</script></body></html>`;
}

async function mapLimit(items, limit, task) {
  const executing = new Set();
  for (const item of items) {
    const promise = Promise.resolve().then(() => task(item)).finally(() => executing.delete(promise));
    executing.add(promise);
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
}

async function fetchJson(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json,text/plain,*/*", Referer: "https://quote.eastmoney.com/", "User-Agent": "Mozilla/5.0 backtest-stock-report/1.0" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    } catch (error) {
      lastError = error;
      await sleep(500 + attempt * 500);
    }
  }
  throw lastError;
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeSymbol(symbol) {
  const raw = String(symbol || "").trim().toUpperCase().replace(".", "");
  if (/^(SH|SZ|BJ)\d{6}$/.test(raw)) return raw;
  if (/^6\d{5}$/.test(raw)) return `SH${raw}`;
  if (/^[038]\d{5}$/.test(raw)) return `SZ${raw}`;
  if (/^[492]\d{5}$/.test(raw)) return `BJ${raw}`;
  return raw;
}

function toEastmoneySecid(symbol) {
  const normalized = normalizeSymbol(symbol);
  const code = normalized.slice(2);
  if (normalized.startsWith("SH")) return `1.${code}`;
  if (normalized.startsWith("SZ") || normalized.startsWith("BJ")) return `0.${code}`;
  return "";
}

function num(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function average(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : 0;
}

function minDate(values) {
  return values.length ? values.sort()[0] : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function round(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}
