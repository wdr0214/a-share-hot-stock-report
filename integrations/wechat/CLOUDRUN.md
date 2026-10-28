# ETF大轮动：微信云托管部署

这是公众号草稿服务，不是微信云托管的默认 Express 欢迎页。只有 `/health` 返回
`service: etf-wechat-draft`，且真实草稿上传和回读成功，才表示接入完成。

## 部署代码

使用此目录作为 Docker 构建上下文，Dockerfile 为本目录的 `Dockerfile`。
也可上传打包好的代码 ZIP，解压后 Dockerfile 应位于构建根目录。
监听端口为 `80`，需要配置到云托管版本中；已有 ETF 行情网站无需修改。

不要把本目录之外的 `.env`、凭证文件、历史数据或完整工作目录上传。

## 服务环境变量

| 变量 | 设置 |
| --- | --- |
| `WECHAT_APP_ID` | “ETF大轮动”的公众号 AppID；不是以 `gh_` 开头的原始 ID |
| `WECHAT_AUTHOR` | `ETF大轮动` |
| `WECHAT_DRAFT_BRIDGE_SECRET` | 随机长密钥，私密配置，与 GitHub Secret 保持一致 |
| `GITHUB_REPORT_TOKEN` | 对报告仓库有 Contents 读写权限的令牌，只配置到服务端 |
| `WECHAT_THUMB_MEDIA_ID` | 可先留空，通过 `/cover` 上传永久封面后再配置 |

Dockerfile 已设置 `WECHAT_AUTH_MODE=cloudrun` 和 `WECHAT_STATE_BACKEND=github`。
此模式不需要 `WECHAT_APP_SECRET`，不调用 `stable_token`；通过官方 OpenAPI 侧车代管凭据。
不要把 cloudrun 模式用于普通公网 Node 服务；只有在启用了开放接口服务的微信云托管容器内才可用。

## 开放接口服务

在服务的“云调用/微信令牌/开放接口服务”配置中，启用官方开放接口服务，添加以下最小接口路径。
页面字段以实际控制台为准，改配置后按控制台要求重新发布版本：

```text
/cgi-bin/draft/batchget
/cgi-bin/draft/add
/cgi-bin/draft/get
/cgi-bin/material/add_material
```

此服务按照官方说明向容器内 `http://api.weixin.qq.com` 发起请求，凭据由侧车注入。
这不会扩大个人公众号本身的 API 权限；`48001` 仍表示该账号没有对应权限。

## 去重状态

云托管的容器本地文件不作为持久数据。草稿状态写入报告仓库的独立目录：
`data/wechat-draft-state/<AppID哈希>/<日期>.json`。
记录仅包含日期、内容摘要哈希、草稿素材 ID 和核验状态，不包含 AppSecret、访问令牌或 GitHub token。
该仓库若为公开仓库，这些状态记录也公开；草稿素材 ID 的读取仍需要微信 API 认证。
若希望状态记录不公开，可用 `WECHAT_STATE_REPO` 指定你自己的私有仓库，并授权对应 token。

通过 GitHub 文件 SHA 比较更新防止多个容器同时上传同一日草稿。
状态写入失败或结果不明时停止上传，不使用临时内存代替持久化状态。
这些状态记录提交会触发既有 Pages 工作流；草稿核验状态会阻止重复创建。

## 核验顺序

1. `GET /health` 应返回服务名、`authMode: cloudrun` 和 `stateBackend: github`。
2. 携带 `Authorization: Bearer <私密服务密钥>`，`POST /check`：只读取草稿列表以核实接口权限。
3. 用相同鉴权，`POST /cover`，`Content-Type: image/png` 或 `image/jpeg`，请求体为自己的封面文件（不超过 2MB）。
   将返回的 `thumbMediaId` 私密填入 `WECHAT_THUMB_MEDIA_ID` 后更新服务版本。
4. `POST /draft`，JSON `{"date":"当天北京时间日期"}`，应得到 `draft_verified`，到公众号草稿箱核对内容。
5. 再设置 GitHub Variable `WECHAT_DRAFT_BRIDGE_URL` 为服务的 HTTPS `/draft` 地址；
   Secret `WECHAT_DRAFT_BRIDGE_SECRET` 与服务端一致；Variable `WECHAT_DRAFT_ENABLED=true`。

本机测试、模拟 API 测试和 `/health` 存活都不能替代第 4 步的真实核验。
公网测试不会提交真实证券交易或自动公开发表公众号文章。

## 官方依据

https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/guide/weixin/open

在 2026-10-28 核实该文档中的凭据注入、接口路径配置及容器内调用方式。
环境是否免费、有效期和超额价格以你的云托管计费页面为准。
