import { BENCHMARKS, normalizeBenchmarks, buildComparison } from "./etf-benchmark-model.js";

export const WINDOW_SIZE = 20;
const MONTHS = { "1m": 1, "6m": 6, "1y": 12 };
const finitePositive = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) && Number(value) > 0;
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = value => Number(value).toFixed(4);

export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(value + "T12:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function monthsBefore(date, months) {
  if (!validDate(date) || !Number.isInteger(months) || months < 0) throw new Error("时间范围无效");
  const [year, month, day] = date.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month - months, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1 - months, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

export function normalizeReport(report, requestedDate = null) {
  if (report?.type !== "etf-rotation" || report.status !== "ok" || !validDate(report.date) || !finitePositive(report.netValue) || (requestedDate && report.date !== requestedDate)) throw new Error("报告日期或净值数据不完整");
  const byDate = new Map();
  for (const point of report.portfolioHistory || []) {
    if (!validDate(point.date) || point.date > report.date || !finitePositive(point.netValue)) continue;
    if (byDate.has(point.date) && Number(byDate.get(point.date).netValue) !== Number(point.netValue)) throw new Error("同一天出现不一致的净值记录");
    byDate.set(point.date, { ...point, netValue: Number(point.netValue) });
  }
  const current = byDate.get(report.date);
  if (current && Math.abs(current.netValue - Number(report.netValue)) > 1e-8) throw new Error("报告净值与历史记录不一致");
  byDate.set(report.date, { ...current, date: report.date, netValue: Number(report.netValue), holding: report.holding?.symbol || null, rebalanced: current?.rebalanced || Boolean(report.rebalance?.length), trades: Array.isArray(current?.trades) ? current.trades : report.rebalance || [] });
  return { ...report, portfolioHistory: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

export function selectWindow(report, period = "20", start = null) {
  const all = report.portfolioHistory;
  if (period === "20") {
    const maxStart = Math.max(0, all.length - WINDOW_SIZE);
    const windowStart = Math.min(maxStart, Math.max(0, Number.isFinite(start) ? Math.round(start) : maxStart));
    return { all, items: all.slice(windowStart, windowStart + WINDOW_SIZE), windowStart, maxStart };
  }
  if (!MONTHS[period]) throw new Error("不支持的时间范围");
  const cutoff = monthsBefore(report.date, MONTHS[period]);
  return { all, items: all.filter(point => point.date >= cutoff), windowStart: 0, maxStart: 0 };
}

export async function loadCurveReport(date, fetchImpl = fetch) {
  if (date && !validDate(date)) throw new Error("报告日期无效");
  const path = date ? `data/reports/etf-rotation/${date}.json` : "data/reports/etf-rotation-latest.json";
  const response = await fetchImpl(path, { cache: "no-store", signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(response.status === 404 ? "该日期暂无净值报告" : "净值数据暂时无法读取");
  return normalizeReport(await response.json(), date);
}

export function mountCurvePage() {
  const $ = id => document.getElementById(id);
  let report, period = "20", start = null, selectedDate = null, drag = null, hits = [];
  const tradeCache = new Map();
  let benchmarkData = null, benchmarkLoading = true;
  const nameFor = symbol => report.etfs?.find(item => item.symbol === symbol)?.name || symbol || "空仓";

  async function showDetail(point) {
    selectedDate = point.date;
    $("detail").hidden = false;
    $("detail").innerHTML = `<h2>${esc(point.date)} · 净值 ${fmt(point.netValue)}</h2><p>正在读取调仓明细……</p>`;
    draw();
    let trades = point.trades;
    if (!Array.isArray(trades) || !trades.length) {
      try {
        if (!tradeCache.has(point.date)) tradeCache.set(point.date, loadCurveReport(point.date));
        trades = (await tradeCache.get(point.date)).rebalance;
      } catch { trades = []; }
    }
    if (selectedDate !== point.date) return;
    const rows = (trades || []).filter(trade => ["buy", "sell"].includes(trade.action) && finitePositive(trade.price));
    const heading = `<h2>${esc(point.date)} · 净值 ${fmt(point.netValue)}</h2><p>调仓后持仓：${esc(nameFor(point.holding))}</p>`;
    $("detail").innerHTML = heading + (rows.length ? rows.map(trade => {
      const hasReturn = trade.returnPct !== null && trade.returnPct !== undefined && trade.returnPct !== "" && Number.isFinite(Number(trade.returnPct));
      const gain = trade.action === "sell" && hasReturn ? `<small>${Number(trade.returnPct) >= 0 ? "+" : ""}${Number(trade.returnPct).toFixed(2)}%${trade.returnBasis === "price_plus_cash_dividend" ? "（含现金分红）" : ""}</small>` : "";
      return `<div class="trade"><div><b class="${trade.action}">${trade.action === "buy" ? "买入" : "卖出"} ${esc(trade.name || nameFor(trade.symbol))}</b><small>${esc(trade.symbol)}</small></div><div class="price">${Number(trade.price).toFixed(3)}${gain}</div></div>`;
    }).join("") : "<p>该历史日期未保存可用的成交明细。</p>");
  }

  function draw() {
    if (!report) return;
    const { all, items, windowStart, maxStart } = selectWindow(report, period, start);
    start = windowStart;
    const canvas = $("chart"), ctx = canvas.getContext("2d"), width = canvas.clientWidth, height = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height);
    const p = { left: 56, right: 19, top: 23, bottom: 36 };
    const comparisons = buildComparison(items, report, benchmarkData);
    const visible = comparisons.filter(series => series.id === "strategy" || $(series.id + "Enabled").checked);
    const values = visible.flatMap(series => series.rows.map(row => row.value).filter(value => value !== null && Number.isFinite(value)));
    const low = Math.min(...values), high = Math.max(...values);
    const padding = Math.max((high - low) * 0.12, Math.abs(high) * 0.003, 0.0001);
    const min = low - padding, max = high + padding;
    const x = i => p.left + (items.length === 1 ? 0.5 : i / (items.length - 1)) * (width - p.left - p.right);
    const y = value => p.top + (max - value) / (max - min) * (height - p.top - p.bottom);
    ctx.font = "11px Arial"; ctx.fillStyle = "#65706c"; ctx.strokeStyle = "#e5ebe7"; ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      const value = max - (max - min) * i / 4, yy = y(value);
      ctx.beginPath(); ctx.moveTo(p.left, yy); ctx.lineTo(width - p.right, yy); ctx.stroke();
      ctx.fillText(fmt(value), 5, yy + 4);
    }
    for (const series of [...visible].reverse()) {
      ctx.strokeStyle = series.color; ctx.lineWidth = series.id === "strategy" ? 2.2 : 1.7;
      ctx.setLineDash(series.id === "csi300" ? [6, 3] : series.id === "nasdaq" ? [2, 3] : []);
      ctx.beginPath(); let connected = false;
      series.rows.forEach((point, i) => {
        if (point.value === null || !Number.isFinite(point.value)) { connected = false; return; }
        if (connected) ctx.lineTo(x(i), y(point.value)); else ctx.moveTo(x(i), y(point.value));
        connected = true;
      });
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (items.length === 1) { ctx.fillStyle = "#1769aa"; ctx.beginPath(); ctx.arc(x(0), y(1), 3, 0, Math.PI * 2); ctx.fill(); }
    hits = [];
    items.forEach((point, i) => {
      if (!point.rebalanced && !point.trades?.length) return;
      const hit = { x: x(i), y: y(comparisons[0].rows[i].value), point }; hits.push(hit);
      ctx.fillStyle = "#b42318"; ctx.beginPath(); ctx.arc(hit.x, hit.y, 4, 0, Math.PI * 2); ctx.fill();
    });
    const shortDate = value => width < 500 ? value.slice(5) : value;
    ctx.fillStyle = "#65706c"; ctx.textAlign = "left"; ctx.fillText(shortDate(items[0].date), p.left, height - 11);
    ctx.textAlign = "right"; ctx.fillText(shortDate(items.at(-1).date), width - p.right, height - 11); ctx.textAlign = "left";
    $("markers").replaceChildren(...hits.map(hit => {
      const button = document.createElement("button");
      button.type = "button"; button.className = "trade-point";
      button.style.left = (hit.x / width * 100) + "%"; button.style.top = (hit.y / height * 100) + "%";
      button.title = hit.point.date + " 调仓"; button.setAttribute("aria-label", button.title);
      button.setAttribute("aria-pressed", String(selectedDate === hit.point.date));
      button.onclick = () => { if (!drag?.moved) void showDetail(hit.point); };
      return button;
    }));
    canvas.setAttribute("aria-label", `${items[0].date}至${items.at(-1).date}，${items.length}个净值记录，${hits.length}个调仓点`);
    $("rangeDates").textContent = `${items[0].date} — ${items.at(-1).date} · ${items.length} 个交易日`;
    $("historyExtent").textContent = "历史起点 " + all[0].date;
    $("navigation").hidden = period !== "20";
    $("window").max = String(maxStart); $("window").value = String(windowStart); $("window").disabled = maxStart === 0;
    $("earlier").disabled = windowStart === 0; $("later").disabled = windowStart === maxStart;
    const sourceNotes = [];
    for (const series of comparisons) {
      const last = series.id === "nasdaq" ? series.rows.findLast(row => row.value !== null) : series.rows.at(-1);
      const available = series.rows.some(row => row.value !== null);
      const value = last?.value;
      $(series.id + "Return").textContent = value === null || value === undefined ? "暂无数据" : `${value >= 1 ? "+" : ""}${((value - 1) * 100).toFixed(2)}%`;
      if (series.id === "strategy") continue;
      $(series.id + "Enabled").disabled = !available;
      const cacheBehind = benchmarkData?.reportDate && benchmarkData.reportDate < report.date;
      sourceNotes.push(`${series.name}：${series.source || "暂无数据源"}${last?.sourceDate ? "，收盘日 " + last.sourceDate : "，历史数据不足"}${series.status === "stale" || cacheBehind ? "（缓存未更新）" : ""}`);
    }
    $("benchmarkStatus").textContent = benchmarkLoading ? "正在读取指数对比数据……" : sourceNotes.join("；");
  }

  function moveWindow(nextStart) { start = nextStart; selectedDate = null; $("detail").hidden = true; draw(); }
  document.querySelectorAll("[data-period]").forEach(button => button.addEventListener("click", () => {
    period = button.dataset.period; start = null; selectedDate = null; $("detail").hidden = true;
    document.querySelectorAll("[data-period]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
    draw();
  }));
  $("earlier").onclick = () => moveWindow(start - WINDOW_SIZE);
  $("later").onclick = () => moveWindow(start + WINDOW_SIZE);
  $("window").addEventListener("input", event => moveWindow(Number(event.target.value)));
  for (const benchmark of BENCHMARKS) $(benchmark.id + "Enabled").addEventListener("change", draw);
  $("plot").addEventListener("pointerdown", event => {
    if (!report || event.button > 0) return;
    drag = { x: event.clientX, y: event.clientY, start, moved: false };
    $("plot").setPointerCapture?.(event.pointerId); $("plot").classList.add("dragging");
  });
  $("plot").addEventListener("pointermove", event => {
    if (!drag || !report) return;
    const delta = event.clientX - drag.x;
    if (Math.abs(delta) > 8 || Math.abs(event.clientY - drag.y) > 8) drag.moved = true;
    if (period === "20" && Math.abs(delta) > 8) {
      const step = Math.max(8, ($("chart").clientWidth - 75) / (WINDOW_SIZE - 1));
      start = drag.start - Math.round(delta / step); selectedDate = null; $("detail").hidden = true; draw();
    }
  });
  $("plot").addEventListener("pointerup", event => {
    if (!drag) return;
    const moved = drag.moved;
    $("plot").classList.remove("dragging");
    if (!moved) {
      const rect = $("chart").getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
      const hit = hits.map(item => ({ ...item, distance: Math.hypot(item.x - x, item.y - y) })).sort((a, b) => a.distance - b.distance)[0];
      if (hit?.distance <= 22) void showDetail(hit.point);
    }
    setTimeout(() => { drag = null; }, 0);
  });
  $("plot").addEventListener("pointercancel", () => { drag = null; $("plot").classList.remove("dragging"); });

  async function load() {
    $("loading").hidden = false; $("error").hidden = true; $("content").hidden = true;
    benchmarkData = null; benchmarkLoading = true;
    try {
      const date = new URLSearchParams(location.search).get("date");
      report = await loadCurveReport(date);
      $("netValue").textContent = fmt(report.netValue);
      $("reportDate").textContent = "截至 " + report.date;
      $("holding").textContent = report.holding ? nameFor(report.holding.symbol) : "空仓";
      $("content").hidden = false; draw();
      try {
        const response = await fetch("data/etf-benchmarks.json", { cache: "no-store", signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error("Benchmark data unavailable");
        benchmarkData = normalizeBenchmarks(await response.json());
      } catch { benchmarkData = null; }
      finally { benchmarkLoading = false; draw(); }
    } catch (error) { $("errorMessage").textContent = error.message || "净值数据暂时无法读取"; $("error").hidden = false; }
    finally { $("loading").hidden = true; }
  }
  $("retry").onclick = load;
  new ResizeObserver(() => { if (report && !$("content").hidden) draw(); }).observe($("plot"));
  void load();
}

if (typeof document !== "undefined") mountCurvePage();
