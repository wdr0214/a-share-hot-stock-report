import { test } from "node:test";
import assert from "node:assert/strict";
import { coverState, selectThumbMediaId, coverConfiguration } from "./cover-selector.mjs";
import { createDraftServer } from "./server.mjs";
import { readFile } from "node:fs/promises";

const env = { WECHAT_THUMB_MEDIA_ID: "default-test", WECHAT_THUMB_MEDIA_ID_HOLD: "hold-test", WECHAT_THUMB_MEDIA_ID_REBALANCE: "rebalance-test", WECHAT_THUMB_MEDIA_ID_CASH: "cash-test" };

test("Cloud Run image contains the cover selector imported by the service", async () => {
  const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^COPY .*\bcover-selector\.mjs\b.*\.\//m);
});

test("final cash position always uses cash cover, including a sell-to-cash day", () => {
  for (const rebalance of [[], [{ action: "sell" }]]) {
    const report = { holding: null, rebalance };
    assert.equal(coverState(report), "cash");
    assert.equal(selectThumbMediaId(report, env), "cash-test");
  }
});

test("remaining holdings use rebalance cover on buy or switch days, otherwise hold", () => {
  const holding = { symbol: "SH510300" };
  for (const rebalance of [[{ action: "buy" }], [{ action: "sell" }, { action: "buy" }]]) {
    assert.equal(selectThumbMediaId({ holding, rebalance }, env), "rebalance-test");
  }
  assert.equal(selectThumbMediaId({ holding, rebalance: [] }, env), "hold-test");
});

test("missing state cover falls back only to the default, never a different state", () => {
  const report = { holding: null, rebalance: [{ action: "sell" }] };
  assert.equal(selectThumbMediaId(report, { ...env, WECHAT_THUMB_MEDIA_ID_CASH: " " }), "default-test");
  assert.equal(selectThumbMediaId(report, { WECHAT_THUMB_MEDIA_ID_HOLD: "hold-only" }), "");
  assert.equal(coverConfiguration({}).coverConfigured, false);
  assert.equal(coverConfiguration({ WECHAT_THUMB_MEDIA_ID_CASH: "cash-only" }).coverConfigured, false);
  assert.equal(coverConfiguration({ ...env, WECHAT_THUMB_MEDIA_ID: "" }).coverConfigured, true);
});

test("health reports state readiness and rule version without exposing material IDs", async () => {
  const server = createDraftServer({ ...env, WECHAT_AUTH_MODE: "cloudrun", WECHAT_APP_ID: "test-app", WECHAT_DRAFT_BRIDGE_SECRET: "test-secret", GITHUB_REPORT_TOKEN: "test-token" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    const health = await response.json();
    assert.equal(health.coverSelectionVersion, "final-position-v1");
    assert.deepEqual(health.stateCoversConfigured, { hold: true, rebalance: true, cash: true });
    assert.equal(health.coverConfigured, true);
    for (const value of Object.values(env)) assert.ok(!JSON.stringify(health).includes(value));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
