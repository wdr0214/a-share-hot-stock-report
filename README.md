# A 股行情热度报告

GitHub Pages 部署地址：

https://wdr0214.github.io/a-share-hot-stock-report/index.html

当前 GitHub Pages 入口会跳转到 Netlify 生产站点：

https://xueqiu-hot-stock-report-20260610230434.netlify.app

这样 GitHub 页面和 Netlify 页面使用同一套线上后端、定时任务和真实行情数据：

- 交易日 16:00 自动生成日报
- 周五 22:15 自动生成周报
- 默认显示最近已生成日报
- 使用真实行情、真实 K 线和大单资金净额指标
- 显示昨日入选股票今日涨跌幅

说明：GitHub Pages 只能托管静态页面，不能直接运行 Netlify Functions、Blobs 和 Scheduled Functions。因此当前 GitHub Pages 作为入口页，实际报告服务仍由 Netlify 承载。
