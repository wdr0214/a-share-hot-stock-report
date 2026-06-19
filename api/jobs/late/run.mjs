import { handleReportJob, runtimeConfig } from "../../_github-report-job.mjs";

export const config = runtimeConfig;

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  return handleReportJob(req, res, "late");
}
