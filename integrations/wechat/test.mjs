import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArticle, loadReport, shanghaiDate, validateReport } from "./etf-article.mjs";
import { FileDraftStore, WeChatClient, saveDraftOnce } from "./draft-client.mjs";
import { createDraftServer } from "./server.mjs";
import { GitHubDraftStore } from "./github-store.mjs";

// These fixtures exercise formatting and API failures; they are never published.
function fixture() {
  return {
    type: "etf-rotation", date: "2026-10-28", status: "ok", netValue: 1.1,
    generatedAt: "2026-10-28T06:53:00Z", executionTime: "14:53", executionPriceBasis: "intraday_quote",
    parameters: { momentumDays: 20, maDays: 28 }, holding: null, rebalance: [],
    portfolioHistory: [{ date: "2026-10-27", netValue: 1 }, { date: "2026-10-28", netValue: 1.1 }, { date: "2026-10-29", netValue: 1.5 }],
    etfs: ["159915", "510300", "518880", "159941", "513050", "511260"].map((code, i) => ({ symbol: (code.startsWith("1") ? "SZ" : "SH") + code, name: `测试 ETF ${i}`, price: 2, momentum20Pct: 3, ma28: 1.9, quoteSource: "test fixture" }))
  };
}

test("article retains six prices and metrics, uses only prior net value, escapes source text", () => {
  const report = fixture(); report.etfs[0].name = '<script>alert("x")</script>';
  const article = createArticle(report);
  assert.match(article.content, /1\.1000/);
  assert.match(article.content, /\+10\.00%/);
  assert.match(article.content, /20日涨幅/);
  assert.match(article.content, /28日均线/);
  assert.match(article.content, /今日未调仓/);
  assert.match(article.content, /现金，无 ETF 持仓/);
  assert.match(article.content, /&lt;script&gt;/);
  assert.doesNotMatch(article.content, /<script>/);
  assert.equal((article.content.match(/<tr>/g) || []).length, 7);
});

test("missing, partial, duplicate or wrong-date reports fail closed", () => {
  for (const mutate of [r => r.date = "2026-10-27", r => r.status = "partial", r => r.etfs.pop(), r => r.netValue = null, r => r.etfs[0].price = null, r => r.etfs[0].momentum20Pct = null, r => r.etfs[0].symbol = r.etfs[1].symbol]) {
    const report = fixture(); mutate(report);
    assert.throws(() => validateReport(report, "2026-10-28"));
  }
});

test("rebalance prices and dividend return basis are preserved", () => {
  const report = fixture();
  report.holding = { symbol: "SZ159941", name: "测试纳指" };
  report.rebalance = [{ action: "sell", symbol: "SH511260", name: "测试债券", price: 135.558, returnPct: 0.098209, returnBasis: "price_plus_cash_dividend" }, { action: "buy", symbol: "SZ159941", name: "测试纳指", price: 1.703 }];
  const article = createArticle(report);
  for (const value of ["买入", "卖出", "135.558", "1.703", "含现金分红"]) assert.ok(article.content.includes(value));
});

test("weekends and absent daily reports skip, source failures are not treated as no report", async () => {
  assert.equal(shanghaiDate(new Date("2026-10-27T17:00:00Z")), "2026-10-28");
  assert.equal(await loadReport("2026-10-31", { fetchImpl: () => assert.fail("weekend fetch") }), null);
  assert.equal(await loadReport("2026-10-28", { fetchImpl: async () => ({ status: 404 }) }), null);
  await assert.rejects(loadReport("2026-10-28", { fetchImpl: async () => ({ status: 502, ok: false }) }), /502/);
});

test("token stays in server requests; business failures have safe actionable messages", async () => {
  const requests = [];
  const client = new WeChatClient({ appId: "test-app", appSecret: "never-print-this", fetchImpl: async (url, opts) => {
    requests.push({ url, opts });
    if (url.endsWith("stable_token")) return { ok: true, json: async () => ({ access_token: "test-token", expires_in: 7200 }) };
    return { ok: true, json: async () => ({ errcode: 48001, errmsg: "provider message never-print-this" }) };
  } });
  await assert.rejects(client.checkDraftAccess(), error => error.message.includes("48001") && !error.message.includes("never-print-this"));
  assert.equal(requests.length, 2);
  assert.ok(!requests[0].url.includes("never-print-this"));
  assert.equal(JSON.parse(requests[0].opts.body).force_refresh, false);
  assert.throws(() => new WeChatClient({}), /WECHAT_APP_ID/);
});

async function temporaryStore(operation) {
  const dir = await mkdtemp(join(tmpdir(), "etf-wechat-test-"));
  try { await operation(new FileDraftStore(dir, "test-app")); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test("same-day retries do not create duplicate drafts; changed reports need review", () => temporaryStore(async store => {
  let created = 0;
  const article = createArticle(fixture(), { thumbMediaId: "test-cover" });
  const client = { accessToken: async () => "token", request: async (path) => {
    if (path.endsWith("/add")) { created++; return { media_id: "draft-1" }; }
    return { news_item: [{ title: article.title, content: article.content }] };
  } };
  const input = { date: "2026-10-28", article, client, store };
  assert.equal((await saveDraftOnce(input)).published, false);
  assert.equal((await saveDraftOnce(input)).status, "draft_verified");
  assert.equal(created, 1);
  await assert.rejects(saveDraftOnce({ ...input, article: { ...article, content: "changed" } }), /不同内容/);
}));

test("timeout after submission never retries draft creation automatically", () => temporaryStore(async store => {
  let calls = 0;
  const article = createArticle(fixture(), { thumbMediaId: "test-cover" });
  const client = { accessToken: async () => "token", request: async () => { calls++; throw new Error("network timeout"); } };
  const input = { date: "2026-10-28", article, client, store };
  await assert.rejects(saveDraftOnce(input), /timeout/);
  await assert.rejects(saveDraftOnce(input), /结果未知/);
  assert.equal(calls, 1);
}));

test("readback failure resumes verification without creating a second draft", () => temporaryStore(async store => {
  let adds = 0, reads = 0;
  const article = createArticle(fixture(), { thumbMediaId: "test-cover" });
  const client = { accessToken: async () => "token", request: async (path) => {
    if (path.endsWith("/add")) { adds++; return { media_id: "draft-2" }; }
    if (++reads === 1) throw new Error("readback timeout");
    return { news_item: [{ title: article.title, content: article.content }] };
  } };
  const input = { date: "2026-10-28", article, client, store };
  await assert.rejects(saveDraftOnce(input), /timeout/);
  assert.equal((await saveDraftOnce(input)).status, "draft_verified");
  assert.equal(adds, 1);
}));

test("persistent lock rejects overlapping writers", () => temporaryStore(async store => {
  await store.exclusive("2026-10-28", async () => {
    await assert.rejects(store.exclusive("2026-10-28", async () => {}), /正在执行/);
  });
}));

test("bridge requires authentication and rejects historical auto-submission", async () => {
  const server = createDraftServer({ WECHAT_APP_ID: "test-app", WECHAT_APP_SECRET: "test-secret", WECHAT_THUMB_MEDIA_ID: "test-cover", WECHAT_STATE_DIR: tmpdir(), WECHAT_DRAFT_BRIDGE_SECRET: "test-auth" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(url + "/draft", { method: "POST" })).status, 401);
    assert.equal((await fetch(url + "/draft", { method: "POST", headers: { Authorization: "Bearer test-auth" }, body: JSON.stringify({ date: "2025-01-01" }) })).status, 400);
    const health = await (await fetch(url + "/health")).json();
    assert.equal(health.service, "etf-wechat-draft");
    assert.equal(health.mode, "draft_only");
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("Cloud Run uses the documented sidecar without AppSecret or stable_token", async () => {
  const urls = [];
  const client = new WeChatClient({ appId: "test-cloud-app", authMode: "cloudrun", fetchImpl: async (url, options) => {
    urls.push(url);
    assert.equal(options.redirect, "error");
    return { ok: true, json: async () => ({ total_count: 0 }) };
  } });
  assert.equal((await client.checkDraftAccess()).draftAccess, true);
  assert.deepEqual(urls, ["http://api.weixin.qq.com/cgi-bin/draft/batchget"]);
  assert.throws(() => new WeChatClient({ appId: "test", authMode: "other" }), /WECHAT_AUTH_MODE/);
});

test("Cloud Run boot does not require a cover or AppSecret; private endpoints stay protected", async () => {
  const server = createDraftServer({ WECHAT_APP_ID: "test-cloud-app", WECHAT_AUTH_MODE: "cloudrun", WECHAT_DRAFT_BRIDGE_SECRET: "test-auth", GITHUB_REPORT_TOKEN: "test-github-token" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await (await fetch(url + "/health")).json();
    assert.equal(health.authMode, "cloudrun"); assert.equal(health.stateBackend, "github"); assert.equal(health.coverConfigured, false);
    for (const endpoint of ["/check", "/cover", "/draft"]) assert.equal((await fetch(url + endpoint, { method: "POST" })).status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); }
  assert.throws(() => createDraftServer({ WECHAT_APP_ID: "test-cloud-app", WECHAT_AUTH_MODE: "cloudrun", WECHAT_STATE_BACKEND: "file", WECHAT_STATE_DIR: tmpdir(), WECHAT_DRAFT_BRIDGE_SECRET: "test-auth" }), /github/);
});

function githubMemory() {
  let state = null, version = 0;
  return async (_url, options) => {
    if (options.method === "GET") return state ? { ok: true, status: 200, json: async () => ({ ...state }) } : { ok: false, status: 404 };
    const body = JSON.parse(options.body);
    if ((!state && body.sha) || (state && body.sha !== state.sha)) return { ok: false, status: 409 };
    if (!state && version > 0) return { ok: false, status: 422 };
    state = { sha: `sha-${++version}`, content: body.content, encoding: "base64" };
    const sha = state.sha;
    return { ok: true, status: 200, json: async () => ({ content: { sha } }) };
  };
}

test("GitHub state survives new container instances and prevents double creation", async () => {
  const fetchImpl = githubMemory();
  const store = () => new GitHubDraftStore({ token: "test-token", appId: "test-cloud-app", fetchImpl });
  let added = 0;
  const article = createArticle(fixture(), { thumbMediaId: "test-cover" });
  const client = { accessToken: async () => null, request: async path => {
    if (path.endsWith("/add")) { added++; return { media_id: "cloud-draft-1" }; }
    return { news_item: [{ title: article.title, content: article.content }] };
  } };
  const input = { date: "2026-10-28", article, client };
  const concurrent = await Promise.allSettled([saveDraftOnce({ ...input, store: store() }), saveDraftOnce({ ...input, store: store() })]);
  assert.equal(concurrent.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(added, 1);
  assert.equal((await saveDraftOnce({ ...input, store: store() })).status, "draft_verified");
  assert.equal(added, 1);
});

test("GitHub state outage stops the draft before WeChat submission", async () => {
  const store = new GitHubDraftStore({ token: "test-token", appId: "test-app", fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(saveDraftOnce({ date: "2026-10-28", article: createArticle(fixture(), { thumbMediaId: "test-cover" }), store, client: { accessToken: async () => assert.fail("must not call WeChat") } }), /503/);
});
