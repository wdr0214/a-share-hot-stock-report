export const BENCHMARKS = Object.freeze([
  { id: "csi300", name: "沪深300", symbol: "000300.SH", currency: "CNY", color: "#087443" },
  { id: "nasdaq", name: "纳斯达克综合", symbol: "^IXIC", currency: "USD", color: "#b7791f" }
]);

export function isoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const time = Date.parse(value + "T12:00:00Z");
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function reportCutoff(date, time = "14:53") {
  if (!isoDate(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Invalid report cutoff");
  return Date.parse(`${date}T${time}:00+08:00`);
}

export function normalizeBenchmarks(payload) {
  if (payload?.version !== 1 || !Array.isArray(payload.series)) throw new Error("指数数据格式不正确");
  return {
    ...payload,
    series: BENCHMARKS.map(expected => {
      const entry = payload.series.find(item => item.id === expected.id);
      if (!entry) return { ...expected, status: "unavailable", rows: [] };
      if (entry.symbol !== expected.symbol || entry.currency !== expected.currency) throw new Error("指数代码或币种不匹配");
      const byDate = new Map();
      for (const row of entry.rows || []) {
        if (!isoDate(row.date) || row.close === null || row.close === "" || !Number.isFinite(Number(row.close)) || Number(row.close) <= 0 || !Number.isFinite(Date.parse(row.availableAt))) continue;
        if (byDate.has(row.date) && byDate.get(row.date).close !== Number(row.close)) throw new Error("指数同日数据不一致");
        byDate.set(row.date, { date: row.date, close: Number(row.close), availableAt: new Date(row.availableAt).toISOString() });
      }
      return { ...entry, ...expected, rows: [...byDate.values()].sort((a, b) => Date.parse(a.availableAt) - Date.parse(b.availableAt)) };
    })
  };
}

export function completedCloseAt(rows, cutoff) {
  let left = 0, right = rows.length - 1, result = null;
  while (left <= right) {
    const mid = (left + right) >> 1, row = rows[mid];
    if (Date.parse(row.availableAt) <= cutoff) { result = row; left = mid + 1; } else right = mid - 1;
  }
  // Do not draw an indefinitely flat benchmark when a feed has stopped updating.
  return result && cutoff - Date.parse(result.availableAt) <= 14 * 86400000 ? result : null;
}

export function buildComparison(items, report, payload) {
  if (!items.length) return [];
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(report.executionTime || "") ? report.executionTime : "14:53";
  const initial = Number(items[0].netValue);
  const strategy = { id: "strategy", name: "策略", color: "#1769aa", status: "ok", rows: items.map(point => ({ date: point.date, value: Number(point.netValue) / initial })) };
  const indexes = normalizeBenchmarks(payload || { version: 1, series: [] }).series.map(index => {
    const baseline = completedCloseAt(index.rows, reportCutoff(items[0].date, time));
    return { ...index, baselineDate: baseline?.date || null, rows: items.map(point => {
      const source = completedCloseAt(index.rows, reportCutoff(point.date, time));
      return { date: point.date, value: baseline && source ? source.close / baseline.close : null, sourceDate: source?.date || null, close: source?.close ?? null };
    }) };
  });
  return [strategy, ...indexes];
}
