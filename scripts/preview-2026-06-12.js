import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const date = "2026-06-12";
const db = JSON.parse(await readFile("data/reports.json", "utf8"));
const daily = db.dailyReports?.[date];
if (!daily) throw new Error(`daily report missing: ${date}`);

for (const stock of daily.stocks || []) enrichStock(stock);
daily.generatedAt = new Date().toISOString();
daily.status = "ok";
daily.notice = "基于 2026-06-12 已生成的真实行情日报刷新展示字段；免费源不保证稳定性；不构成投资建议。";
db.dailyReports[date] = daily;

const late = JSON.parse(JSON.stringify(daily));
late.type = "late";
late.date = date;
late.generatedAt = new Date().toISOString();
late.status = "simulated-preview";
late.source = "simulated-preview-derived-from-2026-06-12-daily-report";
late.notice = "模拟尾盘报告：用于查看页面效果，因无 2026-06-12 14:55 历史快照，股票池和价格字段由当日已生成真实日报派生，不冒充真实 14:55 数据。";
late.ratingPolicy = "尾盘报告与日报使用同一套行情热度评分；本报告为 2026-06-12 效果预览模拟版。";
late.previousDayStocksTodayChange = late.previousDayStocksTodayChange || { previousDate: "2026-06-11", date, status: "preview_no_previous_late", items: [] };
late.latePortfolio = buildPreviewPortfolio(late);
db.lateReports ||= {};
db.lateReports[date] = late;

db.jobLogs ||= [];
db.jobLogs.push({ jobName: "daily-report-refresh", startedAt: daily.generatedAt, finishedAt: new Date().toISOString(), status: "success", errorMessage: "", reportKey: date });
db.jobLogs.push({ jobName: "late-report-preview", startedAt: late.generatedAt, finishedAt: new Date().toISOString(), status: "simulated-preview", errorMessage: "derived from daily report because historical 14:55 quote is unavailable", reportKey: date });
db.jobLogs = db.jobLogs.slice(-200);

await writeFile("data/reports.json", `${JSON.stringify(db, null, 2)}\n`, "utf8");
await mkdir(join("outputs", "data", "reports", "daily"), { recursive: true });
await mkdir(join("outputs", "data", "reports", "late"), { recursive: true });
await writeFile(join("outputs", "data", "reports", "daily", `${date}.json`), `${JSON.stringify(daily, null, 2)}\n`, "utf8");
await writeFile(join("outputs", "data", "reports", "late", `${date}.json`), `${JSON.stringify(late, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  daily: daily.stocks.map(s => ({ name: s.name, changePct: s.changePct, isLimitUp: s.isLimitUp, businessConcepts: s.businessConcepts })),
  lateStatus: late.status,
  latePortfolio: late.latePortfolio
}, null, 2));

function enrichStock(stock) {
  stock.isLimitUp = isLimitUp(stock);
  stock.businessConcepts = businessConcepts(stock);
  return stock;
}

function buildPreviewPortfolio(report) {
  const netValue = 1;
  let cash = 1;
  const holdings = [];
  const bought = [];
  for (const stock of report.stocks || []) {
    if (stock.isLimitUp) {
      bought.push({ symbol: stock.symbol, name: stock.name, skipped: true, reason: "涨停无法买入" });
      continue;
    }
    const price = Number(stock.kline?.at(-1)?.close || 0);
    const allocation = netValue * 0.2;
    if (!price || cash < allocation) {
      bought.push({ symbol: stock.symbol, name: stock.name, skipped: true, reason: "价格数据不足或现金不足" });
      continue;
    }
    cash -= allocation;
    holdings.push({ symbol: stock.symbol, name: stock.name, entryPrice: price, shares: allocation / price, allocation, date: report.date });
    bought.push({ symbol: stock.symbol, name: stock.name, skipped: false, buyPrice: price, allocation });
  }
  return { date: report.date, netValue, cash: Number(cash.toFixed(6)), holdings, sold: [], bought, preview: true };
}

function isLimitUp(stock) {
  return Number(stock.changePct) >= limitUpThreshold(stock) - 0.15;
}

function limitUpThreshold(stock) {
  const name = String(stock.name || "").toUpperCase();
  const symbol = normalizeSymbol(stock.symbol);
  if (name.includes("ST")) return 5;
  if (symbol.startsWith("BJ")) return 30;
  if (/^(SZ30|SH68|SH69)/.test(symbol)) return 20;
  return 10;
}

function normalizeSymbol(symbol) {
  const raw = String(symbol || "").trim().toUpperCase().replace(".", "");
  if (/^(SH|SZ|BJ)\d{6}$/.test(raw)) return raw;
  if (/^6\d{5}$/.test(raw)) return `SH${raw}`;
  if (/^[038]\d{5}$/.test(raw)) return `SZ${raw}`;
  if (/^[492]\d{5}$/.test(raw)) return `BJ${raw}`;
  return raw;
}

function businessConcepts(stock) {
  const concepts = [];
  const name = String(stock.name || "");
  const known = [
    [/远东股份/, ["电线电缆", "智能缆网"]],
    [/铜冠铜箔/, ["电子铜箔", "锂电材料"]],
    [/诺德股份/, ["铜箔材料", "新能源材料"]],
    [/盛屯矿业/, ["有色金属", "矿产资源"]],
    [/宗申动力/, ["通用动力", "摩托车动力"]]
  ];
  for (const [pattern, labels] of known) if (pattern.test(name)) concepts.push(...labels);
  const text = `${stock.name || ""}${stock.industry || ""}`;
  const rules = [
    [/电缆|电线|光缆|电网|电力设备/, "电线电缆"],
    [/机器人|自动化|智能制造/, "机器人与自动化"],
    [/银行|证券|保险|金融|信托/, "金融服务"],
    [/半导体|芯片|集成电路|微电子/, "半导体"],
    [/软件|信息|数据|云|网络|科技/, "软件与信息服务"],
    [/汽车|车|汽配|电池|锂|新能源/, "汽车与新能源"],
    [/医药|生物|医疗|药|制药/, "医药生物"],
    [/电力|能源|光伏|风电|水电|煤|石油|燃气/, "能源电力"],
    [/地产|建筑|建材|水泥|工程/, "地产建筑"],
    [/消费|食品|饮料|酒|零售|家电|服饰/, "消费"],
    [/军工|航天|航空|船舶|兵器/, "军工装备"],
    [/钢铁|有色|金属|化工|材料/, "周期材料"],
    [/通信|电子|传媒|游戏/, "TMT"]
  ];
  for (const [pattern, label] of rules) if (pattern.test(text)) concepts.push(label);
  if (!concepts.length && stock.name) concepts.push("主营业务待确认");
  return [...new Set(concepts)].slice(0, 2);
}
