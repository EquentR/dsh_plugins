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

HTTP 模式下，已保存密码仅显示占位提示：留空保存或测试会保留原密码；输入新密码会替换它，勾选「清除已保存的密码」会明确删除密码。清空用户名或保存 SOCKS5 模式时，Host 也会清除鉴权信息。

主机、端口、用户名、密码和绕过列表在离开字段后显示局部校验提示；保存和测试也会检查全部字段。无效草稿仍可点击操作按钮，以查看原因；未修改的有效草稿、只读或正在处理时保存不可用。字段提示通过 `aria-invalid` 和 `aria-describedby` 关联。

操作按钮附近只显示最近一次保存、测试或失败的反馈；编辑任何草稿字段（包括协议、启用开关及清除密码）都会清除旧反馈。发生版本冲突时重新读取最新值并替换草稿，同时保留冲突说明，需检查后再次保存；读取失败可点击「重试读取」。

页面沿用 Harness 主题别名：最大宽度 820 px、20 px 分区间距、16 px 卡片内边距、12 px 卡片圆角及 38 px 高的输入控件。保存按钮使用主题品牌色浅底；启用开关支持键盘和 `role="switch"`，控件提供可见焦点圈。页面不导入 Harness 内部 UI 组件，样式由 Client 插件的 `apply` 生命周期安装并清理。

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
6. 主机留空、端口越界或只填密码不填用户名，离开字段后检查局部提示；点击保存或测试，确认显示校验原因且不会发送无效请求。
7. 测试成功或失败后分别编辑普通字段、切换协议、切换启用开关及勾选清除密码，确认旧操作反馈消失；成功保存后测试失败时只保留最新测试失败反馈。
8. 在其他位置修改同一插件设置，再保存旧草稿，确认页面读取最新值并保留冲突说明；模拟读取失败，确认重试可恢复。
9. 用 Tab / Space 操作启用开关及密码清除复选框，检查可见焦点、标签对应关系；在浅色、深色和窄屏下检查布局、提示及按钮对比度。

这些手工步骤需要已安装的插件和连接中的 Web UI；源码语法和仓库校验不能证明页面实际渲染、代理可达或 Profile 写入成功。

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
