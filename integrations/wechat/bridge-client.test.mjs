import { test } from "node:test";
import assert from "node:assert/strict";
import { submitBridgeDraft } from "./cli.mjs";
import { saveDraftOnce } from "./draft-client.mjs";

const input = { url: "https://bridge.example/draft", secret: "test-only-secret", date: "2026-11-03" };
const ready = () => response(200, { ok: true, service: "etf-wechat-draft", mode: "draft_only" });
const verified = () => ({ ok: true, date: input.date, status: "draft_verified", mediaId: "test-draft", published: false });
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("bridge warms a cold service with bounded read-only retries before submitting", async () => {
  const waits = [], requests = [];
  let healthCalls = 0;
  const result = await submitBridgeDraft({ ...input, waitImpl: async ms => waits.push(ms), fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options });
    if (options.method === "GET") {
      assert.equal(options.headers, undefined);
      if (++healthCalls === 1) return response(503, {});
      if (healthCalls === 2) throw new Error("test connection timeout");
      return ready();
    }
    assert.equal(healthCalls, 3);
    return response(200, verified());
  } });
  assert.equal(result.status, "draft_verified");
  assert.deepEqual(waits, [10000, 10000]);
  assert.deepEqual(requests.map(r => r.options.method), ["GET", "GET", "GET", "POST"]);
  assert.equal(requests[0].url, "https://bridge.example/health");
  for (const request of requests) assert.ok(!request.url.includes(input.secret));
});

test("failed warmup never submits a draft and stops after six health requests", async () => {
  let calls = 0; const waits = [];
  await assert.rejects(submitBridgeDraft({ ...input, waitImpl: async ms => waits.push(ms), fetchImpl: async (_url, options) => {
    assert.equal(options.method, "GET"); calls++; return response(503, {});
  } }), error => error.message.includes("未提交草稿") && !error.message.includes(input.secret));
  assert.equal(calls, 6); assert.deepEqual(waits, Array(5).fill(10000));
});

test("gateway retries keep the exact date and stop after three additional attempts", async () => {
  let posts = 0; const waits = [], bodies = [];
  await assert.rejects(submitBridgeDraft({ ...input, waitImpl: async ms => waits.push(ms), fetchImpl: async (_url, options) => {
    if (options.method === "GET") return ready();
    posts++; bodies.push(options.body);
    assert.equal(options.headers.Authorization, `Bearer ${input.secret}`);
    return { ...response(503, null), json: async () => { throw new Error("HTML gateway page"); } };
  } }), /HTTP 503/);
  assert.equal(posts, 4); assert.deepEqual(waits, Array(3).fill(10000));
  assert.ok(bodies.every(body => body === JSON.stringify({ date: input.date })));
});

test("same-date replay after a gateway 503 verifies the existing draft without a second add", async () => {
  let state = null, added = 0, posts = 0;
  const store = { exclusive: async (_date, operation) => operation(), read: async () => state, write: async (_date, value) => { state = value; } };
  const article = { title: "test article", content: "test only", thumb_media_id: "test-cover" };
  const client = { accessToken: async () => null, request: async path => {
    if (path.endsWith("/add")) { added++; return { media_id: "test-draft" }; }
    return { news_item: [{ title: article.title, content: article.content }] };
  } };
  const result = await submitBridgeDraft({ ...input, waitImpl: async () => {}, fetchImpl: async (_url, options) => {
    if (options.method === "GET") return ready();
    const body = await saveDraftOnce({ date: JSON.parse(options.body).date, article, client, store });
    return ++posts === 1 ? response(503, {}) : response(200, body);
  } });
  assert.equal(posts, 2); assert.equal(added, 1); assert.equal(result.status, "draft_verified");
});

test("service errors and unknown write results are not retried", async () => {
  for (const body of [
    { ok: false, stage: "save_draft", errorCode: "draft_result_unknown" },
    { ok: false, stage: "save_draft", errorCode: "state_http_403" },
    { ok: false, stage: "load_report", errorCode: "report_connection_error" }
  ]) {
    let posts = 0;
    await assert.rejects(submitBridgeDraft({ ...input, waitImpl: async () => assert.fail("must not retry service failures"), fetchImpl: async (_url, options) => {
      if (options.method === "GET") return ready();
      posts++; return response(502, body);
    } }), /阶段/);
    assert.equal(posts, 1);
  }
  let posts = 0;
  await assert.rejects(submitBridgeDraft({ ...input, waitImpl: async () => assert.fail("must not replay an interrupted POST"), fetchImpl: async (_url, options) => {
    if (options.method === "GET") return ready();
    posts++; throw new Error(input.secret);
  } }), error => error.message.includes("结果可能未知") && !error.message.includes(input.secret));
  assert.equal(posts, 1);
});

test("wrong service, permanent auth failures and unverified replies fail closed", async () => {
  for (const health of [response(403, {}), response(200, { ok: true, service: "other", mode: "draft_only" })]) {
    await assert.rejects(submitBridgeDraft({ ...input, waitImpl: async () => assert.fail("must stop"), fetchImpl: async (_url, options) => {
      assert.equal(options.method, "GET"); return health;
    } }));
  }
  for (const body of [{ ...verified(), published: true }, { ...verified(), date: "2026-11-02" }, { ...verified(), mediaId: null }]) {
    await assert.rejects(submitBridgeDraft({ ...input, fetchImpl: async (_url, options) => options.method === "GET" ? ready() : response(200, body) }), /无法确认/);
  }
});
