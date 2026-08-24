Exit code: 0
Wall time: 1.7 seconds
Output:
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

export async function handleReportJob(req, res, type) {
  try {
    assertAuthorized(req);
    if (!["late", "daily", "weekly"].includes(type)) {
      return res.status(400).json({ ok: false, error: "unsupported report type" });
    }

    const date = String(req.query?.date || shanghaiDate()).slice(0, 10);
    const tradingDate = type === "weekly" ? { isTradingDate: true, reason: "weekly_report" } : getAshareTradingDateStatus(date);
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

    const workspace = join("/tmp", `a-share-report-${type}-${date}-${Date.now()}`);
    await rm(workspace, { recursive: true, force: true });
    await mkdir(join(workspace, "data"), { recursive: true });

    await seedReportsDb(workspace);
    const generation = await runCli(workspace, type, date, req);
    const changedFiles = await collectChangedFiles(workspace, type, date);
    const commitResults = await writeFilesToGitHub(changedFiles, `Update ${type} report ${date}`);

    return res.status(200).json({
      ok: true,
      runtime: "vercel",
      type,
      date,
      generation: summarizeGeneration(generation),
      committed: commitResults.length,
      files: commitResults.map((item) => item.path)
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      runtime: "vercel",
      type,
      error: error.message
    });
  }
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

async function seedReportsDb(workspace) {
  const fallback = { dailyReports: {}, lateReports: {}, weeklyReports: {}, etfRotationReports: {}, latePortfolio: null, dailyPortfolio: null, etfRotationPortfolio: null, jobLogs: [] };
  const payload = await fetchText(`${RAW_BASE}/data/reports.json`).catch(() => JSON.stringify(fallback, null, 2));
  await writeFile(join(workspace, "data", "reports.json"), payload, "utf8");
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
      // Some files, such as latest pointers, may be absent if generation failed.
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

async function fetchText(url) {
  const response = await fetch(url, { headers: { "User-Agent": "vercel-report-job/1.0" } });
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

