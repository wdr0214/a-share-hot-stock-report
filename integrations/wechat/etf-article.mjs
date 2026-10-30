const SOURCE_ROOT = "https://raw.githubusercontent.com/wdr0214/a-share-hot-stock-report/main/outputs/data/reports";
export const LEGACY_REPORT_URL = "https://wdr0214.github.io/a-share-hot-stock-report/etf-rotation.html";
export const REPORT_URL = "https://wdr0214.github.io/a-share-hot-stock-report/etf-net-value.html";
export const REPORT_SCHEMA_VERSION = "nullable-rebalance-v1";

export function shanghaiDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "") || new Date(value + "T12:00:00Z").toISOString().slice(0, 10) !== value) {
    throw new Error("报告日期必须是有效的 YYYY-MM-DD");
  }
  return value;
}

function finite(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

export function validateReport(report, date) {
  validateDate(date);
  if (report?.type !== "etf-rotation" || report?.date !== date || report?.status !== "ok") throw new Error("报告类型、日期或生成状态不正确，停止生成公众号文章");
  if (!finite(report.netValue) || Number(report.netValue) <= 0) throw new Error("缺少有效的策略净值");
  if (!Array.isArray(report.etfs) || report.etfs.length !== 6) throw new Error("ETF 报告必须包含 6 个标的");
  const symbols = new Set();
  for (const row of report.etfs) {
    if (!/^(SH|SZ)\d{6}$/.test(row.symbol || "") || !row.name || !finite(row.price) || Number(row.price) <= 0 || !finite(row.momentum20Pct) || !finite(row.ma28)) throw new Error("ETF 价格或指标不完整");
    if (symbols.has(row.symbol)) throw new Error("ETF 标的重复");
    symbols.add(row.symbol);
  }
  if (report.holding && !symbols.has(report.holding.symbol)) throw new Error("持仓标的不在 ETF 列表中");
  if (!report.parameters?.momentumDays || !report.parameters?.maDays) throw new Error("缺少策略参数");
  if (report.rebalance != null && !Array.isArray(report.rebalance)) throw new Error("调仓记录格式不正确");
  for (const trade of report.rebalance || []) {
    if (!["buy", "sell"].includes(trade.action) || !symbols.has(trade.symbol) || !finite(trade.price) || Number(trade.price) <= 0) throw new Error("调仓记录不完整");
  }
  return report;
}

export async function loadReport(date, { fetchImpl = fetch } = {}) {
  validateDate(date);
  const day = new Date(date + "T12:00:00+08:00").getUTCDay();
  if (day === 0 || day === 6) return null;
  const response = await fetchImpl(`${SOURCE_ROOT}/etf-rotation/${date}.json`, { cache: "no-store", signal: AbortSignal.timeout(20000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`ETF 报告读取失败 HTTP ${response.status}`);
  return validateReport(await response.json(), date);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const price = value => finite(value) ? Number(value).toFixed(3) : "暂无数据";
const pct = value => finite(value) ? `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(2)}%` : "暂无数据";
const paragraph = text => `<p style="margin:10px 0;line-height:1.8;">${text}</p>`;

export function createArticle(report, { author = "", thumbMediaId = "" } = {}) {
  validateReport(report, report.date);
  const history = (report.portfolioHistory || []).filter(p => p.date < report.date && finite(p.netValue) && Number(p.netValue) > 0).sort((a, b) => a.date.localeCompare(b.date));
  const previous = history.at(-1);
  const dailyChange = previous ? (Number(report.netValue) / Number(previous.netValue) - 1) * 100 : null;
  const holding = report.holding ? `${esc(report.holding.name || report.holding.symbol)}（${esc(report.holding.symbol)}）` : "现金，无 ETF 持仓";
  const title = `ETF轮动报告｜${report.date}`;
  const cell = (text, header = false) => `<${header ? "th" : "td"} style="border-bottom:1px solid #d8dee8;padding:8px 5px;text-align:left;font-size:13px;">${text}</${header ? "th" : "td"}>`;
  const rows = report.etfs.map(row => `<tr>${cell(`${esc(row.name)}<br>${esc(row.symbol)}`)}${cell(price(row.price))}${cell(pct(row.momentum20Pct))}${cell(price(row.ma28))}</tr>`).join("");
  const trades = (report.rebalance || []).map(trade => paragraph(`${trade.action === "buy" ? "买入" : "卖出"}：${esc(trade.name || trade.symbol)}（${esc(trade.symbol)}），成交价 ${price(trade.price)}${trade.action === "sell" && finite(trade.returnPct) ? `，该笔收益 ${pct(trade.returnPct)}${trade.returnBasis === "price_plus_cash_dividend" ? "（含现金分红）" : ""}` : ""}`)).join("");
  const sources = [...new Set(report.etfs.map(row => row.quoteSource).filter(Boolean))].join("、") || "报告未披露";
  const basis = report.executionPriceBasis === "daily_close_backfill" || report.executionPriceBasis === "close-backfill" ? "历史收盘价补报" : `${esc(report.executionTime || "14:53")} 报告时点行情`;
  const body = `<section style="font-family:Arial,'Microsoft YaHei',sans-serif;color:#17202c;font-size:15px;line-height:1.8;">` +
    paragraph(`<strong>${esc(report.date)} · ${basis}</strong>`) +
    paragraph(`<strong>策略净值：${Number(report.netValue).toFixed(4)}</strong>${dailyChange === null ? "" : `<br>较上一报告日：${pct(dailyChange)}（${esc(previous.date)}）`}`) +
    paragraph(`<strong>当前持仓：</strong>${holding}`) +
    `<h3 style="font-size:17px;margin:20px 0 8px;">6 个 ETF 的价格与指标</h3>` +
    `<table style="width:100%;border-collapse:collapse;table-layout:fixed;"><thead><tr>${["标的", "价格", `${Number(report.parameters.momentumDays)}日涨幅`, `${Number(report.parameters.maDays)}日均线`].map(t => cell(t, true)).join("")}</tr></thead><tbody>${rows}</tbody></table>` +
    `<h3 style="font-size:17px;margin:20px 0 8px;">当日调仓</h3>${trades || paragraph("今日未调仓。")}` +
    paragraph(`行情来源：${esc(sources)}。生成时间：${esc(report.generatedAt || "未披露")}。`) +
    paragraph("本报告记录既定策略的模拟持仓与交易，不代表实际成交。历史模拟收益不代表未来表现，不构成投资建议。") +
    paragraph("点击文末“阅读原文”可查看策略净值曲线及历史调仓。") + `</section>`;
  return {
    title, author: String(author).slice(0, 8), digest: `${report.date} ETF轮动：净值 ${Number(report.netValue).toFixed(4)}，${report.holding ? "持仓 " + (report.holding.name || report.holding.symbol) : "持有现金"}。`,
    content: body, content_source_url: `${REPORT_URL}?date=${encodeURIComponent(report.date)}`, thumb_media_id: thumbMediaId,
    need_open_comment: 0, only_fans_can_comment: 0
  };
}
