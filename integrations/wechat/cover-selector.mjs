export const STATE_COVERS = Object.freeze([
  { state: "hold", label: "持有", file: "02-cover-hold.png", env: "WECHAT_THUMB_MEDIA_ID_HOLD" },
  { state: "rebalance", label: "调仓", file: "03-cover-rebalance.png", env: "WECHAT_THUMB_MEDIA_ID_REBALANCE" },
  { state: "cash", label: "空仓", file: "04-cover-cash.png", env: "WECHAT_THUMB_MEDIA_ID_CASH" }
]);

const mediaId = value => typeof value === "string" ? value.trim() : "";

export function coverState(report) {
  // The final position takes priority, including a sell-to-cash day.
  if (!report.holding) return "cash";
  return report.rebalance?.length ? "rebalance" : "hold";
}

export function selectThumbMediaId(report, env = {}) {
  const entry = STATE_COVERS.find(item => item.state === coverState(report));
  return mediaId(env[entry.env]) || mediaId(env.WECHAT_THUMB_MEDIA_ID);
}

export function coverConfiguration(env = {}) {
  const stateCoversConfigured = Object.fromEntries(STATE_COVERS.map(item => [item.state, Boolean(mediaId(env[item.env]))]));
  return {
    coverConfigured: Boolean(mediaId(env.WECHAT_THUMB_MEDIA_ID)) || Object.values(stateCoversConfigured).every(Boolean),
    stateCoversConfigured,
    coverSelectionVersion: "final-position-v1"
  };
}
