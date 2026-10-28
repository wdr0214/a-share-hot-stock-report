import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createArticle, loadReport, shanghaiDate } from "./etf-article.mjs";
import { FileDraftStore, WeChatClient, saveDraftOnce } from "./draft-client.mjs";

export function createDraftServer(env = process.env) {
  for (const key of ["WECHAT_APP_ID", "WECHAT_APP_SECRET", "WECHAT_THUMB_MEDIA_ID", "WECHAT_STATE_DIR", "WECHAT_DRAFT_BRIDGE_SECRET"]) {
    if (!env[key]) throw new Error(`请配置 ${key}`);
  }
  const expected = Buffer.from(`Bearer ${env.WECHAT_DRAFT_BRIDGE_SECRET}`);
  const client = new WeChatClient({ appId: env.WECHAT_APP_ID, appSecret: env.WECHAT_APP_SECRET });
  const store = new FileDraftStore(env.WECHAT_STATE_DIR, env.WECHAT_APP_ID);
  return createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    const reply = (status, data) => { res.statusCode = status; res.end(JSON.stringify(data)); };
    if (req.method === "GET" && req.url === "/health") return reply(200, { ok: true, mode: "draft_only" });
    const provided = Buffer.from(String(req.headers.authorization || ""));
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return reply(401, { ok: false, error: "Unauthorized" });
    if (req.method !== "POST" || req.url !== "/draft") return reply(404, { ok: false });
    try {
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
      const article = createArticle(report, { author: env.WECHAT_AUTHOR, thumbMediaId: env.WECHAT_THUMB_MEDIA_ID });
      reply(200, await saveDraftOnce({ date, article, client, store }));
    } catch (error) {
      console.error(error.message);
      reply(502, { ok: false, error: "草稿处理失败，请检查服务端日志和公众号草稿箱" });
    }
  });
}

if (process.argv[1]?.endsWith("server.mjs")) {
  const server = createDraftServer();
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.listen(Number(process.env.WECHAT_PORT || 8789), process.env.WECHAT_BIND || "127.0.0.1", () => console.log("WeChat draft service started"));
}
