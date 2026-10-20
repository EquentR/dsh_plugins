# 桌面版（Electron 壳）接入外部 dsh 后端与多后端可行性调研

- 调研对象：DeepSeek Harness Desktop `v0.2.1-rc.2`（Electron 壳 + 内置 dsh runtime），构建 commit `332895e0`
- 解包路径：`C:\Users\UT\AppData\Local\Temp\dsh-asar-extract`（`lib/` = 主进程与 preload，`renderer/` = 欢迎页/更新页，`dsh/node_modules/@deepseek-ai/` = 306 个内置 dsh 包）
- 现场事实：壳启动后本地后端监听 `127.0.0.1:62293`（= 当前会话 `DSH_WEB_URL`），`DSH_PROFILE=desktop`，profile 目录 `C:\Users\UT\.dsh\profiles\desktop`
- 本文只做只读分析，未修改任何源码、未启动/重启服务。所有结论均给出 `文件:行号`，逐条列在文末「证据附录」。

---

## 一、结论摘要

1. **桌面界面并不是"以本地 HTTP 服务为 origin 的网页"，而是跑在自定义协议 `dsh-app://app/` 下的静态前端**；`127.0.0.1:62293` 只是壳用主进程 `fetch` 私享的后端，renderer 从不以它为 `location.origin`。也就是说，"界面"与"后端 HTTP origin"在桌面版里**已经是分离的两层**，这一点是全篇最重要的结构性事实（`lib/main.js:11880-11890`、`12406-12415`、`8268-8299`）。
2. **后端 endpoint 在渲染层是"注入值"，而不是硬编码**：壳通过 IPC 把 `{ injections, streamBaseUrl }` 交给页面，页面把它装成 `globalThis.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }`；Gateway 的 Remote Mux WebSocket 正是用它解析绝对 origin（`lib/main.js:12424-12432`、`dsh-web-frontend/dist/assets/index-CN7NIWNw.js` 入口片段、`dsh-api-gateway/lib/client.browser.js:761`）。**因此"把界面指向另一个后端"在 web 前端层面几乎不需要改代码，改动集中在壳。**
3. **HTTP 侧已天然支持"任意后端"（因为由主进程代发、无 CORS、无 SameSite 限制），但 WebSocket 侧只放行 `127.0.0.1`**：`onBeforeSendHeaders` 的过滤器硬编码 `["ws://127.0.0.1/*","wss://127.0.0.1/*"]`，并把 `Origin: dsh-app://app` 改写成后端 origin、补 `cookie` 与 `sec-fetch-site: same-origin`（`lib/main.js:12447-12469`）。这是指向远程后端时第一个必须绕过的硬点。
4. **端口来源是"随机临时端口"**：内置 host 以 `--no-open --host 127.0.0.1 --port 0` 启动，端口由 OS 分配，`ctx.webServer.port` 取 `server.address().port`，随后 `authenticatedUrl()` 拼上一次性 launch token 通过 IPC `ready` 交给壳；端口只存在于主进程内存变量里，**不落盘、不可配置**（`dsh-desktop-host/lib/index.js:234-240,342-349`、`dsh-host-webserver/lib/index.js:292-295,466-476`、`lib/main.js:12135-12196`）。多后端必须由壳新增"后端注册表"。
5. **"后端管理页"本身可以是纯客户端插件（无需改核心），但"切换/添加后端"这个动作不行**：设置页在插件体系里是 `settings.section` slot 的一次注册（`dsh-client-ui-settings-general/lib/client.js:1258-1261,1293-1303`、`dsh-client-ui-settings-models/lib/client.js:4485-4501`、`dsh-client-ui-settings-plugins/lib/client.js:201-212`）；但 renderer 里没有任何"告诉壳换后端"的 IPC 通道（preload 只暴露 `dshDesktop` / `dshDesktopBoot` / `dshOnboarding` / `dshPlatform` / `__DSH_DIRECTORY_PICKER__` / `__DSH_HOST_PATHS__`，`lib/preload-app.cjs:844-882`），所以开关后端 = 壳改动（main + preload）。
6. **今天就能"多后端并存"的零代码绕道**：右侧 Sidebar 浏览器 tab（Electron `<webview>`，独立 partition）可以打开任意 HTTP(S) 页面，只拦"同端口且 loopback / 同 host"的应用自身后端（`lib/main.js:10635-10663`、`dsh-client-ui-sidebar-browser/README.zh.md:12,43`）。所以把另一台/另一个端口的 dsh（`http://127.0.0.1:8080/?token=…`）塞进 tab 是可行的，但它不是主界面，且需要用户手工贴 token URL。

---

## 二、壳如何启动后端、如何把 URL 注入界面（含端口来源）

### 2.1 启动链路（自底向上）

```
app.whenReady()
 └─ main()                                              lib/main.js:12042
     ├─ resolveDesktopPaths()  → {profile: ~/.dsh/profiles/desktop}   lib/main.js:79-84
     ├─ new DesktopBackendController(createHost, publish)            lib/main.js:12180
     ├─ mainWindow = createMainWindow()                             lib/main.js:13128
     └─ await reconcileBackend()  → backend.start(prepare)           lib/main.js:13178
            └─ host.start() → spawn(electron --expose-internals <dsh>/…/dsh-desktop-host/lib/index.js  runtimeDir profileDir primaryRuntime [pnpm nodeBin])
                                                                     lib/main.js:3791-3811
            └─ child IPC "ready" → { url, injections }               lib/main.js:3818-3827
               hostCookie = await authenticateWebHost(ready.url)     lib/main.js:12191
               hostUrl    = ready.url                               lib/main.js:12192
               injections = ready.injections                        lib/main.js:12194
```

- 子进程用 **Electron 自身以 Node 模式**（`ELECTRON_RUN_AS_NODE=1`）运行，`stdio: [ignore, pipe, pipe, ipc]`，因此 URL 与注入表走 IPC 通道而不是 stdout（`lib/main.js:3649-3657`、`3802-3811`）。
- 内置 host 入口是 `dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`，它调用 `runProfile({ profile: "desktop", args: ["--no-open","--host","127.0.0.1","--port","0"] })`（`dsh-desktop-host/lib/index.js:226-250`）。

### 2.2 端口来源：OS 临时端口，绝不固定

- `--port 0` → `dsh-host-webserver` 在 `listen` 回调里读 `this.server.address().port` 存进 `listenedPort`，`get port()` 返回它（`dsh-host-webserver/lib/index.js:466-476`、`292-295`）。
- host 随后执行：
  `url = ctx.connection.authenticatedUrl(`${ctx.webServer.protocol}//127.0.0.1:${ctx.webServer.port}`)`
  即 `http://127.0.0.1:<临时端口>/?token=<一次性启动令牌>`，并连同 `ctx.webServer.collectIndexInjections()` 一起 `process.send({type:"ready", url, injections})`（`dsh-desktop-host/lib/index.js:342-349`）。
- 令牌来源：每进程随机 `randomBytes(32)`，`authenticatedUrl()` 只往 URL 上加 `?token=`（`dsh-client-connection/lib/index.js:294-300,440-444`）。
- **结论**：当前实现里"端口"不是配置项、不持久化、重启即换；壳侧只有单一模块级变量 `let hostUrl; let hostCookie;`（`lib/main.js:12135-12136`）。这直接决定了：**要做多后端，必须先在主进程引入"后端 = { id, url, cookie, 生命周期 }"的注册表**，否则没有第二个 URL 的容身之处。

### 2.3 认证交换：壳把 cookie 装在自己手里，不交给页面

```js
// lib/main.js:8229-8236
async function authenticateWebHost(url) {
  const response = await fetch(url, { redirect: "manual" });     // 命中 ?token → 303 + set-cookie
  const cookie = response.headers.get("set-cookie");
  if (response.status !== 303 || cookie === null) throw new Error("Desktop Host authentication failed");
  ...
}
```

- 对应后端侧逻辑：`GET /?token=` 校验通过后 `303 → ./` 并 `set-cookie`（host-only、`Path=/`、`HttpOnly`、`SameSite=Strict`、按 `host:port`（HTTPS 时按 origin）绑定，`dsh-client-connection/lib/index.js:458-497`、`335-349`）。
- 代理转发时 `set-cookie` 被**主动丢弃**，不进入 Chromium cookie jar；壳自己持有 cookie：

```js
// lib/main.js:8243-8255  响应头黑名单
const WITHHELD_RESPONSE_HEADERS = ["set-cookie","content-encoding","content-length",...];
// lib/main.js:8275-8282  请求头重写
headers.delete("host"); headers.delete("origin"); headers.delete("cookie"); headers.delete("sec-fetch-site");
headers.set("cookie", cookie);
```

### 2.4 注入链路：`__DSH_BOOT_READY__` + IPC boot + 前端自己装配 transport

这是"界面如何拿到后端地址"的关键，共四步（全部有代码证据）：

1. 壳返回静态 `index.html` 时，在 `<head>` 后插入一个未决信号（`lib/main.js:8221`）：
   `<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>`
2. preload 在 `dsh-app://app` 文档里暴露 `dshDesktopBoot.ready() / .failed()`（`lib/preload-app.cjs:863-866`），主进程 handler 返回 `{ injections, streamBaseUrl: new URL(hostUrl).origin }`（`lib/main.js:12424-12432`）。
3. 前端入口（bundle 尾部）检测 `globalThis.dshDesktopBoot`，拉取后**装配 transport 并把注入行打进文档**：
   ```js
   globalThis.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl: n };
   await PZ(injections, …);   // global / script / script-src / style / html 六种行的页内解释器
   r.resolve();               // resolve __DSH_BOOT_READY__
   ```
   （`dsh-web-frontend/dist/assets/index-CN7NIWNw.js`，入口片段；`PZ` 即行解释器，含 `case "global": globalThis[r.name]=r.value`）
4. 之后就按常规 Web 流程走：`__ModuleLoader__` bootstrap → `__DSH_BOOT__`（启动图全局）→ 惰性加载 `/plugins/...` 客户端 bundle（`dsh-client-modules/lib/index.js:460-505`、`README.zh.md:69,85`）。

注入行本身由各 host 插件通过 `webserver/index-inject` 贡献：`__ModuleLoader__` queue facade、application combo 的 `script-preload`、bootstrap combo 的 `script-src`、以及 `{kind:"global", name:"__DSH_BOOT__", value: graph}`（`dsh-client-modules/lib/index.js:485-504`）；`__DSH_CONNECTION_RECOVERY__` 由 connection 插件推入（`dsh-client-connection/lib/index.js:1037-1043`）。

> 设计含义：**"页面启动输入"在桌面版是 IPC + 进程内行表，而不是 HTTP index 渲染**。`dsh-host-webserver` 的两条路径被 `README.zh.md:67` 明确写成"同一批行，一个渲染进 index 文本，一个随 boot payload 交给页内解释器"。桌面走的是后者。

---

## 三、renderer origin 与安全边界（CSP / cookie / CORS）

### 3.1 应用文档的 origin 是自定义协议，不是 `http://127.0.0.1:62293`

```js
// lib/main.js:11880-11890
protocol.registerSchemesAsPrivileged([{ scheme: "dsh-app",
  privileges: { standard:true, secure:true, supportFetchAPI:true, corsEnabled:true, stream:true, codeCache:true }}]);
// lib/main.js:12406-12415
protocol.handle(SCHEME, (request) => {
  const url = new URL(request.url);
  if (url.hostname === "shell") return serveWebDocument(request, join(app.getAppPath(), "renderer"));
  if (url.hostname === "app") {
    if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname.startsWith("/assets/") ||
        ["/favicon.svg","/manifest.webmanifest"].includes(url.pathname))
      return serveWebDocument(request, join(resources.dsh,"node_modules","@deepseek-ai","dsh-web-frontend","dist"));
    if (backend.host === void 0 || hostUrl === void 0 || hostCookie === void 0) return new Response(null,{status:503});
    return forwardWebRequest(request, hostUrl, hostCookie);   // ← 其余一律反代到后端
  }
  return new Response(null, { status: 404 });
});
```

- 主窗口 `loadURL("dsh-app://app/")`（`lib/main.js:12134`、`12940`）。
- 所以：**`/assets/*` 是本地壳（内置 `dsh-web-frontend/dist`），`/api/*`、`/plugins/*`、`/connect` 等一切非静态路径由主进程代发到后端**。这也解释了 `GET http://127.0.0.1:62293/` 返回 401：那条 URL 上的 index 需要 token/cookie，而桌面根本不走它。

### 3.2 三道边界各自的实际作用

| 边界 | 是否阻挡"多后端" | 证据 |
|---|---|---|
| **CSP** | ❌ 不挡。应用文档（`dist/index.html`）**没有 CSP meta**，`serveWebDocument` 也不加响应头 CSP；壳自己的 `renderer/*.html` 才带 CSP | `dsh-web-frontend/dist/index.html:1-18`（无 CSP）；`renderer/welcome.html:6`、`renderer/update-dialog.html:6`、`renderer/mandatory-update.html:6`（带 CSP）；`lib/main.js:8202-8222`（无 CSP 头） |
| **CORS** | ❌ 不挡。HTTP 由主进程 `fetch` 代发（`forwardWebRequest`），不是浏览器跨域请求；`dsh-app` 协议虽然 `corsEnabled:true`，但代理响应不依赖 CORS 头 | `lib/main.js:8268-8299` |
| **same-site cookie** | ❌ 不挡（同时也意味着**壳独占**）。cookie 不进入页面 jar，`set-cookie` 被黑名单掉，请求时由主进程硬塞 `cookie` 头 | `lib/main.js:8243-8255,8282` |
| **`Origin` 白名单** | ⚠️ 挡（要改）。`forwardWebRequest` 只接受 `Origin === "dsh-app://app"`；WS 改写只接受 `headers.origin === "dsh-app://app"` | `lib/main.js:8270-8271`、`12459-12462` |
| **preload 白名单** | ⚠️ 挡（要改）。`assertDesktopSender(event, ["app"])` / `location.hostname === "app"` / `startsWith("dsh-app://app/")` 遍布 IPC 与 preload | `lib/main.js:7015-7020,7052,8271,12459,12472,12531,12871`；`lib/preload-app.cjs:844,876,877` |
| **`will-navigate`** | ⚠️ 出站导航被锁；只允许 `dsh-app:` 与"当前 origin 的 http" | `lib/main.js:12032-12039` |
| **会话/分区** | 所有窗口共用 `session.defaultSession`；Sidebar webview 用独立 partition 且禁止访问应用自身 host | `lib/main.js:10481-10512,10635-10663` |

补充：`BrowserWindow` 是 `nodeIntegration:false, contextIsolation:true, sandbox:true, webSecurity:true`（`lib/main.js:11960-11968`），所以"页面直接调 Node/文件系统换后端"这条路在架构上就是关着的。

### 3.3 WebSocket 是唯一"绕过代理直连后端"的通道

```js
// lib/main.js:12447-12469
session.defaultSession.webRequest.onBeforeSendHeaders(
  { urls: ["ws://127.0.0.1/*", "wss://127.0.0.1/*"] }, (details, callback) => {
    if (hostUrl === void 0 || hostCookie === void 0 || details.webContentsId !== mainWindow?.webContents.id) return callback({});
    const target = new URL(hostUrl), requested = new URL(details.url);
    if (requested.host !== target.host || requested.protocol !== (target.protocol === "https:" ? "wss:" : "ws:")) return callback({});
    if (headers.origin !== "dsh-app://app") return cancel;
    callback({ requestHeaders: { ...headers, origin: target.origin, cookie: hostCookie, "sec-fetch-site": "same-origin" } });
});
```

- 目的：浏览器 WS 握手会带 `Origin: dsh-app://app`，而后端的 browser trust fence 要求 `Origin` 与 `Host` 同 authority，且 `sec-fetch-site` 不能是 `cross-site`（`dsh-client-connection/lib/index.js:240-250`）。壳把它"洗"成同源。
- **硬点**：过滤器 URL 模式写死 `127.0.0.1`，且 `details.webContentsId` 必须等于主窗口。远程后端（或第二个窗口）这条都不满足。
- 另注：Sidebar webview 的 partition 上也挂了 `onBeforeRequest` 直接 cancel 一切 WS（`lib/main.js:10635-10647`）。

---

## 四、客户端 endpoint 解析机制：现在是"同源相对 + 注入绝对 origin"的混合体

### 4.1 HTTP：文档相对路径 → 必然经过壳的代理

```js
// dsh-client-connection/lib/client.browser.js:1209-1231
const send = doFetch ?? ((input, init) => globalThis.fetch(input, init));
...
const response = await send(`${channel}/${endpoint}`.slice(1), { method:"POST", ... });  // 形如 "api/session/list"
```

相对路径 => 以 `document.baseURI`（`dsh-app://app/`）为基准 => 命中外壳 `protocol.handle` => `forwardWebRequest` => 后端。**浏览器端从不直接访问后端的 HTTP origin。**

### 4.2 WebSocket：`__DSH_TRANSPORT__.streamBaseUrl` 绝对 origin

```js
// dsh-client-connection/lib/client.browser.js:1348-1354
function openConnectionWebSocket(path, factory = (url) => new WebSocket(url), baseUrl) {
  const base = baseUrl ?? document.baseURI;
  const url = new URL(path.slice(1), base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return factory(url.href);
}
// :1423
openWebSocket: (path) => openConnectionWebSocket(path, transport?.createWebSocket, transport?.streamBaseUrl)
// :1503-1511  （插件体：唯一读取点）
const transport = globals.__DSH_TRANSPORT__;
installConnection(ctx, { ...transport === void 0 ? {} : { transport }, recovery: resolveConnectionConfig(globals.__DSH_CONNECTION_RECOVERY__), location });
// :1424
isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname)
```

Gateway 侧同样读这个全局：

```js
// dsh-api-gateway/lib/client.browser.js:106,761
const REMOTE_STREAM_MUX_PATH = "/api/remote.mux";
const url = new URL(REMOTE_STREAM_MUX_PATH.slice(1), globals.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI);
```

包文档也把它写成了**公开契约**：

> 「静态桌面页面可以通过 `__DSH_TRANSPORT__.streamBaseUrl` 提供其所拥有 Host 的 HTTP origin。Gateway 将该 origin 用于 WebSocket，HTTP 传输仍独立选择。桌面载体负责认证；仅设置 origin 不会授予访问权限。」——`dsh-client-connection/README.zh.md:30`

### 4.3 "是否已支持指向任意远程后端？"

**分层回答：**

| 层 | 是否已支持 | 说明 |
|---|---|---|
| 客户端连接层（RPC / WS / 事件流） | ✅ 支持 | endpoint 全部来自注入；`installConnection` 还接受 `transport.fetch` / `transport.createWebSocket` 覆盖（`:1382-1387,1423`），文档明确说"同一 realm 中的多棵 Client 树可以使用不同载体"（`README.zh.md:34`） |
| web 前端壳（`dsh-web-frontend` dist） | ✅ 支持 | 只认 `dshDesktopBoot` + `__DSH_TRANSPORT__` + `__DSH_BOOT__`，不认任何具体地址 |
| Electron 主进程 | ❌ 不支持 | `hostUrl`/`hostCookie` 单例；协议处理器只有一个目标；WS 过滤器只认 `127.0.0.1`；启动流程只能 spawn 内置 host |
| 认证 | ⚠️ 半支持 | `authenticateWebHost()` 对 authority 无假设（只要求 `303 + set-cookie`），**换成远程 URL 逻辑上可直接复用**；但没有"输入/保存第二个 URL 与 token"的入口 |
| 插件（客户端） | ❌ 不支持 | 没有可用的 IPC 通道把"切换后端"意图传达给壳 |

另外两个必须知道的**跨版本约束**：
- `/plugins/*` 的 bundle 由**后端**提供（`dsh-client-modules/lib/index.js:202,563-573`），而页面外壳（`/assets/*`、平台模块表 `SZ()`）由**本地 dist** 提供。二者属于同一个 release 才安全：启动图携带 `release { version, commit }`，"两个字段都相等才算同一个 release"，异 release 的图不会被应用、只提示刷新（`dsh-client-modules/README.zh.md:47`；`dsh-client-ui-settings-general/README.zh.md:34`）。**所以接一个版本不同的 dsh 后端，即使连通也可能白屏/模块解析失败。**
- 页面用 `__DSH_TRANSPORT__` 是否存在来判断"桌面/自有载体"：`"dshDesktop" in globalThis`、`transport?.streamBaseUrl !== undefined` 之类判断散落在客户端插件里（如 `dsh-client-ui-settings-account/lib/client.js:4669-4671`、`dsh-client-ui-settings-models/lib/client.js:4436`）。切后端时这些语义会被"继承"，需要逐一复核。

---

## 五、实现"多后端 + 后端管理页"的改动清单

### 5.1 最小可行路径（MVP：单窗口内切换，本地/远程均可）

按改动量从小到大：

**A. 壳侧（必须，`lib/main.js` + `lib/preload-app.cjs`）**

1. **后端注册表**：把 `let hostUrl; let hostCookie;`（`lib/main.js:12135-12136`）替换为 `backends: Map<id, {url, cookie, kind:"bundled"|"external", label}>` + `activeId`。bundled 分支仍由 `DesktopHostProcess` 启动（`:3791-3850`、`:12180-12249`）。
2. **外部后端接入**：新增一种 backend，其 `url` 来自用户粘贴的 `http://host:port/?token=…`（或 `https://…`），复用 `authenticateWebHost()`（`:8229-8236`）拿 cookie；不需要 spawn、不需要 profile。注意 token 是一次性进程令牌，**主进程重启后失效**，需要重新粘贴 → 注册表应允许保存"基础 URL"但把 token 标为易失。
3. **协议处理器按 origin 分派**：`protocol.handle` 里 `url.hostname === "app"` 的转发目标改为 `backends.get(activeId)`；`forwardWebRequest` 的 `Origin` 白名单（`:8271`）保持 `dsh-app://app` 不变即可（页面 origin 不变）。
4. **WS 过滤器放宽**：把 `{urls:["ws://127.0.0.1/*","wss://127.0.0.1/*"]}`（`:12447`）改成按当前后端动态计算的 `ws(s)://<它的 authority>/*`（Electron 的 filter 是静态注册，需在切换时 `onBeforeSendHeaders(null?)`/重新注册，或一次注册足够宽的 `["ws://*/*","wss://*/*"]` 并在回调里按 `requested.host === target.host` 判定——回调里已有这层校验，见 `:12452-12457`）。**这是最简单的一步：放宽 filter、保留回调内的 host 校验。**
5. **boot IPC 跟随 activeId**：`DESKTOP_IPC.boot` 返回 `{ injections, streamBaseUrl }` 必须来自当前后端（`:12424-12432`），且 `injections` 要**每次切换后重新 `collectIndexInjections()`**——注意：注入表是 host 进程内的，壳自己拿不到；外部后端要么由壳走一个 RPC 取（目前没有该 Remote），要么改成"页面向当前 origin 的相对路径取表"。
   ⚠️ **这是最隐蔽的阻塞点**：桌面现在的注入表来自 spawn 子进程的 IPC（`dsh-desktop-host/lib/index.js:346`），外部后端没有这条通道。解决办法二选一：
   - (i) 外部后端仍由壳 spawn（只是 `npx`/其他 profile/runtime），沿用 IPC；或
   - (ii) 让页面从 `GET /` 取"后端渲染版 index"并解析注入行 —— 但那需要后端愿意无 cookie 返回 index 给壳（`dsh-host-frontend-static` 要求 token/cookie，`README.zh.md:12`），实际不可行；因此**（i）是正解**。
6. **切换动作**：`activeId` 变更 → 重新 `navigateMain("dsh-app://app/")`（`:12940` / `:12162-12178`），使页面按新 `__DSH_TRANSPORT__` 重跑一次 boot。页面 ORIGIN 不变，所以 localStorage 等会共享（见 5.3）。
7. **新 IPC 面**：`dsh-desktop:backends-list / add / remove / activate`（preload `contextBridge.exposeInMainWorld`，`:863-866` 同款），并像 `assertDesktopSender(event,["app"])` 那样校验来源（`:7015-7020`）。
8. **持久化**：`app.getPath("userData")` 下写 JSON（壳已有 `readDesktopSettings(userData)` 先例，`:12043`），**不要**写进 profile/settings 文档（那是每个后端自己的文档，`dsh-client-ui-settings/README.zh.md:36`）。

**B. 前端（`dsh-web-frontend` / 客户端插件）**

- **零改动**即可跑通 MVP：transport、boot 注入、`/plugins` 代理都是参数化的。若要更好的 UX（顶栏后端切换器），加一个客户端插件读新 IPC（`globalThis.dshDesktop.backends…`）即可，不需要动 `dsh-web-frontend`。

**C. 版本一致性（必做校验）**

- 加进 MVP 的前置检查：读取目标后端 release（`__DSH_BOOT__.release` 或注入图）与本地壳 `readDesktopRuntime(resources.dsh).release`（`lib/main.js:103-114`）比对，不等就拒绝或明确警告。否则用户会得到很难解释的模块加载失败。

### 5.2 若要"并存"（多窗口 / 每后端独立会话）

- 单窗口切换（5.1）只解决"换"，不解决"同时开两个"。
- **并存的干净做法**：用自定义协议的第二段做后端身份 —— `dsh-app://b2/`。因为 `dsh-app` 已注册为 `standard+secure`（`:11880-11890`），**不同 hostname 就是不同 origin**，Chromium 自动隔离 localStorage/IndexedDB/CacheStorage，天然满足"cookie/存储隔离"。改动点：
  - `protocol.handle` 的 `url.hostname` 分派改查表（`:12409`）；
  - `forwardWebRequest` 的 `Origin` 校验从 `=== "dsh-app://app"` 改为 `=== \`dsh-app://${hostname}\``（`:8271`）；
  - WS 回调的 origin 校验同样参数化（`:12459`）；
  - `assertDesktopSender(event, ["app"])` 的 hostname 列表按需扩展（`:7015-7020`，签名已支持数组）；
  - `preload-app.cjs` 里三处 `location.hostname === "app"` 改为白名单（`:844,876,877`）；
  - `main.js` 里 `startsWith("dsh-app://app/")` 的若干处（`:11251,12472,12531,12871`）改为按窗口所属后端判定；
  - 取消"只有 mainWindow 能发 WS"的限制（`:12448`），改为 `webContentsId → backendId` 映射。
  - 另需每个后端一个 `BrowserWindow`（当前只有 `mainWindow`/`welcomeWindow`/若干对话框，`:12068-12071,12888`）。
- 成本评估：上述 8 处都是"把常量换成查表"，**没有架构性阻塞**，但属于壳的核心路径改动（`assertDesktopSender` 是安全边界，必须慎重）。

### 5.3 硬阻塞点清单（按"是真的改不动 / 必须做设计取舍"排序）

1. **注入表来源**（最硬）：`injections` 只能从"壳自己 spawn 的子进程 IPC"获得（`lib/main.js:12193-12194`、`dsh-desktop-host/lib/index.js:346`，调用的是 `ctx.webServer.collectIndexInjections()`，纯进程内 API）。⇒ 对"B 机上已经跑着的 dsh"，壳没有现成通道。三条出路，按推荐度：
   - (i) **外部后端仍由壳托管启动**（spawn 任意 runtime/profile 的 host 进程），沿用现有 IPC —— 改动最小、语义最一致；代价是"外部后端"必须是本机可 spawn 的进程。
   - (ii) 后端侧新增一个受鉴权的 Remote，把注入表以 JSON 返回（需要改后端包，并新增鉴权面）。
   - (iii) 壳用 cookie 再 `GET /` 一次，后端会返回**已渲染注入行**的 index（`dsh-host-webserver/lib/index.js:522-534`、`dsh-host-frontend-static/README.zh.md:12`）。但那条路径产出的是 **markup**，而桌面页内解释器吃的是 **JSON 行数组**（`PZ`），需要额外写一层 HTML→行 的转换，脆弱且不安全（等于信任远端 HTML）。不推荐，但可作为"零后端改动"的最后手段。
2. **一次性 token / cookie 归属**：`authenticateWebHost` 要求 `303 + set-cookie`（`:8233`）；远程 dsh 的 token 打印在其终端（`dsh-web-app/README.zh.md:41,83`）。⇒ UX 上无法完全自动，除非让壳 spawn 时自己读 stdout（当前 `--no-open` 场景下 URL 只经 IPC 上报，不走 stdout，`:3805-3817`）。
3. **release 必须匹配**：本地 `dist` 外壳 + 远端 `/plugins` bundle 的混搭只在同 release 下安全（`dsh-client-modules/README.zh.md:47`）。⇒ "连任意版本的后端"不是产品目标，只能"连同 release 的后端"，或每后端带自己的 dist（则要从后端取 `/assets/*`，摧毁"壳持有界面"的前提）。
4. **单一 Connection / 单页面板**：一个页面只有一棵 Client 树、一个 `ctx.connection`（`dsh-client-connection/lib/client.browser.js:1503-1511`），不存在"同一界面同时订阅两个后端事件流"的官方能力。想要"并存"必须多页面/多窗口，而不是单页面多连接。
5. **loopback 语义被外壳"伪造"**：`ownsHost:true` 让 `isLoopback` 恒为真（`:1424`）。接到远程后端后，"仅本机可做"的功能（打开配置文件、原生目录选择、Platform 账号视图等，`dsh-client-ui-settings-general/README.zh.md:52,84`）仍会按本机语义开放，需要按后端真实拓扑复核。
6. **安全面扩大**：现在后端绑定 loopback + 单实例 + token，攻击面很小。允许任意 URL 后，`forwardWebRequest` 会以主进程身份向任意地址发请求（SSRF 面）、并把响应体注入页面。必须限制协议（http/https）、限制为 loopback 或显式 allowlist（可参考后端自己的 `trustedHosts` 思路，`dsh-client-connection/README.zh.md:47`）。

---

## 六、设置页扩展点：新增"后端管理"页该怎么做

### 6.1 机制（纯插件即可，无需改核心）

设置面板是**slot 账本**的投影，页面就是一次 `settings.section` 注册。规范写法：

```js
// dsh-client-ui-settings-general/lib/client.js:1258-1261  外壳声明子 slot
"settings.section": { kind: "list", scope: "root" }
// :1293-1303  官方「通用」分区
ctx.slots.inject("settings.section", () => ctx.slots.register({
  name: "settings.section", id: "general", order: 0,
  label: () => t("general.nav"), locale: NS,
  children: { "settings.general.item": { kind: "list", scope: "root" } }
}, GeneralSection));
```

```js
// dsh-client-ui-settings-models/lib/client.js:4485-4501
ctx.slots.inject("settings.section", () => ctx.slots.register({
  name: "settings.section", id: "models", order: 10,
  label: () => t("nav"), inject: injected,
  children: { "settings.models.provider-card": { kind:"keyed", scope:"root" },
              "settings.models.footer": { kind:"list",  scope:"root" } }
}, ModelsSection));
```

- 排序即 `order`（`general=0`、`models=10`、`plugins=15`），导航 label 支持 thunk（跟随语言）。
- 「插件」页内的卡片走 `settings.plugins.tab`（`dsh-client-ui-settings-plugins/lib/client.js:201-212`），通用页内的行走 `settings.general.item`（`:1299-1302`），首次引导走 `settings.onboarding`。
- 官方配置页（如 ui-settings-shell）用 `ctx.configForms.whileServed([...])` 跟随宿主是否服务某命名空间：命名空间不在组合里，页面就完全不出现（`dsh-client-ui-settings/README.zh.md:40,44`；`dsh-client-ui-settings-shell/README.zh.md:38`）。
- 设置值的持久化路径是 **Host settings 文档**（`ctx.configForms.get(entryId)` / `mutate` / `set` / `unset`，`dsh-client-ui-settings/README.zh.md:34-36`）。⇒ **每换一个后端，就是另一份 settings 文档**（`README.zh.md:108` "Host 偏好由各认证入口共享"）。

### 6.2 "后端管理"页的三档实现

| 档位 | 能力 | 是否需要改核心 | 说明 |
|---|---|---|---|
| **A. 只读展示** | 显示"当前后端 origin、是否自定义、版本" | ❌ 纯插件 | 读 `globalThis.__DSH_TRANSPORT__.streamBaseUrl`（桌面下必有值）；版本可从 `__DSH_BOOT__.release` 或 `settings` 里读 |
| **B. 管理列表（增删改，存 localStorage）** | 列表 CRUD、"下次启动用哪个" | ❌ 纯插件（凭据除外） | `localStorage` 在 `dsh-app://app` origin 下，Electron 持久化到 `userData`；但**页面无法自己重启到该后端**，只能写"期望值"等壳读取 ⇒ 壳仍要读 |
| **C. 真正切换 / 添加（推荐）** | 立即切换、健康检查、删除 | ✅ 需要壳：`main` 新 IPC + `preload-app.cjs` 新 `contextBridge` | 建议在 `lib/preload-app.cjs:863-871` 旁新增 `dshDesktopBackends = { list, add, remove, activate }`，并在 main 侧按 `assertDesktopSender(event,["app"])` 严格校验（`:7015-7020`）。凭据（token/cookie）**永不回传渲染层**，与现有"cookie 只由壳持有"一致（`:12191`、`:8268-8282`） |

### 6.3 不建议的做法

- ❌ 把"后端列表"写进 Host settings 命名空间：换后端就换了文档，列表会跟着后端走（`dsh-client-ui-settings/README.zh.md:108`），语义错乱。
- ❌ 让插件用 `fetch` 直连另一个后端：跨 origin + `SameSite=Strict` cookie + 后端 trust fence 三重拦截（`dsh-client-connection/README.zh.md:41,43,47`），必须走壳代发。
- ❌ 在插件里改 `__DSH_TRANSPORT__` 强切：`installConnection` 只在 `apply` 时读一次（`dsh-client-connection/lib/client.browser.js:1503-1511`），且 `connection` 服务已被 `ctx.provide` 占位，第二棵树/二次安装会被"already owned"拒绝（`:1458`）。

---

## 七、附带发现：今天就能用的"多后端并存"绕道

- Sidebar 的 **Browser tab**（Desktop 默认启用）用独立 partition 的 `<webview>` 打开任意 HTTP(S)，包括 loopback，只拦截"应用自身 host"：`url.port === host.port && (hostname 相同 || hostname ∈ {localhost,127.0.0.1,[::1]})`（`lib/main.js:10635-10663`；`dsh-client-ui-sidebar-browser/README.zh.md:12,28`）。
- 拦截规则只针对"应用自身 host"，其余 http(s)/ws(s) 一律放行（`lib/main.js:10637-10646`：取消条件 = 带凭据 **或** `isApplicationHost(url)`）。因此 `http://127.0.0.1:<另一个端口>/?token=…` 不仅 **HTTP** 能通，**WebSocket 也能通**——第二个 dsh GUI 可以在侧栏 tab 里完整运行（含 `/api/remote.mux`），它自己完成 303 → cookie，cookie 落在该 webview 的独立 partition 里,与主界面互不干扰。
- 限制：不是主界面（是右侧栏的一个 tab）；token 需要手工粘贴；每个 workspace 一个 partition（`lib/main.js:10495-10502`）；`http://127.0.0.1:<与主后端相同的端口>` 会被拒。⇒ 这可以作为"多后端并存"的低成本过渡方案，但仍不满足"在一个界面里管理、切换"。另外**远程**后端（非 loopback）虽然 HTTP(S)/WS 都放行，却因为没有可用的代理/可信 authority 配置，容易撞上后端自己的 trust fence（`dsh-client-connection/README.zh.md:47`），需要 `--host`/`--trusted-host` 配合。

---

## 八、证据附录

### 8.1 Electron 壳（`lib/`）

| 结论 | 证据 |
|---|---|
| 主进程入口 | `package.json:8`（`main: lib/main.js`）；`lib/main.js:13184-13195`（`app.whenReady().then(main)` + 单实例锁） |
| 应用文档 origin = `dsh-app://app/` | `lib/main.js:7009`（`SCHEME="dsh-app"`）、`:12134`（`applicationUrl`）、`:12940`（`navigateMain(applicationUrl)`） |
| 自定义协议被注册为 privileged（standard/secure/fetch/cors/stream） | `lib/main.js:11880-11890` |
| 协议处理器：`shell` → 本地 renderer；`app` 静态 → 本地 dist；其余 → 反代后端 | `lib/main.js:12406-12415` |
| 静态 index 注入 `__DSH_BOOT_READY__` | `lib/main.js:8221` |
| boot IPC 返回 `{injections, streamBaseUrl}` | `lib/main.js:12424-12432`；`lib/preload-app.cjs:863-866` |
| 前端装配 `__DSH_TRANSPORT__` 并解释注入行 | `dsh-web-frontend/dist/assets/index-CN7NIWNw.js` 入口尾部（`PZ` 行解释器 + `globalThis.__DSH_TRANSPORT__={ownsHost:true,streamBaseUrl:n}` + `Ms.ready()`） |
| spawn 内置 host（Electron Node 模式 + IPC） | `lib/main.js:3649-3657`（`ELECTRON_RUN_AS_NODE`）、`:3791-3811`（spawn/stdio/ipc）、`:3818-3836`（`ready`/`fatal`/控制消息） |
| `hostUrl`/`hostCookie` 为单例模块变量 | `lib/main.js:12135-12136`、`:12191-12194` |
| cookie 交换（303 + set-cookie） | `lib/main.js:8229-8236` |
| 反代：Origin 白名单、删 host/origin/cookie、塞 cookie、屏蔽 set-cookie | `lib/main.js:8243-8255`、`:8268-8299` |
| WS 头改写（仅 `127.0.0.1`，仅主窗口） | `lib/main.js:12447-12469` |
| 主窗口 webPreferences（sandbox、contextIsolation、webviewTag） | `lib/main.js:11960-11968` |
| 导航被锁（只允许 `dsh-app:` 与当前 origin 的 http） | `lib/main.js:12032-12039` |
| IPC 来源校验 | `lib/main.js:7015-7020`（`assertDesktopSender`）、`:7052`（麦克风）、`:8271`、`:12459`、`:12472`、`:12531`、`:12871` |
| preload 暴露的全局面（无后端切换能力） | `lib/preload-app.cjs:844-882`（`dshOnboarding`/`__DSH_DIRECTORY_PICKER__`/`__DSH_HOST_PATHS__`/`dshDesktopBoot`/`dshPlatform`/`dshDesktop`/`__DSH_LOCALE__`） |
| profile 目录固定 `~/.dsh/profiles/desktop` | `lib/main.js:25,79-84`、`:12048`、`:12051` |
| 壳读 release 以判定兼容性 | `lib/main.js:103-114`（`readDesktopRuntime`）、`:12125`（`resources`）、`:11897`（`dsh` 目录） |
| 用户设置落 `userData`（后端表可仿此持久化） | `lib/main.js:12043`（`readDesktopSettings(app.getPath("userData"))`） |
| Sidebar webview 限制（独立 partition、禁访应用 host、禁 WS） | `lib/main.js:10481-10512`、`:10635-10663` |
| `camelCase` 桌面 IPC 通道清单 | `lib/main.js:6981-7007` |
| 欢迎页 RPC 客户端（`POST <origin>/api/<ns>/<method>`，可复用给任意 origin） | `lib/main.js:8876-8908` |

### 8.2 内置 host（`dsh/node_modules/@deepseek-ai/`）

| 结论 | 证据 |
|---|---|
| 启动参数 `--no-open --host 127.0.0.1 --port 0` | `dsh-desktop-host/lib/index.js:234-240` |
| 上报 `ready {url, injections}` | `dsh-desktop-host/lib/index.js:342-349` |
| 控制通道（shutdown / update-tasks / quit-inspection） | `dsh-desktop-host/lib/index.js:268-327` |
| 端口 = OS 分配 | `dsh-host-webserver/lib/index.js:292-295,466-476` |
| 注入行渲染两种形态（HTML / boot payload） | `dsh-host-webserver/README.zh.md:67`；`dsh-host-webserver/lib/index.js:11-98`（`renderRow`/`renderIndexInjections`/`READY_MARKUP`） |
| 启动图 + `__ModuleLoader__` facade + `__DSH_BOOT__` | `dsh-client-modules/lib/index.js:460-505,571-573`；`README.zh.md:69,79,85` |
| bundle 路由 `/plugins`、shell 载体走 `fetchBundle()` | `dsh-client-modules/lib/index.js:202,563-573,598-605`；`README.zh.md:12,79` |
| release 门禁（异 release 的图不应用） | `dsh-client-modules/README.zh.md:47`；`dsh-client-ui-settings-general/README.zh.md:34` |
| 前端 index 需 token/cookie，静态资源公开 | `dsh-host-frontend-static/README.zh.md:12` |

### 8.3 客户端连接层与 gateway

| 结论 | 证据 |
|---|---|
| `__DSH_TRANSPORT__` 契约（streamBaseUrl / ownsHost / 载体负责认证） | `dsh-client-connection/README.zh.md:30,34` |
| 浏览器插件读取 transport 并安装 Connection | `dsh-client-connection/lib/client.browser.js:1503-1511` |
| HTTP RPC 用文档相对 URL | `dsh-client-connection/lib/client.browser.js:1209-1232` |
| WS 用 `streamBaseUrl` 绝对 origin | `dsh-client-connection/lib/client.browser.js:1348-1354,1423` |
| `isLoopback` 因 `ownsHost` 恒真 | `dsh-client-connection/lib/client.browser.js:1424` |
| `installConnection(ctx, options)` 支持自定义 carrier（`fetch`/`createWebSocket`/`rpc`/`openStream`），可在同一 realm 多棵树用不同载体 | `dsh-client-connection/lib/client.browser.js:1382-1387`；`README.zh.md:34` |
| 同一 Context 只能有一个 stream owner | `dsh-client-connection/lib/client.browser.js:1457-1460` |
| 浏览器认证：token→303→签名 cookie（host-only/HttpOnly/SameSite=Strict/绑定 authority） | `dsh-client-connection/lib/index.js:276-278,335-349,440-497` |
| 浏览器信任栅栏（Host 必须 loopback/绑定 IP/trustedHosts；Origin 须同 authority；`cross-site` 一律拒） | `dsh-client-connection/lib/index.js:240-269`；`README.zh.md:47` |
| `__DSH_CONNECTION_RECOVERY__` 注入行 | `dsh-client-connection/lib/index.js:1037-1043` |
| Gateway WS 路径与 base 解析 | `dsh-api-gateway/lib/client.browser.js:106,761` |
| Gateway 升级走 `connection.admitConnection(req)` | `dsh-api-gateway/lib/index.js:787` |

### 8.4 设置体系

| 结论 | 证据 |
|---|---|
| 设置页 = `settings.section` slot 注册（含 `id/order/label/inject/children`） | `dsh-client-ui-settings-general/lib/client.js:1258-1261,1293-1303`；`dsh-client-ui-settings-models/lib/client.js:4485-4501`；`dsh-client-ui-settings-plugins/lib/client.js:201-212` |
| slot 类型由 ui-settings 声明，外壳由 ui-settings-general 提供 | `dsh-client-ui-settings/README.zh.md:44`；`dsh-client-ui-settings-general/README.zh.md:30,63` |
| 子 slot：`settings.general.item` / `settings.plugins.tab` / `settings.onboarding` | `dsh-client-ui-settings-general/lib/client.js:1299-1302`；`dsh-client-ui-settings-plugins/lib/client.js:208-211`；`dsh-client-ui-settings-models/lib/client.js:4502-4517` |
| `whileServed` 跟随命名空间（页面随宿主出现/消失） | `dsh-client-ui-settings/README.zh.md:40,44`；`dsh-client-ui-settings-shell/README.zh.md:38` |
| 设置值 = Host settings 文档，多入口共享 | `dsh-client-ui-settings/README.zh.md:34-36,108` |
| "打开配置文件"仅 loopback 渲染（多后端需复核） | `dsh-client-ui-settings-general/README.zh.md:52,84` |
| 客户端插件靠 `dshDesktop`/`__DSH_TRANSPORT__` 判桌面 | `dsh-client-ui-settings-models/lib/client.js:4436`；`dsh-client-ui-settings-account/lib/client.js:4669-4671` |

### 8.5 版本假设

- 全部结论基于 `@deepseek-ai/dsh-desktop@0.2.1-rc.2`（`package.json:5`，commit `332895e0`）与其内置 `@deepseek-ai/*@0.2.1-rc.2`；客户端 bundle 为 `dsh-web-frontend/dist/assets/index-CN7NIWNw.js`（921,071 字节，单行压缩产物）。
- 若上游在 `hostUrl` 注入方式、`__DSH_TRANSPORT__` 契约、或 WS 头改写策略上有变更，本文第 4、5 节的结论需重新核对源码（优先核对 `dsh-client-connection/README.zh.md` 的「浏览器认证与请求信任」一节与 `dsh-web-frontend` 入口片段）。
