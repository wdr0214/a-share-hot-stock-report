import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createArticle, loadReport, shanghaiDate } from "./etf-article.mjs";
import { FileDraftStore, WeChatClient, saveDraftOnce } from "./draft-client.mjs";
import { GitHubDraftStore } from "./github-store.mjs";
import { selectThumbMediaId, coverConfiguration } from "./cover-selector.mjs";

export function createDraftServer(env = process.env) {
  const authMode = env.WECHAT_AUTH_MODE || "direct";
  const stateBackend = env.WECHAT_STATE_BACKEND || (authMode === "cloudrun" ? "github" : "file");
  for (const key of ["WECHAT_APP_ID", "WECHAT_DRAFT_BRIDGE_SECRET", ...(authMode === "direct" ? ["WECHAT_APP_SECRET"] : []), ...(stateBackend === "file" ? ["WECHAT_STATE_DIR"] : [])]) {
    if (!env[key]) throw new Error(`请配置 ${key}`);
  }
  const expected = Buffer.from(`Bearer ${env.WECHAT_DRAFT_BRIDGE_SECRET}`);
  if (!["file", "github"].includes(stateBackend) || (authMode === "cloudrun" && stateBackend !== "github")) throw new Error("云托管使用 github 持久化去重存储；普通模式支持 file 或 github");
  const client = new WeChatClient({ appId: env.WECHAT_APP_ID, appSecret: env.WECHAT_APP_SECRET, authMode });
  const store = stateBackend === "github" ? new GitHubDraftStore({ token: env.GITHUB_REPORT_TOKEN, appId: env.WECHAT_APP_ID, repo: env.WECHAT_STATE_REPO || undefined, branch: env.WECHAT_STATE_BRANCH || undefined }) : new FileDraftStore(env.WECHAT_STATE_DIR, env.WECHAT_APP_ID);
  return createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    const reply = (status, data) => { res.statusCode = status; res.end(JSON.stringify(data)); };
    if (req.method === "GET" && req.url === "/health") return reply(200, { ok: true, service: "etf-wechat-draft", mode: "draft_only", authMode, stateBackend, ...coverConfiguration(env) });
    const provided = Buffer.from(String(req.headers.authorization || ""));
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return reply(401, { ok: false, error: "Unauthorized" });
    if (req.method !== "POST" || !["/draft", "/check", "/cover"].includes(req.url)) return reply(404, { ok: false });
    try {
      if (req.url === "/check") return reply(200, await client.checkDraftAccess());
      if (req.url === "/cover") {
        const type = String(req.headers["content-type"] || "").split(";")[0];
        if (!["image/png", "image/jpeg"].includes(type)) return reply(400, { ok: false, error: "Only PNG/JPEG covers are supported" });
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) return reply(413, { ok: false, error: "Cover must be at most 2MB" }); chunks.push(chunk); }
        return reply(200, { ok: true, ...await client.uploadCover(Buffer.concat(chunks), type === "image/png" ? "cover.png" : "cover.jpg") });
      }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2048) return reply(413, { ok: false, error: "Request too large" });
      }
      let input;
      try { input = JSON.parse(body); } catch { return reply(400, { ok: false, error: "Invalid JSON" }); }
      const date = shanghaiDate();
      if (input.date !== date) return reply(400, { ok: false, error: "Only today's report can be submitted automatically" });
      const report = await loadReport(date);
      if (!report) return reply(200, { ok: true, skipped: true, date, reason: "no_report_for_date" });
      const article = createArticle(report, { author: env.WECHAT_AUTHOR, thumbMediaId: selectThumbMediaId(report, env) });
      reply(200, await saveDraftOnce({ date, article, client, store }));
    } catch (error) {
      console.error(error.message);
      reply(502, { ok: false, error: "草稿处理失败，请检查服务端日志和公众号草稿箱" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createDraftServer();
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.listen(Number(process.env.PORT || process.env.WECHAT_PORT || 8789), process.env.WECHAT_BIND || "127.0.0.1", () => console.log("WeChat draft service started"));
}
