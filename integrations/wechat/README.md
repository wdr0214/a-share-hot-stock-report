# ETF 轮动报告与个人公众号

个人主体先采用“真实报告自动生成文章 → 自动写入草稿箱 → 管理员在后台发表”。
微信的发布能力说明写明，自 2025 年 7 月起，个人主体等账号被回收发布相关接口权限。
草稿箱接口与公开发表接口不同；注册后需要实测草稿权限，不能用草稿成功来宣称已公开发表。

## 你先完成的注册步骤

1. 访问 https://mp.weixin.qq.com/ ，点击“立即注册”。
2. 选择供个人注册的公众号类型（旧界面称“订阅号”），主体选“个人”。
3. 按页面要求完成邮箱验证、地区选择、身份信息、管理员微信扫码核验。
4. 设置公众号名称、头像、简介，提交注册；身份核验、验证码和密码由本人操作。
5. 注册完成后登录后台，在开发/接口权限入口核对草稿箱能力。
6. 若 AppSecret 不在公众平台显示，访问 https://developers.weixin.qq.com/platform ，
   使用管理员微信登录，在“我的业务 → 公众号/服务号 → 基础信息/开发密钥”查找 AppID、AppSecret。
   菜单以实际后台为准，不要为找密钥随意重置已有凭证。

注册免费与否、可认证类型及收费均以当时后台为准。不要为获得自动发表能力付费购买不明服务。

## 已实现

- 仅从仓库 `outputs/data/reports/etf-rotation/YYYY-MM-DD.json` 读取该日真实 ETF 报告。
- 文章包含 6 个 ETF 的报告时点价格、20 日涨幅、28 日均线、持仓、调仓成交价和策略净值。
- “阅读原文”链接到独立净值曲线页 `etf-net-value.html?date=报告日期`，默认显示最近 20 个交易日，可滑动历史窗口、点击调仓点查看真实成交价格，并切换近一个月、近半年、近一年完整区间。不改变原 ETF 报告页。
- 当日无成功报告（包括休市日）则跳过，不用上一日数据冒充当日。
- ETF 报告的 GitHub Pages 工作流成功后，独立工作流自动生成 HTML/JSON 文章附件。
- 配置固定出口 IP 草稿服务后，工作流自动提交到草稿箱；保存草稿 ID 并回读核对。
- 同日期重复触发不会重复新建；提交超时的未知结果需先人工核对后台。
- 已核验草稿不会因仅更新原文链接而被自动覆盖或重复创建；旧草稿保留原链接，接口会明确返回 `sourceLinkUpdateRequired: true`。新日期的草稿自动使用独立曲线页。

既有 14:53 报告时点、数据、网页及 cron-job 任务保持原样。
公众号处理在报告写入仓库并完成工作流后发生，会有处理延迟。
完成服务、账号、封面配置并验证后才能启用微信草稿上传；不自动公开发表。

## 先在本机查看文章，不用账号

```powershell
node integrations/wechat/cli.mjs render 2026-10-28
node --test integrations/wechat/test.mjs
```

生成在 `.codex_tmp/wechat-preview/`。历史日期只用于预览，自动任务只处理当天。
GitHub Actions 的 `ETF WeChat Draft` 工作流附件为 `etf-wechat-article`。

## 注册后接入

### 微信云托管方案（ETF大轮动）

已提供云托管专用 Dockerfile、官方 OpenAPI 凭据代管模式和 GitHub 持久化去重存储。
无需自建固定出口 IP 服务器，也不需要在此模式下配置 AppSecret；仍需启用云托管开放接口服务并实测公众号草稿权限。
完整步骤见 [CLOUDRUN.md](./CLOUDRUN.md)。

### 普通固定 IP 服务器方案

微信获取 token 需要 IP 白名单。草稿服务应放在有固定公网出口 IP 的云服务器上，
并将这个出口 IP 加入公众号后台白名单；GitHub 托管 runner、普通 Vercel 函数的动态出口
不作为默认直连方案。此服务需持久磁盘、进程守护及 HTTPS 反向代理；无固定 IP 服务时尚不能云端自动上传。

服务器的私有环境变量（不要写进 Git 或对话）：

| 变量 | 用途 |
| --- | --- |
| `WECHAT_APP_ID` | 公众号 AppID |
| `WECHAT_APP_SECRET` | 公众号 AppSecret |
| `WECHAT_AUTHOR` | 文章作者，可选 |
| `WECHAT_THUMB_MEDIA_ID` | 永久封面素材 ID |
| `WECHAT_THUMB_MEDIA_ID_HOLD` | 有持仓且无交易时使用；未填则用默认封面 |
| `WECHAT_THUMB_MEDIA_ID_REBALANCE` | 有持仓且有交易时使用；未填则用默认封面 |
| `WECHAT_THUMB_MEDIA_ID_CASH` | 无持仓时使用，包含当天卖出后空仓；未填则用默认封面 |
| `WECHAT_STATE_DIR` | 仓库和网站目录以外的持久私有目录 |
| `WECHAT_DRAFT_BRIDGE_SECRET` | 随机生成的服务鉴权密钥 |

先运行 `node integrations/wechat/cli.mjs check`：它仅获取 token、读取草稿列表以检查权限。
业务返回码 `48001` 表示权限不足，`40164` 表示出口 IP 未加入白名单，不能称接入成功。

上传一次自己的封面：`node integrations/wechat/cli.mjs upload-cover 封面.png`，
将返回的 `thumbMediaId` 保存为 `WECHAT_THUMB_MEDIA_ID`，然后启动：

```text
node integrations/wechat/server.mjs
```

服务默认监听 `127.0.0.1:8789`。对外经 HTTPS 暴露 `POST /draft`；
GET `/health` 仅表示服务存活，不证明微信权限或草稿上传成功。

GitHub 仓库 Settings → Secrets and variables → Actions：

- Variables：`WECHAT_AUTHOR`，`WECHAT_DRAFT_BRIDGE_URL`（服务完整 HTTPS `/draft` 地址）。
- Secrets：`WECHAT_DRAFT_BRIDGE_SECRET`，与服务端相同。
- 完成一次真实草稿上传和回读后，将 Variable `WECHAT_DRAFT_ENABLED` 设置为 `true`。

AppSecret 只保存在固定 IP 服务器上，不传入 GitHub 工作流，也不发送至其他平台。
cron-job 继续生成 ETF 报告即可，草稿工作流跟随成功的报告工作流执行；不新增 GitHub 定时触发。

## 异常处理

- 有草稿 ID 但核验失败：再次触发仅回读，不重复上传。
- 状态为 `creating`：上次提交结果未知，先在微信后台按日期标题核对，再由维护人员校正私有状态文件。
- 锁文件残留：确认没有任务运行并核对后台后，才移除该日 `.lock` 目录。
- 当天报告内容被改写：不自动再生成第二份草稿，由维护人员核对后更新既有草稿。
- 私有状态目录应备份，丢失状态会丢失去重依据。

## 官方资料

- 发布能力：https://developers.weixin.qq.com/doc/service/guide/product/publish.html
- 新增草稿：https://developers.weixin.qq.com/doc/service/api/draftbox/draftmanage/api_draft_add.html
- 获取草稿：https://developers.weixin.qq.com/doc/service/api/draftbox/draftmanage/api_draft_get.html
- 获取稳定 token：https://developers.weixin.qq.com/doc/service/api/base/api_getstableaccesstoken.html

在 2026-10-28 读取了上述发布能力、草稿和 token 官方文档；最终按注册账号的接口实测结果接入。
