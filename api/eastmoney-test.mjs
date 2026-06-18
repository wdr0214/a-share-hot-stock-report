const EASTMONEY_FIELDS = "f12,f14,f2,f3,f6,f7,f8,f10,f62,f66,f69,f72,f75,f100";

export default async function handler(req, res) {
  try {
    const limit = Math.max(1, Math.min(Number(req.query?.limit || 500), 500));
    const payload = await fetchEastmoney(limit);
    const items = payload?.data?.diff;
    if (!Array.isArray(items)) {
      return res.status(502).json({
        ok: false,
        source: "eastmoney",
        error: "Eastmoney response missing data.diff",
        responseShape: Object.keys(payload || {})
      });
    }
    const first = normalizeEastmoney(items[0]);
    return res.status(200).json({
      ok: true,
      runtime: "vercel",
      source: "eastmoney",
      requestedLimit: limit,
      count: items.length,
      first
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      runtime: "vercel",
      source: "eastmoney",
      error: error.message
    });
  }
}

async function fetchEastmoney(limit) {
  const url = new URL("https://push2.eastmoney.com/api/qt/clist/get");
  url.searchParams.set("pn", "1");
  url.searchParams.set("pz", String(limit));
  url.searchParams.set("po", "1");
  url.searchParams.set("np", "1");
  url.searchParams.set("fltt", "2");
  url.searchParams.set("invt", "2");
  url.searchParams.set("fid", "f62");
  url.searchParams.set("fs", "m:1+t:2,m:0+t:6,m:0+t:80,m:0+t:81");
  url.searchParams.set("fields", EASTMONEY_FIELDS);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json,text/plain,*/*",
      Referer: "https://quote.eastmoney.com/",
      "User-Agent": "Mozilla/5.0 vercel-stock-report/1.0"
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Eastmoney request failed ${response.status}: ${text.slice(0, 180)}`);
  }
  return response.json();
}

function normalizeEastmoney(item = {}) {
  const superLargeOrderNetAmount = number(item.f66);
  const largeOrderNetAmount = number(item.f72);
  return {
    symbol: normalizeSymbol(item.f12),
    name: String(item.f14 || "").trim(),
    changePct: number(item.f3),
    close: number(item.f2),
    amount: number(item.f6),
    turnoverRate: number(item.f8),
    volumeRatio: number(item.f10 || 1),
    mainNetInflow: number(item.f62),
    superLargeOrderNetAmount,
    largeOrderNetAmount,
    largeOrderNetRatio: number(item.f75),
    bigOrderNetAmount: superLargeOrderNetAmount + largeOrderNetAmount,
    industry: String(item.f100 || "").trim()
  };
}

function normalizeSymbol(symbol) {
  const raw = String(symbol || "").trim().toUpperCase().replace(".", "");
  if (/^(SH|SZ|BJ)\d{6}$/.test(raw)) return raw;
  if (/^6\d{5}$/.test(raw)) return `SH${raw}`;
  if (/^[038]\d{5}$/.test(raw)) return `SZ${raw}`;
  if (/^[492]\d{5}$/.test(raw)) return `BJ${raw}`;
  return raw;
}

function number(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}
