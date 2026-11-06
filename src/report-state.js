import { isDeepStrictEqual } from "node:util";

const OWNERS = {
  late: { reports: "lateReports", portfolio: "latePortfolio" },
  "etf-rotation": { reports: "etfRotationReports", portfolio: "etfRotationPortfolio" }
};

export function mergeGeneratedReport({ current, snapshot, generated, type, date }) {
  const owner = OWNERS[type];
  if (!owner) throw new Error("Unsupported report owner");
  const currentReport = current[owner.reports]?.[date];
  const report = generated[owner.reports]?.[date];
  if (type === "etf-rotation" && currentReport?.status === "ok") {
    validateEtfState(currentReport, current.etfRotationPortfolio);
    return { db: current, alreadyPublished: true };
  }
  if (!isDeepStrictEqual(current[owner.portfolio] ?? null, snapshot[owner.portfolio] ?? null)
      || !isDeepStrictEqual(current[owner.reports]?.[date], snapshot[owner.reports]?.[date])) {
    const error = new Error("Same report portfolio changed concurrently; regenerate from the latest state");
    error.code = "REPORT_STATE_CONFLICT";
    throw error;
  }
  if (report?.date !== date || report.status !== "ok") throw new Error("Requested report was not generated successfully");
  if (type === "etf-rotation") {
    validateEtfState(report, generated.etfRotationPortfolio);
    const before = (snapshot.etfRotationPortfolio?.history || []).filter(item => item.date !== date);
    const after = generated.etfRotationPortfolio.history.filter(item => item.date !== date);
    if (!isDeepStrictEqual(before, after)) throw new Error("ETF net value history changed unexpectedly");
  }
  const oldLogs = new Set((snapshot.jobLogs || []).map(logKey));
  const addedLogs = (generated.jobLogs || []).filter(item => !oldLogs.has(logKey(item)));
  const logs = new Map([...(current.jobLogs || []), ...addedLogs].map(item => [logKey(item), item]));
  // Each generator owns one report type only. Preserve the other writer's state.
  return { db: {
    ...current,
    [owner.reports]: { ...(current[owner.reports] || {}), [date]: report },
    [owner.portfolio]: generated[owner.portfolio] ?? null,
    jobLogs: [...logs.values()].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))).slice(-200)
  }, alreadyPublished: false };
}

function validateEtfState(report, portfolio) {
  if (!(Number.isFinite(report.netValue) && report.netValue > 0)
      || !Array.isArray(report.etfs) || report.etfs.length !== 6
      || new Set(report.etfs.map(item => item.symbol)).size !== 6
      || report.etfs.some(item => !(Number.isFinite(item.price) && item.price > 0))) {
    throw new Error("ETF report prices or net value are incomplete");
  }
  const point = portfolio?.history?.find(item => item.date === report.date);
  if (!point || point.netValue !== report.netValue || portfolio.netValue !== report.netValue
      || !isDeepStrictEqual(report.holding, portfolio.holding)
      || !isDeepStrictEqual(report.portfolioHistory, portfolio.history)) {
    throw new Error("ETF report and portfolio history are inconsistent");
  }
}

function logKey(item) {
  return JSON.stringify([item.jobName, item.reportKey, item.startedAt, item.finishedAt, item.status]);
}
