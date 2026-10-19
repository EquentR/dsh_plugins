# @dsh-plugins/network-proxy

给 DSH Web 设置增加一个**网络代理**页：为 Host 的出站 HTTP 请求配置 HTTP 或 SOCKS5 代理。HTTP 模式支持用户名/密码鉴权；SOCKS5 模式刻意不提供鉴权字段，因为 Chromium 不支持 SOCKS5 用户名/密码鉴权。

## 能力

- Settings 左侧导航新增「网络代理」页；保存后立即重载插件行并安装/卸载代理策略。
- 两种协议：
  - `HTTP`：支持 Basic 用户名/密码鉴权；
  - `SOCKS5`：支持无需鉴权的 SOCKS5 代理。
- `不走代理的地址`：逗号或空格分隔的域名后缀，可带 `:端口`；`*` 表示全部直连。
- 本机地址始终直连：`localhost`、`*.localhost`、`127.0.0.0/8`、`::1`、`0.0.0.0` 及其 IPv4-mapped 写法。这样 DSH 自己的 Web UI、Connection 和本地测试服务不会绕进代理形成回环。
- 「测试连接」按钮通过当前草稿配置发起一次真实请求，返回 HTTP 状态和耗时。
- 密码字段使用 `role("secret")`，Settings 读取时由 DSH 的设置服务脱敏；页面只显示「已保存」，不会回传明文。

## 作用范围

这个插件安装的是 **Host 进程的全局 undici dispatcher**，因此覆盖普通 `fetch()` 以及通过 `globalThis.fetch` 发请求的 SDK，例如：

- 模型 provider 的 HTTP 请求（不含 WebSocket transport）；
- `web_search` / `web_fetch`；
- HTTP MCP transport。

它**不覆盖**：

- **桌面端 Chromium 自身的流量**（Web UI、设置页、Electron 的 `<webview>`、更新检查）。插件运行在 Host，不在 Electron 主进程，无法调用 `session.setProxy`。如果目标是让 Chromium 走代理，需要在启动桌面端时传入 `--proxy-server`，例如：
  ```text
  --proxy-server="http://host:port"
  --proxy-server="socks5://host:port"
  ```
  Chromium 支持 `http` 和 `socks5` 两种 `--proxy-server`，但**不支持 SOCKS5 用户名/密码鉴权**；HTTP 代理鉴权会由 Chromium 自己的代理登录流程处理。
- WebSocket transport（例如使用 `ws` 的 provider）；
- workflow / PTC 等 worker 线程；
- 已经在启动时由 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 安装的环境代理。插件会覆盖 Host 的全局 dispatcher，但 `dsh-web-fetch-http` 在环境代理存在时会把环境策略的 dispatcher 显式传给请求，因此 `web_fetch` 可能仍走环境代理。设置页会提示这一点；要完全以本页为准，请清除这些环境变量后重启 Host。
- 子进程（`curl`、`git`、`pnpm` 等）。它们继承自己的环境变量，不由本插件改写。

## 安装

本包是持久包，安装到当前 profile：

```text
plugin_manager action=install_bundle target=<network-proxy 目录的绝对路径>
```

或：

```powershell
dsh plugin --profile web add <network-proxy 目录的绝对路径>
```

本包把 `undici@8.11.2` 声明为普通依赖：linked 安装下，`lib/proxy.js` 里的 `import('undici')` 不会去 DSH 运行时的 `node_modules` 找包，因此必须先在插件目录安装它：

```powershell
cd network-proxy
pnpm install --config.auto-install-peers=false
```

`--config.auto-install-peers=false` 是必须的；否则 pnpm 会把 `peerDependencies` 里的 DSH 包也当成待安装依赖。profile 只链接包目录，不会把插件的依赖装进 profile。

装完通常需要重启 Host 并刷新页面。插件行默认 `enabled: false`：代理关闭，但设置页已经可用。

## 使用

1. 打开 **Settings → 网络代理**。
2. 选择 `HTTP` 或 `SOCKS5`，填写主机与端口。
3. HTTP 模式可填写用户名和密码；SOCKS5 模式没有鉴权字段。
4. 需要时填写「不走代理的地址」。
5. 点「测试连接」确认代理可达，再打开「启用代理」并保存。
6. 保存后设置页会显示「已生效」和当前策略（密码以 `***` 显示）。

HTTP 代理 URL 的构造方式：

```text
http://user:password@host:port
```

SOCKS5 代理 URL 的构造方式：

```text
socks5://host:port
```

## 验证

仓库级校验：

```powershell
node scripts/validate.mjs
```

手工验证：

1. 启动一个本地 HTTP 代理（或已有的企业代理），确认其地址和端口。
2. 在设置页填好地址，点「测试连接」：
   - 成功时显示 `HTTP <status>` 和耗时；
   - 代理需要鉴权而凭据错误时显示连接失败。
3. 打开「启用代理」并保存，确认设置页显示「已生效」。
4. 让 Agent 调用一次 `web_fetch` 或发起一次模型请求，确认 Host 日志没有代理连接错误。
5. 关闭「启用代理」并保存，确认 Host 恢复直连。

## 已知限制

- **不能配置 Chromium**：这是 Host 插件边界，不是配置问题。桌面端 Chromium 代理需要在启动参数中设置。
- **SOCKS5 无鉴权**：与 Chromium 的能力保持一致。undici 本身可以支持 SOCKS5 用户名/密码，但本插件不暴露该字段。
- **WebSocket 不经过 dispatcher**：使用 WebSocket transport 的 provider 需要自行配置代理。
- **环境变量代理优先于 `web_fetch`**：见上文「作用范围」。
- **代理不可用时可能影响模型请求**：启用前请先用「测试连接」验证；Host 日志会记录应用失败原因（凭据会被脱敏）。
- **代理密码写入 Profile 配置**：DSH 的 Settings 服务以插件配置形式持久化 secret。不要把包含该 Profile patch 的文件提交到仓库或分享给他人。

## 兼容性

按 DSH `0.2.1-rc.2` 核对：

- Host 服务：`connection`、`settings`、`configEditor`（可选）；
- Client 槽位：`settings.section`；
- 包内依赖：`undici` 8.11.2（`ProxyAgent`、`Socks5ProxyAgent`），与 DSH 运行时版本一致。

升级 DSH 到其他版本前，请重新核对 Settings 槽位和 `connection.fetch.register` 的 shared Fetch route 契约。
