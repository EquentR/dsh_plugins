# 桌面版接入外部 dsh 后端与多后端支持：可行性总报告

> 调研对象：DeepSeek Harness 桌面版 `0.2.1-rc.2`（Electron 壳 + 内置 dsh runtime）
> 调研方式：解包 `app.asar` 读源码 + 真实起停后端做实测
> 结论性质：可行性判定与实施方向建议；**未修改任何源码、未改动用户配置**
> 配套分报告：[桌面壳](./multi-backend-desktop-shell.md)、[鉴权链路](./multi-backend-auth-chain.md)、[107 旧版鉴权改造](./multi-backend-legacy-107.md)

---

## 一、结论摘要

**可以做，但真正的工程量不在前端，也不在鉴权，而在 Electron 壳。**

1. **"界面"与"后端"在桌面版里已经是分离的两层。** 界面跑在自定义协议 `dsh-app://app/` 下，后端是壳用主进程 `fetch` 私享的 `127.0.0.1:<临时端口>`。后端地址对渲染层是**注入值**（`__DSH_TRANSPORT__.streamBaseUrl`），不是硬编码。这是多后端可行的结构性前提。
2. **鉴权链可以直接复用，几乎零新代码。** 每个后端跑一次 `GET /?token=...` 就能换出该后端专属的签名 cookie；桌面壳里已有现成函数 `authenticateWebHost()` 就是干这个的。cookie 按 authority 命名，天然一后端一份、互不串用。
3. **跨源是纯网页方案的死结，但对桌面壳不构成障碍。** `/api` 强制 `Origin` 与 `Host` 同 authority，跨站一律 403，且**没有 CORS 头**——`--trusted-host` 只放开 Host 白名单，**不放开 Origin**（这是最容易误解的一点）。桌面壳能跑通，是因为它绕过了浏览器语义：主进程删掉 `origin`/`sec-fetch-site`、手工塞 `cookie`，WebSocket 用 `onBeforeSendHeaders` 重写。**所以"多后端"必须做在壳层，不能做在插件层。**
4. **版本是本次调研最重要的意外发现。** 桌面内置 runtime 是 `0.2.1-rc.2`，而 npm `@latest` 只有 `0.2.0-rc.2`——**桌面自带的 dsh 比 npm 最新版还新**。`0.2.1-rc.2` 已原生支持 `--host <具体局域网 IP>`、`--public-url`、`--tls-cert/--tls-key`（`0.2.0-rc.2` 三项都没有，且只接受 `127.0.0.1`）。**因此"用 npx 装一个最新版 dsh 给桌面用"这条路走不通，只能用桌面自带的 runtime。**
5. **107 的账号密码改造可以借鉴，且已验证可移植。** 它是插件形态的"认证网关反向代理"：core 仍用 token/cookie，插件在非 loopback 网卡上另起 listener，要求账号密码，自己持有 core cookie 再转发。**在隔离环境实测：2 处一行级修补后完整跑通**（登录页 → 会话 → 正向代理 GUI → WS 鉴权 → 421 Host 校验）。但它补的是**远程多用户接入与登录页**，**不提供"一个界面里切换多个后端"**。两者正交，需要各自实现。
6. **今天就有零代码的过渡方案**：侧边栏浏览器 tab（独立 partition 的 webview）可以完整运行第二个 dsh（HTTP 和 WS 都放行），或直接用系统浏览器打开另一个 `dsh web` 实例。

---

## 二、现状架构：三层分离

```
┌─────────────────────────────────────────────────────────┐
│  Electron 主进程 (lib/main.js)                           │
│  · hostUrl / hostCookie  ← 单例模块变量（12135-12136）    │
│  · protocol.handle("dsh-app")  ← 唯一转发目标（12406）    │
│  · WS onBeforeSendHeaders  ← 硬编码 127.0.0.1（12447）    │
└──────────┬──────────────────────────────┬───────────────┘
           │ spawn(--no-open --host 127.0.0.1 --port 0)
           │ IPC "ready" {url, injections}
           ▼                              │ 主进程 fetch 反代
┌──────────────────────────┐              │（剥 origin/cookie，
│ 内置 dsh host 子进程      │              │  塞 hostCookie）
│ 0.2.1-rc.2               │◄─────────────┘
│ 127.0.0.1:<OS 临时端口>   │
└──────────────────────────┘
           ▲
           │ 渲染层：HTTP 走文档相对路径（必过壳代理）
           │        WS 走 __DSH_TRANSPORT__.streamBaseUrl（绝对 origin）
┌──────────────────────────────────────────┐
│ 渲染层 dsh-app://app/                     │
│ 静态资源 = 本地 dist；其余 = 反代到后端     │
└──────────────────────────────────────────┘
```

| 层 | 多后端支持现状 | 改动需求 |
|---|---|---|
| 客户端连接层（RPC/WS/事件流） | ✅ 已参数化 | **零改动** |
| Web 前端 dist | ✅ 只认注入值 | **零改动** |
| Electron 主进程 | ❌ 全单例 | **必须改** |
| 客户端插件 | ❌ 无切换 IPC | 需新增只读展示（可选） |
| 后端鉴权 | ⚠️ 可复用，一后端一份 | 复用现成逻辑 |

**关键含义：多后端是"壳的一个新功能"，不是"插件能解决的事"。** 现有插件体系拿不到任何能换后端的通道——`preload` 只暴露 `dshDesktop`/`dshDesktopBoot`/`dshPlatform` 等，没有后端管理面（`lib/preload-app.cjs:844-882`）。

---

## 三、鉴权机制全貌（实测 + 源码双确认）

### 3.1 链路

```
① dsh web 启动 → 内存生成 32 字节随机 token（进程级、重启必变）
                → 打印 http://<authority>/?token=<token>

② 浏览器 GET /?token=<token>
     ├─ 无 token / 错 token / token 重复 / 非 GET / 非根路径 → 401
     └─ 正确 → 303 Location: ./
                Set-Cookie: dsh-auth-<sha256(authority) 的 base64url>=v1.<payload>.<hmac>
                            Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict
                            （仅当监听器是 TLS 时才带 Secure）

③ 后续每个 API 方法与 WebSocket 都验这个 cookie
```

### 3.2 我方实测记录

| 测试 | 结果 |
|---|---|
| `GET /` 无 token | **401** |
| `GET /?token=<正确>` | **303** + `Set-Cookie`（payload 含 `authority`、`issuedAt`、`expiresAt`） |
| `GET /?token=<错误>` | **401** |
| 带正确 cookie `GET /` | **200** |
| A 端口 cookie 发给 B 端口 | **401**（cookie 名按 authority 反查，结构上找不到） |
| `/api/*` 带跨源 `Origin` | **403** |
| `/api/*` 带 `sec-fetch-site: cross-site` | **403** |
| `/api/*` 响应是否含 CORS 头 | **完全没有** |
| **后端进程重启后，旧 cookie** | **仍然 200**（密钥持久化在 `~/.dsh/.credentials.yaml`） |
| `--host 192.168.55.20` 绑局域网 IP | **成功**，警告"plain HTTP，请限制到可信代理或网络" |
| 绑局域网 IP 后伪造 `Host: evil.example.com` | **401** |

### 3.3 两个容易误解的点

1. **`--trusted-host` 不解决跨源。** 它只决定 Host 白名单；`Origin` 必须与 Host 同 authority 这条是独立的、无开关的（`dsh-client-connection/lib/index.js:245` vs `:249`）。
2. **cookie 跨重启有效是双刃剑。** 免去每次重启重贴 token，但系统**没有 logout**，撤销只能删 `.credentials.yaml` 里的 `client-connection/browser-session` 记录或清 cookie。

### 3.4 与"账号密码"的关系

- `account` 命名空间是**云端 DeepSeek Platform 账号与计费**（`platform.deepseek.com`、OAuth+PKCE、`x-dsh-auth-token`），与"登录到某个 dsh 后端"完全正交，多后端方案**不需要动它**。
- `owner` 不是"持有有效 cookie 的那个连接"，而是**所有通过认证的连接**（浏览器 cookie 和 API cookie 都映射到 `{kind:'owner'}`）。`dsh-api-remote-access` 的多角色 RLS 是**已建成但未启用的空转能力**。**因此当前 dsh 没有"多用户"概念——这正是需要借鉴 107 的根本原因。**

---

## 四、107 旧版鉴权改造：逆向结论与可借鉴性

详见[分报告](./multi-backend-legacy-107.md)。要点：

**机制**：独立插件 `@yiln-dsh/dsh-plugin-auth-webserver`，在事件循环内起"认证网关"。
- 对每个**非 loopback 网卡地址**单独 `listen`（绝不绑 `0.0.0.0`），校验 Host/Origin → 检查账号密码/cookie → `proxyRequest()` 转发到 `127.0.0.1:3080`；**WebSocket upgrade 同样鉴权**。
- 账号密码放 `~/.dsh/settings.yaml` 的 `auth-webserver:` 命名空间；会话是自签 HMAC cookie + 独立 CSRF cookie；另有 TOTP 2FA、WebAuthn passkey、登录页、限流、`421` Host 校验。
- **"非本地"不是靠 remote_addr 判断，而是靠 listener 分离**：原生 loopback listener 仍是 core 的 token 流程，只有网关 listener 才要账号密码。

**它与 core token/cookie 的关系是"并行叠加"，不是"替换"**：网关用 `ctx.connection.authenticatedUrl(origin)` 拿到带 `?token=` 的 URL，自己发一次 GET 收下 303 + core cookie 存内存，此后转发时**剥掉浏览器传来的 `dsh-auth-*`、换成自己的 core cookie**，并且不把 core 的 `Set-Cookie` 透传给远程浏览器。（单用户/单网关模型，没有多租户身份映射。）

| 可借鉴 | 不可借鉴 |
|---|---|
| 认证网关反向代理这个形态 | 指望它提供"一个界面切多个后端"——它不做这件事 |
| listener 分离来区分"本地/远程" | 逐网卡绑定的实现细节（新版可直接 `--host` 单地址） |
| 剥掉浏览器 cookie、网关独占 core cookie | 单用户模型（无多租户身份映射） |
| 登录页 + CSRF + 限流 + TOTP | 靠字符串匹配 core client bundle 打补丁的 `settings-client-patch.js`（跨版本极脆） |

**借鉴价值判断**：`0.2.1-rc.2` 虽然原生支持绑局域网 IP + TLS，但鉴权仍是**单一共享 cookie、所有认证者都是 owner、无 logout、无多用户**。所以"远程多人安全接入"这个诉求，107 的思路**仍然是最贴近的参考**。而"多后端切换"则是另一件事。

### 4.1 可移植性已实测验证（在隔离环境，未碰现役服务）

在 `0.2.0-rc.2` + 独立 `DSH_HOME` 下装 107 的插件，结果：**不是不可移植，而是 2 处一行级修补即可完整跑通。**

**两处不兼容（都有精确根因）**：

1. `settings.register is not a function` —— `0.2.0+` 的 `dsh-settings` 主类换成 `SettingsForms`，`register()` 被移除，命名空间改由 profile entry id 决定。
2. 登录成功后一律 **503 "Upstream authentication unavailable"** —— core 的 token 兑换 303 的 `Location` 从 `/` 改成了 `./`，而插件写死 `location !== "/"`。

```diff
--- index.js:597
-  if (settings !== undefined) {
+  if (settings !== undefined && typeof settings.register === "function") {

--- core-session.js:155
-  if (response.statusCode !== 303 || location !== "/" || cookie === null) {
+  if (response.statusCode !== 303 || (location !== "/" && location !== "./") || cookie === null) {
```

修补后完整链路实测全通：未登录 → 登录页；表单登录 → `{"ok":true}`；带 cookie → **真实 GUI（69163 字节，非登录页）**；带 cookie 访问 API → 404（上游返回，证明代理转发成功）；伪造 Host → 421；未登录 WS upgrade → 401；双 listener（loopback + LAN，同 pid）。

**三个关键接缝在新版全部存活**（这是"可移植"的硬依据）：`webServer.tapIndex()`、`connection.authenticatedUrl()`、`clientModules.rebuilt()`。

3. ⚠️ **必须警惕的失败模式是"静默降级"**：第一轮插件激活失败时，core 照常起、`?token=` 照常打印、服务看起来正常，但 **LAN listener 根本没起**。方向是对的（fail-closed，不意外暴露），但运维会以为一切正常，直到有人抱怨连不上。**任何基于插件扩展远程访问的方案，都必须有"监听是否真的起来了"的显式健康检查。**

### 4.2 真正该借鉴什么：四项能力缺失

"能不能远程访问"已不再是借鉴理由（`0.2.1-rc.2` 原生支持绑 LAN IP + TLS + public-url）。真正的理由是 `0.2.1-rc.2` **仍只有「单一进程 token → 单一 cookie → 所有通过认证者都是 owner」**，缺四样刚需：

| 缺失 | 后果 |
|---|---|
| **没有身份** | 拿到 `?token=` 或 cookie 就是 owner，无法区分使用者。多后端场景下"每后端一套凭据"必须靠它 |
| **没有登出** | cookie 30 天有效，只能删 `.credentials.yaml` 或关进程 |
| **没有撤销粒度** | 无法踢掉某一台设备 |
| **没有审计** | 不知道谁在何时从哪个 IP 登录过 |

这四项恰好是"桌面版接多后端 + 鉴权"的刚需，也是 107 那套改造最值得移植的部分（`authEpoch` 全局失效、登出+逐条撤销+踢断 WS、CSRF 双校验、会话只存元数据不落 bearer）。

---

## 五、三条候选路线

### 路线 A：壳内后端注册表（推荐，满足"一个界面切多后端"）

把 `hostUrl`/`hostCookie` 单例换成 `Map<backendId, {url, cookie, kind, label}>` + `activeId`。

**改动点**（全部在 `lib/main.js` + `lib/preload-app.cjs`，前端零改动）：
1. 后端注册表替换单例（`12135-12136`）。
2. `protocol.handle` 按 activeId 分派转发目标（`12406-12415`）。
3. **放宽 WS 过滤器**：`12447` 硬编码的 `["ws://127.0.0.1/*","wss://127.0.0.1/*"]` 改为足够宽的模式，保留回调内 `requested.host === target.host` 的校验（`12452-12457` 已有这层判断）+ 把 `webContentsId === mainWindow` 改为按窗口所属后端映射。
4. `boot` IPC 返回当前后端的 `{injections, streamBaseUrl}`（`12424-12432`）。
5. 新增 IPC：`backends-list/add/remove/activate`，按 `assertDesktopSender` 严格校验来源。
6. 后端表持久化到 `app.getPath("userData")`，**不要**写进 Host settings（换后端就换文档了）。

**并存的干净做法**：用 `dsh-app://b2/` 给每个后端独立 origin（`dsh-app` 已注册为 `standard+secure`，不同 hostname 即不同 origin，Chromium 自动隔离 localStorage/IndexedDB）。约 8 处"常量换查表"，**无架构性阻塞**。

**最大硬点：`injections` 的来源。** 桌面现在的注入表只能从"壳自己 spawn 的子进程 IPC"拿到（`ctx.webServer.collectIndexInjections()` 是进程内 API）。对"别人机器上已经跑着的 dsh"，壳没有通道。三条出路：
- **(i) 外部后端也由壳托管启动**（spawn 自带 runtime / 指定 profile）——改动最小、语义最一致。**推荐作为 MVP。**
- **(ii) 后端侧加一个受鉴权的 Remote 把注入表当 JSON 返回**——这**可以做成插件**（`dsh-web-app` 组合里的一个 Host 插件），不必改 core。这是本项目（插件仓库）最适合承担的增量。
- (iii) 壳用 cookie 再 `GET /` 拿已渲染的 index 解析——脆弱且等于信任远端 HTML，**不推荐**。

### 路线 B：纯网页/插件直连远程后端（不可行）

跨源三重封锁（SameSite=Strict + Origin 同 authority + cross-site 拒绝），且**无 CORS 头**。插件里 `fetch` 直连另一后端必然失败；改 `__DSH_TRANSPORT__` 强切也不行（`installConnection` 只读一次，且 `connection` 服务已被占用）。**结论：放弃。**

### 路线 C：107 式认证网关（解决"远程多用户安全接入"，与 A 正交）

作为独立 Host 插件移植到 `0.2.1-rc.2`：在指定非 loopback 网卡上起鉴权反代，账号密码 + HMAC 会话 + CSRF，内部借用 core cookie。**它能单独交付价值**（让局域网/公网安全访问某个后端），但不解决"界面内切后端"。

---

## 六、推荐实施方向

**分三期，每期独立可交付、可回滚。**

### 第 0 期：零代码过渡（今天就能用）
- 侧边栏浏览器 tab 打开 `http://<host>:<port>/?token=...`（独立 partition，HTTP/WS 均放行，只拦应用自身 host）。
- 或用系统浏览器直接开另一个 `dsh web` 实例。
- 用途：立刻验证"多后端并存"的实际体验，收集真实需求（比如是否需要共享会话列表、是否要并排看）。

### 第 1 期：壳内后端注册表（核心价值）
- 先做**仅"托管式外部后端"**（路线 A 的 (i)）：壳能 spawn 第二个 runtime/profile，注册表 + 切换 + `dsh-app://b2/` 隔离。
- 同步做**版本一致性校验**：比对目标后端 `release {version, commit}` 与本地壳内置 dist 的 release，不一致就拒绝并明确提示。**异 release 混搭会导致白屏/模块解析失败，这是必须前置的门禁。**
- 交付物：一个"后端管理"页（`settings.section` slot 插件，纯客户端）+ 壳侧 IPC。

### 第 2 期：接任意已运行后端 + 远程鉴权
- 写 `@dsh-plugins/*` Host 插件：受鉴权地暴露 index 注入表（路线 A 的 (ii)），让壳能接管"别人机器上已在跑的 dsh"。
- **移植 107 的认证网关思路到 `0.2.1-rc.2`**。已验证只需 2 处一行修补即可跑通旧版插件；但**建议按新 API 重写而非直接 fork 0.7.6**（它依赖 `settings.register`、甚至字符串匹配 core client bundle，跨版本极脆）。重点移植：listener 分离判定"非本地"、core-session-bridge 模式、账号密码 + HMAC 会话 + CSRF、`authEpoch` 全局失效、登出/撤销/踢断 WS、`421` Host 双栅栏。
- **必须带健康检查**：监听是否真的在 LAN 网卡上起来了（防静默降级）。
- 若走公网，务必启用 `--tls-cert/--tls-key`——**明文 HTTP 下传输账号密码等于明文泄露**（107 的报告已把这条列为"不可借鉴"）。

---

## 七、硬约束与风险（必须先接受）

1. **壳的改动无法以插件分发。** 桌面版是 asar 打包 + `electron-updater` 自动更新，改动 `lib/main.js` 会被下次更新覆盖，也不属于本插件仓库的分发形态。**若要产品化，需要上游支持；若要自用，需接受每次更新后重新打补丁。**
2. **release 必须匹配。** 本地 dist 外壳 + 远端 `/plugins/*` bundle 只在同 release 下安全。所以"接任意版本后端"不应作为产品目标；且 npm 上没有桌面正在跑的 `0.2.1-rc.2`（只有 `0.2.0-rc.2`），**"用 npx 装最新版给桌面"行不通**。
3. **一次性 token 的 UX 摩擦。** token 是进程级、重启必变；虽然 cookie 跨重启有效，但**首次注册**仍需要拿到带 token 的 URL。托管式启动可自动获取，接别人机器上的则必须手工粘贴。
4. **安全面扩大。** 允许任意 URL 会让主进程代发请求到任意地址（SSRF 面）并注入响应体。必须限制协议（http/https）、限制为 loopback 或显式 allowlist（可参考后端自己的 `trustedHosts` 思路），并**永不把 token/cookie 回传渲染层**（保持现状：cookie 只由壳持有）。
5. **loopback 语义被壳"伪造"。** `ownsHost:true` 让 `isLoopback` 恒真，一些"仅本机可做"的功能（打开配置文件、原生目录选择、Platform 账号视图）在接远程后端后仍会按本机语义开放，需按后端真实拓扑逐一复核。
6. **单页面只有一棵 Client 树。** "并存"必须靠多窗口/多 origin，不能靠单页面多连接。

---

## 八、方向调整（第二轮，用户已重新定位重点）

用户明确将重点从"多后端切换"后置为两件事：**107 原地升级后鉴权网关是否还有用**、以及**Windows 本地 dsh 如何支持被反代**。结论如下（详见各专项报告）：

1. **107 已原地升级到 `0.2.0-rc.2`，鉴权网关仍然可用且成为唯一路径。** 升级后 `--host 192.168.55.107` 与 `--host 0.0.0.0` **两个方向都被代码堵死**（config schema 只认 `127.0.0.1`/`0.0.0.0`，且后者被 startup 主动拒绝）→ 原生零远程访问能力。打 **3 处**补丁（比预估多一处：`settings.register` 守卫、`Location "./"`、以及**凭据必须从 `settings.yaml` 搬到 `cordis.patch.yml`**）后完整链路通过，含已登录 WS `101`。详见 [107 报告](./multi-backend-legacy-107.md) §9/§10。
2. **"静默降级"是这类方案的致命陷阱**：插件激活失败时 core 照常起、token 照常打印、`systemctl` 仍 `active`，但 LAN listener 根本没起。唯一可靠的健康检查是**看监听 socket 是否真的在 LAN 地址上**。
3. **桌面版（`0.2.1-rc.2`）情况更好**：它**原生支持** `--host <任意具体 IP>`、`--public-url`、`--tls-cert/--tls-key`。因此对桌面版，网关的"通路必需性"消失，只剩下"身份增强"（账号/登出/撤销/审计）的价值。
4. **dsh 可以被反向代理，已端到端实测**（详见 [Windows 反代报告](./multi-backend-reverse-proxy-windows.md)）。两条铁律：**反代必须保留客户端 `Host`**（cookie audience 按它计算，改写会无限 401）+ **必须设 `--trusted-host <公网 authority>`**（对照实验：声明→404 放行，未声明→403）。
5. **"Windows 直接崩溃"的根因已定位并验证修复**：107 插件 `readPrivateSecret()` 用 POSIX 权限位校验（`mode & 0o077`），Windows 上 mode 恒为 `0666`、`chmod` 对权限位是 no-op → **只能成功启动一次**（已亲自复现：cold MOUNTED → 2nd/3rd REJECTED）。加 `process.platform !== "win32"` 分支后**连续 4 次启动全部成功**。崩溃在**插件本体**，不在 systemd；`web-daemon` 那层才是 Linux-only，且它只返回错误不会崩。

---

## 九、待决问题

1. **是否需要多用户/账号/登出/审计？** 这是唯一决定"要不要移植 107 插件"的问题。只要单用户安全远程访问，原生 flag + Caddy/nginx 就够了。
2. **TLS 由谁终止？** 推荐 dsh 自己终止（cookie 才带 `Secure`）；若用代理终止 TLS，cookie 无 `Secure`，需保证代理与 dsh 同机。
3. **服务端用哪个 profile？** 建议 `--profile web`（只有 `dsh-base` + `dsh-web-app`）；`desktop` profile 绑定了 Electron 相关实验 bundle 与本机 link 插件路径，不适合长期常驻。
4. **多后端切换**（原第 1-3 期路线）已后置；若日后重启，最大硬点仍是 `injections` 只能来自壳 spawn 的子进程 IPC。

---

## 十、证据索引

| 结论 | 证据 |
|---|---|
| 界面 origin = `dsh-app://app`，静态本地 dist、其余反代 | `lib/main.js:11880-11890, 12406-12415` |
| `hostUrl`/`hostCookie` 单例 | `lib/main.js:12135-12136` |
| WS 过滤器硬编码 loopback + 仅主窗口 | `lib/main.js:12447-12469` |
| 反代时剥 origin/cookie 并塞 hostCookie | `lib/main.js:8243-8255, 8268-8299` |
| Origin 白名单 `dsh-app://app` | `lib/main.js:8271` |
| boot IPC 返回 `{injections, streamBaseUrl}` | `lib/main.js:12424-12432`；`lib/preload-app.cjs:863-866` |
| preload 无后端管理面 | `lib/preload-app.cjs:844-882` |
| token→303→cookie 实现 | `dsh-client-connection/lib/index.js:271-281, 294-300, 440-497` |
| cookie 属性（HttpOnly/SameSite=Strict/按 TLS 加 Secure） | `dsh-client-connection/lib/index.js:347-350` |
| `/api` Host/Origin 栅栏、cross-site 拒绝 | `dsh-client-connection/lib/index.js:240-269` |
| `trustedHosts` 只管 Host 不管 Origin | `dsh-client-connection/lib/index.js:245` vs `:249` |
| cookie 名按 authority 反查 | `dsh-client-connection/lib/index.js:559-570` |
| `__DSH_TRANSPORT__` 为公开契约 | `dsh-client-connection/README.zh.md:30,34` |
| 0.2.1-rc.2 接受任意具体 IP、只拒通配 | `dsh-host-webserver/lib/index.js:251-266`；`dsh-web-app/lib/startup.js:48` |
| 桌面启动参数 `--no-open --host 127.0.0.1 --port 0` | `dsh-desktop-host/lib/index.js:234-240` |
| 版本门禁（异 release 不应用） | `dsh-client-modules/README.zh.md:47` |
| 设置页 = `settings.section` slot | `dsh-client-ui-settings-general/lib/client.js:1293-1303` |
| account = 云端 Platform 账号 | `dsh-deepseek-account-platform/lib/index.js:501,508`；`README.zh.md:39,43` |
| owner 仅两处、RLS 空转 | `dsh-client-connection/lib/index.js:714, 781-791` |
| 反代必需 `--trusted-host`（对照实验） | 见 [Windows 反代报告](./multi-backend-reverse-proxy-windows.md) §3.1 |
| cookie audience 跟随客户端 Host | `dsh-client-connection/lib/index.js:307-316` |
| `secure` 只来自监听器协议 | `dsh-client-connection/lib/index.js:745, 808-809` |
| 插件 Windows 崩溃点（POSIX 权限位） | auth-webserver `index.js:374-387` |

**版本假设**：以上源码结论基于 `0.2.1-rc.2`（构建 commit `332895e0`）。上游若改动 `hostUrl` 注入方式、`__DSH_TRANSPORT__` 契约或 WS 头改写策略，需重新核对。
