import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mergeGeneratedReport } from "../src/report-state.js";
import { isDeepStrictEqual } from "node:util";

const REPO = process.env.GITHUB_REPORT_REPO || "wdr0214/a-share-hot-stock-report";
const BRANCH = process.env.GITHUB_REPORT_BRANCH || "main";
const API_BASE = "https://api.github.com";
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_A_SHARE_CLOSED_DATES = new Set([
  // 2025 exchange holiday weekdays.
  "2025-01-01",
  "2025-01-28", "2025-01-29", "2025-01-30", "2025-01-31", "2025-02-03", "2025-02-04",
  "2025-04-04",
  "2025-05-01", "2025-05-02", "2025-05-05",
  "2025-06-02",
  "2025-10-01", "2025-10-02", "2025-10-03", "2025-10-06", "2025-10-07", "2025-10-08",
  // 2026 known/planned mainland market holiday weekdays. Override with
  // A_SHARE_CLOSED_DATES if the exchange publishes later adjustments.
  "2026-01-01",
  "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-23",
  "2026-04-06",
  "2026-05-01", "2026-05-04", "2026-05-05",
  "2026-06-19",
  "2026-09-25",
  "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"
]);

export const runtimeConfig = {
  maxDuration: 60
};

export async function handleReportJob(req, res, type, { defer } = {}) {
  try {
    assertAuthorized(req);
    if (["daily", "weekly"].includes(type)) {
      return res.status(200).json({
        ok: true,
        runtime: "vercel",
        type,
        skipped: true,
        reason: "report_type_retired",
        message: "Daily and weekly reports have been retired; no data was generated or written."
      });
    }
    if (!["late", "etf-rotation"].includes(type)) {
      return res.status(400).json({ ok: false, error: "unsupported report type" });
    }

    const date = String(req.query?.date || shanghaiDate()).slice(0, 10);
    const tradingDate = getAshareTradingDateStatus(date);
    if (!tradingDate.isTradingDate) {
      return res.status(200).json({
        ok: true,
        runtime: "vercel",
        type,
        date,
        skipped: true,
        reason: tradingDate.reason,
        message: "Not an A-share trading date; report generation and GitHub writeback skipped."
      });
    }

    if (type === "etf-rotation" && defer) {
      const job = executeReportJob(req, type, date).catch(async (error) => {
        console.error("ETF report job failed", { date, error: error.message });
        await writeFilesToGitHub([{
          path: "outputs/data/reports/etf-rotation-job.json",
          content: JSON.stringify({ type, date, status: "failed", finishedAt: new Date().toISOString(), error: error.message.slice(0, 1500) })
        }], `Record ETF report failure ${date}`).catch(() => console.error("Unable to persist ETF failure status", { date }));
      });
      defer(job);
      return res.status(202).json({ ok: true, runtime: "vercel", type, date, status: "accepted", completed: false });
    }
    return res.status(200).json(await executeReportJob(req, type, date));
  } catch (error) {
    return res.status(500).json({
      ok: false,
      runtime: "vercel",
      type,
      error: error.message
    });
  }
}

async function executeReportJob(req, type, date) {
    const workspace = join(tmpdir(), `a-share-report-${type}-${date}-${Date.now()}`);
    await rm(workspace, { recursive: true, force: true });
    await mkdir(join(workspace, "data"), { recursive: true });

    const snapshot = await seedReportSnapshot(workspace);
    if (type === "etf-rotation" && await etfFilesAreCurrent(snapshot, date)) {
      return { ok: true, runtime: "vercel", type, date, skipped: true, reason: "report_already_published", committed: 0 };
    }
    const archived = type === "etf-rotation" ? await recoverArchivedEtf(snapshot, date) : null;
    if (archived) await writeFile(join(workspace, "data", "reports.json"), JSON.stringify(archived, null, 2), "utf8");
    const generation = await runCli(workspace, type, date, req);
    const commitResults = await persistGeneratedReport(workspace, type, date, snapshot, req);

    return {
      ok: true,
      runtime: "vercel",
      type,
      date,
      generation: summarizeGeneration(generation),
      committed: commitResults.length,
      files: commitResults.map((item) => item.path)
    };
}

async function readReportSnapshot() {
  const head = await githubJson(`git/ref/heads/${encodeURIComponent(BRANCH)}`);
  const payload = await fetchText(`https://raw.githubusercontent.com/${REPO}/${head.object.sha}/data/reports.json`, 15000);
  const db = JSON.parse(payload);
  if (!db.etfRotationReports || !Array.isArray(db.jobLogs)) throw new Error("Invalid ETF report database; refusing to reset history");
  if (Object.keys(db.etfRotationReports).length && !db.etfRotationPortfolio?.history?.length) throw new Error("ETF portfolio history missing; refusing to reset net value");
  return { sha: head.object.sha, payload, db };
}

async function seedReportSnapshot(workspace) {
  const snapshot = await readReportSnapshot();
  await writeFile(join(workspace, "data", "reports.json"), snapshot.payload, "utf8");
  return snapshot;
}

export async function recoverArchivedEtf(snapshot, date) {
  if (snapshot.db.etfRotationReports?.[date]?.status === "ok") return null;
  const path = `outputs/data/reports/etf-rotation/${date}.json`;
  const commits = await githubJson(`commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(BRANCH)}&per_page=5`);
  for (const commit of commits) {
    const url = `https://raw.githubusercontent.com/${REPO}/${commit.sha}/${path}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`ETF archive read HTTP ${response.status}`);
    const report = await response.json();
    if (report.date !== date || report.status !== "ok") continue;
    const historical = JSON.parse(await fetchText(`https://raw.githubusercontent.com/${REPO}/${commit.sha}/data/reports.json`, 15000));
    const stored = historical.etfRotationReports?.[date];
    if (!stored || stored.netValue !== report.netValue) throw new Error("Archived ETF report and database disagree");
    const merged = mergeGeneratedReport({ current: snapshot.db, snapshot: snapshot.db, generated: historical, type: "etf-rotation", date });
    return merged.db;
  }
  return null;
}

export async function etfFilesAreCurrent(snapshot, date) {
  const expected = snapshot.db.etfRotationReports?.[date];
  if (expected?.status !== "ok") return false;
  mergeGeneratedReport({ current: snapshot.db, snapshot: snapshot.db, generated: snapshot.db, type: "etf-rotation", date });
  const paths = [`etf-rotation/${date}.json`, "etf-rotation-latest.json"];
  const reports = await Promise.all(paths.map(async path => {
    const response = await fetch(`https://raw.githubusercontent.com/${REPO}/${snapshot.sha}/outputs/data/reports/${path}`, { signal: AbortSignal.timeout(15000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`ETF report verification HTTP ${response.status}`);
    return response.json();
  }));
  return reports.every(report => report?.date === date && report.status === "ok" && report.netValue === expected.netValue
    && isDeepStrictEqual(report.etfs, expected.etfs) && isDeepStrictEqual(report.holding, expected.holding)
    && isDeepStrictEqual(report.portfolioHistory, snapshot.db.etfRotationPortfolio.history));
}

export async function preparePublishedReports(workspace) {
  await mkdir(join(workspace, "data"), { recursive: true });
  const snapshot = await seedReportSnapshot(workspace);
  const response = await fetch(`https://raw.githubusercontent.com/${REPO}/${snapshot.sha}/outputs/data/reports/etf-rotation-job.json`, { signal: AbortSignal.timeout(15000) });
  if (response.ok) {
    const job = await response.json();
    if (job.status === "completed" && snapshot.db.etfRotationReports?.[job.date]?.status !== "ok") {
      throw new Error(`Previously completed ETF report ${job.date} is missing; refuse to publish stale data`);
    }
  } else if (response.status !== 404) throw new Error(`ETF completion status read HTTP ${response.status}`);
  await runCli(workspace, "export-static", "", { headers: {} });
  return { status: "verified", latestEtfDate: Object.keys(snapshot.db.etfRotationReports).sort().at(-1) || null };
}

export async function persistGeneratedReport(workspace, type, date, snapshot, req) {
  const generated = JSON.parse(await readFile(join(workspace, "data", "reports.json"), "utf8"));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const current = await readReportSnapshot();
      const merged = mergeGeneratedReport({ current: current.db, snapshot: snapshot.db, generated, type, date });
      await writeFile(join(workspace, "data", "reports.json"), JSON.stringify(merged.db, null, 2), "utf8");
      // Rebuild shared indexes from the merged database, not the stale generator copy.
      await runCli(workspace, "export-static", date, req);
      const files = await collectChangedFiles(workspace, type, date);
      if (type === "etf-rotation") files.push({
        path: "outputs/data/reports/etf-rotation-job.json",
        content: JSON.stringify({ type, date, status: "completed", alreadyPublished: merged.alreadyPublished, finishedAt: new Date().toISOString() })
      });
      return await writeEtfFilesToGitHub(files, `Update ${type} report ${date}`, current);
    } catch (error) {
      if (attempt === 2 || !(error.status === 409 || error.status === 422 || error.code === "REPORT_STORAGE_CONFLICT" || error.name === "TimeoutError")) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

export async function writeEtfFilesToGitHub(files, message, snapshot) {
  // Publish database, dated report and latest pointers together, never a partial report.
  const head = await githubJson(`git/ref/heads/${encodeURIComponent(BRANCH)}`);
  if (head.object.sha !== snapshot.sha) {
    const current = await fetchText(`https://raw.githubusercontent.com/${REPO}/${head.object.sha}/data/reports.json`, 15000);
    if (current !== snapshot.payload) {
      const error = new Error("Report database changed during generation; refusing to overwrite newer portfolio history");
      error.code = "REPORT_STORAGE_CONFLICT";
      throw error;
    }
  }
  const commit = await githubJson(`git/commits/${head.object.sha}`);
  const tree = await githubJson("git/trees", "POST", {
    base_tree: commit.tree.sha,
    tree: files.map((file) => ({ path: file.path, mode: "100644", type: "blob", content: file.content }))
  });
  const next = await githubJson("git/commits", "POST", { message, tree: tree.sha, parents: [head.object.sha] });
  await githubJson(`git/refs/heads/${encodeURIComponent(BRANCH)}`, "PATCH", { sha: next.sha, force: false });
  return files.map((file) => ({ path: file.path, commit: next.sha }));
}

async function githubJson(path, method = "GET", body) {
  const token = process.env.GITHUB_REPORT_TOKEN || process.env.GITHUB_TOKEN || "";
  if (!token) throw new Error("GITHUB_REPORT_TOKEN is not configured");
  const response = await fetch(`${API_BASE}/repos/${REPO}/${path}`, {
    method, headers: githubHeaders(token), signal: AbortSignal.timeout(15000),
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!response.ok) {
    const error = new Error(`GitHub report storage HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function summarizeGeneration(generation) {
  const report = generation?.report || generation;
  const stocks = Array.isArray(report?.stocks) ? report.stocks : [];
  return {
    status: generation?.status || report?.status || null,
    generatedAt: report?.generatedAt || generation?.generatedAt || null,
    totalCandidates: generation?.totalCandidates || report?.totalCandidates || null,
    stockCount: stocks.length,
    stocks: stocks.map((stock) => ({
      rank: stock.rank,
      symbol: stock.symbol,
      name: stock.name,
      heatScore: stock.heatScore ?? stock.weeklyHeatScore ?? null
    })),
    latePortfolioNetValue: report?.latePortfolio?.netValue ?? generation?.latePortfolio?.netValue ?? null
  };
}

function getAshareTradingDateStatus(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { isTradingDate: false, reason: "invalid_date" };
  }
  if (!isWeekday(date)) {
    return { isTradingDate: false, reason: "weekend" };
  }
  if (aShareClosedDates().has(date)) {
    return { isTradingDate: false, reason: "market_holiday" };
  }
  return { isTradingDate: true, reason: "trading_date" };
}

function isWeekday(date) {
  const day = new Date(`${date}T12:00:00+08:00`).getUTCDay();
  return day >= 1 && day <= 5;
}

function aShareClosedDates() {
  const configured = parseDateList(process.env.A_SHARE_CLOSED_DATES || process.env.A_SHARE_NON_TRADING_DATES || "");
  return new Set([...DEFAULT_A_SHARE_CLOSED_DATES, ...configured]);
}

function weekKey(date) {
  const d = new Date(`${date}T12:00:00+08:00`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-${String(week).padStart(2, "0")}`;
}

function parseDateList(value) {
  return String(value)
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item));
}

function assertAuthorized(req) {
  const secret = process.env.REPORT_JOB_SECRET || process.env.CRON_SECRET || "";
  if (!secret) throw new Error("REPORT_JOB_SECRET is not configured");
  const header = req.headers?.authorization || "";
  const token = String(req.query?.token || "");
  if (header === `Bearer ${secret}` || token === secret) return;
  throw new Error("Unauthorized report job request");
}

async function runCli(workspace, type, date, req) {
  const script = join(ROOT, "src", "cli.js");
  const origin = `${req.headers?.["x-forwarded-proto"] || "https"}://${req.headers?.host || "10-5-k.vercel.app"}`;
  const env = {
    ...process.env,
    NETLIFY_DATA_PROXY_BASE: process.env.NETLIFY_DATA_PROXY_BASE || origin
  };
  const result = await spawnNode(script, [type, date], workspace, env);
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { stdout: result.stdout, stderr: result.stderr };
  }
}

function spawnNode(script, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`report generator exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function collectChangedFiles(workspace, type, date) {
  const reportKey = type === "weekly" ? weekKey(date) : date;
  const files = [
    "data/reports.json",
    "outputs/data/reports/recent.json",
    "outputs/data/reports/logs.json",
    `outputs/data/reports/${type}/${reportKey}.json`,
    `outputs/data/reports/${type}-latest.json`
  ];
  const existing = [];
  for (const path of files) {
    const full = join(workspace, path);
    try {
      existing.push({ path, content: await readFile(full, "utf8") });
    } catch {
      throw new Error(`Required generated report file missing: ${path}`);
    }
  }
  if (!existing.length) throw new Error("No generated files found to commit");
  return existing;
}

async function writeFilesToGitHub(files, message) {
  const token = process.env.GITHUB_REPORT_TOKEN || process.env.GITHUB_TOKEN || "";
  if (!token) throw new Error("GITHUB_REPORT_TOKEN is not configured");
  const results = [];
  for (const file of files) {
    const current = await getGitHubFile(file.path, token);
    const method = "PUT";
    const body = {
      message,
      branch: BRANCH,
      content: Buffer.from(file.content, "utf8").toString("base64")
    };
    if (current?.sha) body.sha = current.sha;
    const response = await fetch(`${API_BASE}/repos/${REPO}/contents/${encodeURIComponentPath(file.path)}`, {
      method,
      headers: githubHeaders(token),
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub write failed for ${file.path}: ${response.status} ${text.slice(0, 240)}`);
    }
    const payload = await response.json();
    results.push({ path: file.path, commit: payload.commit?.sha || "" });
  }
  return results;
}

async function getGitHubFile(path, token) {
  const response = await fetch(`${API_BASE}/repos/${REPO}/contents/${encodeURIComponentPath(path)}?ref=${encodeURIComponent(BRANCH)}`, {
    headers: githubHeaders(token)
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub read failed for ${path}: ${response.status} ${text.slice(0, 240)}`);
  }
  return response.json();
}

async function fetchText(url, timeoutMs) {
  const response = await fetch(url, { headers: { "User-Agent": "vercel-report-job/1.0" }, ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}) });
  if (!response.ok) throw new Error(`request failed ${response.status}`);
  return response.text();
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "vercel-report-job/1.0",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

function encodeURIComponentPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function shanghaiDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date()).reduce((acc, part) => (acc[part.type] = part.value, acc), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}


