import { waitUntil } from "@vercel/functions";
import { handleReportJob } from "../../_github-report-job.mjs";

// Authenticated endpoint for the weekday ETF rotation scheduler.

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  return handleReportJob(req, res, "etf-rotation", { defer: waitUntil });
}

