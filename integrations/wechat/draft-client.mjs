import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class WeChatClient {
  constructor({ appId, appSecret, fetchImpl = fetch }) {
    if (!appId || !appSecret) throw new Error("需要配置 WECHAT_APP_ID 和 WECHAT_APP_SECRET");
    this.appId = appId; this.appSecret = appSecret; this.fetchImpl = fetchImpl;
  }

  async request(path, body, { token = true, form = false } = {}) {
    const suffix = token ? `?access_token=${encodeURIComponent(await this.accessToken())}${path.includes("add_material") ? "&type=image" : ""}` : "";
    let response;
    try {
      response = await this.fetchImpl(`https://api.weixin.qq.com${path}${suffix}`, {
        method: "POST", headers: form ? {} : { "Content-Type": "application/json; charset=utf-8" },
        body: form ? body : JSON.stringify(body), signal: AbortSignal.timeout(20000)
      });
    } catch { throw new Error("微信接口连接中断；写入结果可能未知，请检查草稿箱后再处理"); }
    if (!response.ok) throw new Error(`微信接口 HTTP ${response.status}`);
    let payload;
    try { payload = await response.json(); } catch { throw new Error("微信接口未返回有效 JSON"); }
    if (Number(payload.errcode || 0)) {
      const code = Number(payload.errcode);
      const reason = ({ 40164: "调用服务器 IP 不在公众号白名单", 48001: "当前账号没有此接口权限", 40013: "AppID 无效", 40125: "AppSecret 无效", 40001: "access_token 无效", 40007: "素材 ID 无效，请重新设置封面", 45009: "接口额度已用完" })[code] || "请在微信官方后台检查接口错误码";
      throw new Error(`微信接口错误 ${code}：${reason}`);
    }
    return payload;
  }

  async accessToken() {
    if (this.token && this.tokenExpiresAt > Date.now()) return this.token;
    const payload = await this.request("/cgi-bin/stable_token", { grant_type: "client_credential", appid: this.appId, secret: this.appSecret, force_refresh: false }, { token: false });
    if (!payload.access_token) throw new Error("微信没有返回 access_token");
    this.token = payload.access_token;
    this.tokenExpiresAt = Date.now() + Math.max(0, Number(payload.expires_in || 0) - 120) * 1000;
    return this.token;
  }

  async checkDraftAccess() {
    const payload = await this.request("/cgi-bin/draft/batchget", { offset: 0, count: 1, no_content: 1 });
    return { ok: true, draftAccess: true, totalCount: payload.total_count ?? null };
  }

  async uploadCover(bytes, filename) {
    if (!/\.(png|jpe?g)$/i.test(filename) || bytes.length > 10 * 1024 * 1024) throw new Error("封面请使用不超过 10MB 的 PNG/JPEG 图片");
    const form = new FormData();
    form.append("media", new Blob([bytes], { type: /\.png$/i.test(filename) ? "image/png" : "image/jpeg" }), filename);
    const payload = await this.request("/cgi-bin/material/add_material", form, { form: true });
    if (!payload.media_id) throw new Error("微信未返回永久封面素材 ID");
    return { thumbMediaId: payload.media_id };
  }
}

export class FileDraftStore {
  constructor(root, appId) {
    if (!root) throw new Error("WECHAT_STATE_DIR 必须指向有持久化存储的私有目录");
    this.root = join(root, createHash("sha256").update(appId).digest("hex").slice(0, 16));
  }
  async read(key) {
    try { return JSON.parse(await readFile(join(this.root, `${key}.json`), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  async write(key, value) {
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, `${key}.json`);
    await writeFile(path + ".tmp", JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(path + ".tmp", path);
  }
  async exclusive(key, operation) {
    await mkdir(this.root, { recursive: true });
    const lock = join(this.root, `${key}.lock`);
    try { await mkdir(lock); }
    catch (error) { if (error.code === "EEXIST") throw new Error("同一天的草稿任务正在执行，或上次中断后需要检查锁文件"); throw error; }
    try { return await operation(); }
    finally { await rm(lock, { recursive: true, force: true }); }
  }
}

export async function saveDraftOnce({ date, article, client, store }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("草稿日期无效");
  if (!article.thumb_media_id) throw new Error("请先配置 WECHAT_THUMB_MEDIA_ID（永久封面素材 ID）");
  const fingerprint = createHash("sha256").update(JSON.stringify(article)).digest("hex");
  return store.exclusive(date, async () => {
    let state = await store.read(date);
    if (state && state.fingerprint !== fingerprint) throw new Error("当天已有不同内容的草稿记录，需要先在后台核对，避免重复发文");
    if (state?.status === "creating") throw new Error("上一次创建草稿的结果未知，请先在公众号草稿箱核对，系统不会重复创建");
    if (!state?.mediaId) {
      await client.accessToken();
      state = { date, fingerprint, status: "creating", startedAt: new Date().toISOString() };
      await store.write(date, state);
      const created = await client.request("/cgi-bin/draft/add", { articles: [article] });
      if (!created.media_id) throw new Error("微信未返回草稿 media_id，请核对后台");
      state = { ...state, mediaId: created.media_id, status: "created" };
      await store.write(date, state);
    }
    if (state.status !== "verified") {
      const readback = await client.request("/cgi-bin/draft/get", { media_id: state.mediaId });
      const item = readback.news_item?.[0];
      if (item?.title !== article.title || !item?.content) throw new Error("草稿已保存，但读取核验失败；下次只核验，不重复新建");
      state = { ...state, status: "verified", verifiedAt: new Date().toISOString() };
      await store.write(date, state);
    }
    return { ok: true, date, status: "draft_verified", mediaId: state.mediaId, published: false };
  });
}
