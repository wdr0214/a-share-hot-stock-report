import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const targetDate = process.argv[2] || "2026-06-12";
const title = "A 股行情热度报告（尾盘+收盘报告）";
const db = JSON.parse(await readFile("data/reports.json", "utf8"));
const report = db.dailyReports?.[targetDate];
if (!report) throw new Error(`daily report not found: ${targetDate}`);

for (const stock of report.stocks || []) {
  stock.isLimitUp = isLimitUp(stock);
  stock.businessConcepts = businessConcepts(stock);
}

report.generatedAt = new Date().toISOString();
db.dailyReports[targetDate] = report;

await writeFile("data/reports.json", `${JSON.stringify(db, null, 2)}\n`, "utf8");
await mkdir(join("outputs", "data", "reports", "daily"), { recursive: true });
await writeFile(join("outputs", "data", "reports", "daily", `${targetDate}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await refreshHtmlTitle();

console.log(JSON.stringify({
  date: targetDate,
  title,
  stocks: report.stocks.map((stock) => ({
    symbol: stock.symbol,
    name: stock.name,
    changePct: stock.changePct,
    isLimitUp: stock.isLimitUp,
    businessConcepts: stock.businessConcepts
  }))
}, null, 2));

async function refreshHtmlTitle() {
  const path = "outputs/xueqiu-stock-report.html";
  let html = await readFile(path, "utf8");
  html = html.replace(/<title>.*?<\/title>/, `<title>${title}</title>`);
  html = html.replace(/<h1>.*?<\/h1>/, `<h1>${title}</h1>`);
  await writeFile(path, html, "utf8");
}

function isLimitUp(stock) {
  const threshold = limitUpThreshold(stock);
  return Number(stock.changePct) >= threshold - 0.15;
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
  for (const [pattern, labels] of known) {
    if (pattern.test(name)) concepts.push(...labels);
  }
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
