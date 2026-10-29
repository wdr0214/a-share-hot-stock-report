import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createArticle, loadReport, shanghaiDate, validateDate, LEGACY_REPORT_URL } from "./etf-article.mjs";
import { FileDraftStore, WeChatClient, saveDraftOnce } from "./draft-client.mjs";
import { GitHubDraftStore } from "./github-store.mjs";
import { selectThumbMediaId } from "./cover-selector.mjs";

export async function run(args = process.argv.slice(2), env = process.env) {
  const [command = "render", dateArg, outputArg] = args;
  const client = () => new WeChatClient({ appId: env.WECHAT_APP_ID, appSecret: env.WECHAT_APP_SECRET, authMode: env.WECHAT_AUTH_MODE || "direct" });
  if (command === "check") return client().checkDraftAccess();
  if (command === "upload-cover") {
    if (!dateArg) throw new Error("用法：node integrations/wechat/cli.mjs upload-cover 图片路径");
    return client().uploadCover(await readFile(dateArg), basename(dateArg));
  }
  if (!["render", "draft", "bridge"].includes(command)) throw new Error("命令支持 render、check、upload-cover、draft、bridge");
  const date = validateDate(dateArg || shanghaiDate());
  if (command === "bridge") {
    if (!env.WECHAT_DRAFT_BRIDGE_URL || !env.WECHAT_DRAFT_BRIDGE_SECRET) throw new Error("缺少草稿服务 URL 或鉴权配置");
    const url = new URL(env.WECHAT_DRAFT_BRIDGE_URL);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("草稿服务必须使用不含用户名密码的 HTTPS URL");
    const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${env.WECHAT_DRAFT_BRIDGE_SECRET}`, "Content-Type": "application/json" }, body: JSON.stringify({ date }), signal: AbortSignal.timeout(180000), redirect: "error" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok !== true) throw new Error(`草稿服务失败 HTTP ${response.status}，请查看服务端记录`);
    if (!body.skipped && (body.status !== "draft_verified" || !body.mediaId || body.published !== false || body.date !== date)) throw new Error("草稿服务返回了无法确认的结果");
    return body;
  }
  const report = await loadReport(date);
  if (!report) return { ok: true, skipped: true, date, reason: "no_report_for_date" };
  const article = createArticle(report, { author: env.WECHAT_AUTHOR, thumbMediaId: selectThumbMediaId(report, env) });
  if (command === "draft") {
    const stateBackend = env.WECHAT_STATE_BACKEND || (env.WECHAT_AUTH_MODE === "cloudrun" ? "github" : "file");
    if (!["file", "github"].includes(stateBackend) || (env.WECHAT_AUTH_MODE === "cloudrun" && stateBackend !== "github")) throw new Error("云托管需要 github 持久化存储");
    const store = stateBackend === "github" ? new GitHubDraftStore({ token: env.GITHUB_REPORT_TOKEN, appId: env.WECHAT_APP_ID, repo: env.WECHAT_STATE_REPO || undefined, branch: env.WECHAT_STATE_BRANCH || undefined }) : new FileDraftStore(env.WECHAT_STATE_DIR, env.WECHAT_APP_ID);
    return saveDraftOnce({ date, article, client: client(), store, previousSourceUrl: LEGACY_REPORT_URL });
  }
  const directory = resolve(outputArg || ".codex_tmp/wechat-preview");
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `${date}.html`);
  await writeFile(path, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${article.title}</title><body style="margin:24px auto;padding:0 16px;max-width:680px;"><h1 style="font-size:22px;">${article.title}</h1>${article.content}<p><a href="${article.content_source_url}">阅读原文</a></p></body></html>`, "utf8");
  await writeFile(resolve(directory, `${date}.json`), JSON.stringify(article, null, 2), "utf8");
  return { ok: true, date, status: "rendered", path, published: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
