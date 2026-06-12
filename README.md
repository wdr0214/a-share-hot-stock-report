# A 股行情热度报告

GitHub Pages 独立部署地址：

https://wdr0214.github.io/a-share-hot-stock-report/

这个仓库使用 GitHub Actions + GitHub Pages 独立运行，不依赖 Netlify：

- 交易日 16:00 自动生成日报
- 周五 22:15 自动生成周报
- 默认显示最近已生成日报
- 使用真实行情、真实 K 线和大单资金净额指标
- 显示昨日入选股票今日涨跌幅

## GitHub 独立部署机制

GitHub Pages 不能运行后端服务，因此本项目用 GitHub Actions 生成静态报告数据：

- `.github/workflows/github-pages.yml` 定时运行日报/周报任务。
- `data/reports.json` 保存历史报告数据库。
- `outputs/data/reports/*` 保存页面可直接读取的静态 JSON。
- `outputs/index.html` 是 GitHub Pages 入口页面。

## 本地运行

```bash
npm install
npm run check
npm run run:daily -- 2026-06-12
npm run export:static
npm start
```

## 数据原则

- 不采集雪球用户讨论。
- 不使用 Cookie、模拟登录、反爬或代理池。
- 不生成模拟股票或模拟 K 线。
- 免费源的大单指标使用“大单/超大单资金净额”，不是完整逐笔大单成交额。
- 报告仅用于信息整理，不构成投资建议。
