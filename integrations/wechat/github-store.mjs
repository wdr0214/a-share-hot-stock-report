import { createHash } from "node:crypto";

export class GitHubDraftStore {
  constructor({ token, appId, repo = "wdr0214/a-share-hot-stock-report", branch = "main", fetchImpl = fetch }) {
    if (!token || !appId) throw new Error("GitHub 去重存储需要 GITHUB_REPORT_TOKEN 和 WECHAT_APP_ID");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !branch) throw new Error("草稿存储仓库或分支无效");
    this.token = token; this.repo = repo; this.branch = branch; this.fetchImpl = fetchImpl;
    this.account = createHash("sha256").update(appId).digest("hex").slice(0, 16);
    this.shas = new Map(); this.busy = new Set();
  }

  async request(key, method, body) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error("草稿存储日期无效");
    const path = `data/wechat-draft-state/${this.account}/${key}.json`;
    const url = `https://api.github.com/repos/${this.repo}/contents/${path}${method === "GET" ? `?ref=${encodeURIComponent(this.branch)}` : ""}`;
    let response;
    try {
      response = await this.fetchImpl(url, { method, headers: {
        Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json",
        "User-Agent": "etf-wechat-draft-state", "X-GitHub-Api-Version": "2022-11-28"
      }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000), redirect: "error" });
    } catch { throw new Error("草稿去重状态请求中断；请重试核对状态，不要直接重新上传"); }
    if (response.status === 404 && method === "GET") return null;
    if ([409, 422].includes(response.status)) throw new Error("草稿状态已被其他任务更新，请稍后重试；本次不重复上传");
    if (!response.ok) throw new Error(`草稿去重存储 HTTP ${response.status}，请检查仓库权限`);
    return response.json();
  }

  async read(key) {
    const file = await this.request(key, "GET");
    if (!file) { this.shas.set(key, null); return null; }
    if (file.encoding !== "base64" || !file.sha || typeof file.content !== "string") throw new Error("草稿状态文件格式无效");
    this.shas.set(key, file.sha);
    return JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  }

  async write(key, value) {
    if (!this.shas.has(key)) throw new Error("写入草稿状态前必须先读取");
    const body = { branch: this.branch, message: `Record ETF WeChat draft state ${key}`, content: Buffer.from(JSON.stringify(value, null, 2) + "\n").toString("base64") };
    if (this.shas.get(key)) body.sha = this.shas.get(key);
    const result = await this.request(key, "PUT", body);
    if (!result.content?.sha) throw new Error("草稿状态已提交但未返回 SHA，需重读核对");
    this.shas.set(key, result.content.sha);
  }

  async exclusive(key, operation) {
    if (this.busy.has(key)) throw new Error("同一天的草稿任务正在执行");
    this.busy.add(key);
    try { return await operation(); }
    finally { this.busy.delete(key); this.shas.delete(key); }
  }
}
