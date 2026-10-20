# 多后端接入：token → cookie 鉴权链路与 account 命名空间定性

> 调研对象：DeepSeek Harness 桌面版 v0.2.1-rc.2 内置 dsh runtime（已解包 asar）
> 源码根：`C:\Users\UT\AppData\Local\Temp\dsh-asar-extract\dsh\node_modules\@deepseek-ai\`
> 性质：只读调研。未改源码、未重启服务。
> 状态：**主体已完成**；「未完成」条目在各节末尾单独标注。

---

## 1. 结论摘要

**核心结论：token/cookie 这套鉴权链本身是可以复用于多后端的——但复用的方式是「每个后端各自一份 cookie」，而不是「一份 cookie 通吃」。真正卡住桌面 shell 的不是鉴权链，而是 shell 的单一 Host 绑定结构。**

1. **鉴权链是可复用的，代价很低。** 整套机制无外部依赖：每进程一个启动 token（内存 WeakMap）+ 一个持久化 HMAC 密钥（`$DSH_HOME/.credentials.yaml`）+ 一个 authority 绑定的签名 cookie。没有数据库、没有用户表、没有 OAuth。任意 `dsh --profile web` 后端只要能被 shell 取到它打印的 `?token=` URL，就能立刻换出该后端的 cookie（`lib/main.js:8229-8236` 的 `authenticateWebHost` 已经这么做了）。
2. **cookie 是 authority 绑定的，跨后端天然隔离。** cookie 名 = `dsh-auth-` + `sha256(authority)` 的 base64url，签名 payload 里也带 `authority`（`dsh-client-connection/lib/index.js:335-337, 458-497, 559-570`）。因此「A 后端 cookie 发给 B 后端 → 401」是设计使然，也意味着**多后端必须按后端分桶存 cookie**，不能共享。
3. **cookie 跨重启有效（实测已确认）。** 密钥来自持久化 credential record，不是进程内存随机数，所以后端重启后旧 cookie 依然 200。**这对多后端是利好**：不需要每次重启都重新握手；**对安全是负担**：没有内置 logout，撤销只能删记录或删除 cookie。
4. **跨源是最大的硬限制。** cookie 是 `SameSite=Strict` + `HttpOnly`（`lib/index.js:347-350`），且 `/api` 的 Host/Origin 栅栏要求 `Origin` 与 `Host` **同一 authority**（`lib/index.js:240-269`）。这意味着：
   - 从 `dsh-app://app` 或任意 `http://127.0.0.1:<shell端口>` 的页面**直接 fetch 远程后端**，浏览器不会带跨站 cookie（SameSite=Strict），且 `Origin` 校验也会 403。
   - 桌面 shell 之所以能用，是因为它**绕过了浏览器 cookie 语义**：Electron 主进程用 Node `fetch` 亲自换 cookie，再把 cookie 手工塞进转发请求头（`lib/main.js:8268-8298`），WebSocket 则用 `onBeforeSendHeaders` 重写 `origin`/`cookie`/`sec-fetch-site`（`lib/main.js:12447-12469`）。
   - **结论：多后端要么在 Electron 主进程层做（可行，见 §5），要么必须让每个后端对 shell 页面同源（不可行，端口不同）。纯浏览器方案基本走不通。**
5. **`account` 命名空间与本地鉴权无关。** 它是**云端 DeepSeek Platform 账号/计费**：登录走系统浏览器 + OAuth/PKCE，token 存在 `deepseek-account-platform/default`，用于向 `https://platform.deepseek.com` 和 `https://api.deepseek.com` 鉴权（`dsh-deepseek-account-platform/README.zh.md:39, 43, 66`）。它**不是**「登录到某个 dsh 后端」的机制。因此多后端方案里 **account 命名空间可以完全不动**。
6. **owner 不是「持有有效 cookie 的连接」。** 在 `HostConnectionService` 里，浏览器 cookie 通过认证后**一律映射到同一个共享的 `browserPeer`，principal 硬编码为 `{ kind: 'owner' }`**（`lib/index.js:714, 746`）。`/connect` 换出的 API cookie 才会创建新 Peer（`lib/index.js:781-791`），但 principal **也是 owner**。全仓没有任何非 owner principal 的产生点（`grep 'kind: "owner"'` 只有这两处）；`dsh-api-remote-access` 的 `registerPolicy` 只有文档，**没有实现方**。所以「非 owner」目前是**预留但未启用的能力**。

**一句话回答 lead：** token/cookie 链路可复用，且实现简单（主进程为每个后端跑一次 `GET /?token=...` 拿 cookie 即可）；真正的工程量在把桌面 shell 从「单 Host 单 cookie」改成「多 Host 多 cookie 的转发矩阵」。

---

## 2. BrowserAuth 全链路

### 2.1 关键常量

`dsh-client-connection/lib/index.js:271-281`：

| 常量 | 值 | 行号 |
|---|---|---|
| `AUTH_RECORD_KEY` | `credentialKey("client-connection", "browser-session")` | 273 |
| `DAY_MILLISECONDS` | `1440 * 60 * 1000` | 274 |
| `SECRET_BYTES` | `32` | 275 |
| `TOKEN_QUERY` | **`"token"`** | 276 |
| `COOKIE_PREFIX` | **`"dsh-auth-"`** | 277 |
| `COOKIE_PAYLOAD_VERSION` | `1` | 278 |
| `STORED_SECRET_VERSION` | `1` | 279 |

### 2.2 进程 token 的生成与保存

**纯内存，不进磁盘，进程级唯一。**

```js
const PROCESS_LAUNCH_TOKENS = /* @__PURE__ */ new WeakMap();   // lib/index.js:281

function processLaunchToken(owner) {                            // lib/index.js:294-300
    const existing = PROCESS_LAUNCH_TOKENS.get(owner);
    if (existing !== undefined) return existing;
    const created = encodeBase64Url(randomBytes(SECRET_BYTES));  // 32 字节随机
    PROCESS_LAUNCH_TOKENS.set(owner, created);
    return created;
}
```

- 以 `ctx.root`（根 application context）为 WeakMap key，因此 **Connection 插件 reload 后 token 不变**，进程重启后必然改变。
- 生成点：`BrowserAuth` 构造函数 `this.launchToken = processLaunchToken(processOwner)`（`lib/index.js:420`）。
- 写入 URL：`authenticatedUrl(baseUrl)` 用 `url.searchParams.set(TOKEN_QUERY, this.launchToken)`（`lib/index.js:440-444`）。**只加 `?token=`，不动 path/authority**。

### 2.3 token 从 URL 的哪个参数读取

**query 参数名 `token`**，且严格校验：

```js
authorizeIndex(req, res, secure = false) {                      // lib/index.js:458-497
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    const tokens = url.searchParams.getAll(TOKEN_QUERY);         // 读全部 ?token=
    if (tokens.length > 0) {
        const authority = requestAudience(req.headers, secure);
        // 必须：GET + pathname 恰好 "/" + tokens.length === 1 + 常量时间比较
        if (req.method === "GET" && url.pathname === "/" && tokens.length === 1 &&
            authority !== void 0 && tokenMatches(tokens.join(""), this.launchToken)) {
            /* 签发 cookie，303 见下 */
        }
        ...
    }
}
```

要点（都是硬约束）：
- **只接受 `GET /`**（pathname 必须是根）。`/index.html` 带 token 不换 cookie，会落到 401（`dsh-host-frontend-static/lib/index.js:59-62` 会把 dist 根与 index 路径都交给 `authorizeIndex`）。
- **`?token=` 出现多次 → 直接 401**（`tokens.length !== 1`）。防参数 smuggling。
- **不接受 `Authorization` header**（README.zh.md:41 明确）。
- 比较用 `timingSafeEqual` + 长度预检（`tokenMatches`，`lib/index.js:330-334`），防时序侧信道。

### 2.4 兑换流程：路由、状态码、cookie 属性

**路由：不是独立端点，就是 `GET /` 本身。** 由 `dsh-host-frontend-static` 的 fallback seat 调用：

```js
// dsh-host-frontend-static/lib/index.js:95
await serveStatic(..., () => ctx.connection.authorizeIndex(req, res), renderIndex);
// dsh-host-frontend-static/lib/index.js:59-62
if (target === distRoot || target === distIndex) { if (!authorizeIndex()) return; ... }
```

兑换成功（`lib/index.js:464-481`）：

```js
res.writeHead(303, {
    "cache-control": "no-store",
    "location": "./",              // ← 相对路径，剥掉 token 且保留挂载目录
    "referrer-policy": "no-referrer",
    "set-cookie": sessionCookie(cookieName(authority), value, expiresAt,
                                Math.floor(this.maxAgeMilliseconds / 1000), secure)
});
```

cookie 序列化（`lib/index.js:347-350`）：

```js
function sessionCookie(name, value, expiresAt, maxAgeSeconds, secure) {
    const attributes = `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`;
    return secure ? `${attributes}; Secure` : attributes;
}
```

| 属性 | 值 | 备注 |
|---|---|---|
| name | `dsh-auth-` + base64url(sha256(authority)) | 43/44 字符；authority 含端口，因此**端口隔离** |
| `Max-Age` | `cookieMaxAgeDays * 86400`，默认 **2592000**（30 天） | `Config.cookieMaxAgeDays` 默认 30，`lib/index.js:1017` |
| `Expires` | 绝对 UTC 时间 | 与 Max-Age 双写 |
| `Path` | `/` | 全站 |
| `HttpOnly` | 有 | JS 读不到 |
| `SameSite` | **`Strict`** | **跨源方案的最大障碍** |
| `Secure` | **仅当监听器本身是 TLS** | 见下 |

**`Secure` 的判定**非常关键——只看监听器自身协议，**不看 `publicUrl`、不看 `X-Forwarded-Proto`**：

```js
// lib/index.js:454-455（doc comment）
// Only that listener's own protocol decides, never a publicUrl announcement
// or a forwarded header.
```
调用侧：`this.ctx.get("webServer")?.protocol === "https:"`（`lib/index.js:809`）。

**cookie 值格式**（`lib/index.js:354-357`）：

```js
function encodeCookie(payload, secret) {
    const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
    return `v${payload.version}.${body}.${encodeBase64Url(signature(secret, body))}`;
}
```
即 `v1.<base64url(JSON)>.<base64url(HMAC-SHA256)>`，payload = `{version, authority, issuedAt, expiresAt}`（`lib/index.js:467-472`）。

`authority` 的规范化（`lib/index.js:307-316`）：

```js
function requestAudience(headers, secure) {
    const host = header(headers, "host");
    const url = new URL(`${secure ? "https:" : "http:"}//${host}`);
    return secure ? url.origin : url.host;   // HTTPS 带 scheme，HTTP 只有 host:port
}
```
→ **HTTP 与 HTTPS 的 cookie 互不通用**（同样 host:port 也不行），README.zh.md:45 明确说明。

### 2.5 cookie 验签

```js
authenticate(request, secure) {                                   // lib/index.js:559-570
    const authority = requestAudience(request.headers, secure);
    const rawCookie = header(request.headers, "cookie");
    if (authority === void 0 || rawCookie === void 0) return void 0;
    const value = cookieValue(rawCookie, cookieName(authority));   // 按 authority 算出的名字取
    if (value === void 0) return void 0;
    const payload = decodeCookie(value, this.secret);              // HMAC 验签
    if (payload === void 0 || payload.authority !== authority) return void 0;
    const now = Date.now();
    if (payload.issuedAt > now || payload.expiresAt <= now ||
        payload.expiresAt <= payload.issuedAt ||
        payload.expiresAt - payload.issuedAt > this.maxAgeMilliseconds) return void 0;
    return payload;
}
```

注意第 4 行：**cookie 名由当前请求的 authority 反查**。这就是「A 端口的 cookie 发给 B 端口 → 401」的机制：B 端口算出的是另一个 cookie 名，`cookieValue` 找不到就返回 `undefined`，根本进不到验签。同时还有 `payload.authority !== authority` 的二次校验。

### 2.6 cookie 签名密钥：来源与持久化

**密钥 = 32 字节随机 → base64url → 存进 credential record。** 首次启动生成，之后复用。

```js
async function initializeSecret(credentials) {                    // lib/index.js:391-408
    const generated = { version: STORED_SECRET_VERSION, secret: encodeBase64Url(randomBytes(SECRET_BYTES)) };
    const secret = storedSecret(await credentials.modifyRecord(AUTH_RECORD_KEY, (current) => {
        if (current !== void 0) { storedSecret(current); return Promise.resolve(void 0); }  // 已存在→不动
        return Promise.resolve({ kind: "grant", payload: generated });                      // 不存在→建
    }));
    if (secret === void 0) throw new Error("client-connection: browser-session credential record was not created");
    return secret;
}
```

- 存储位置：`dsh-credentials-local` 把 record 写进 **`$DSH_HOME/.credentials.yaml`**（`dsh-credentials-local/lib/index.js:49, 58`），默认 `~/.dsh/.credentials.yaml`（`dsh-home-paths/lib/index.js:11, 56`）。
- **本机实测确认**：`C:\Users\UT\.dsh\.credentials.yaml` 中存在
  ```yaml
  records:
    client-connection/browser-session:
      kind: grant
      payload:
        version: 1
        secret: <base64url>
  ```
  （密钥值已脱敏；`refs` 段另有 `ISTART_API_KEY`，`records` 段另有 `deepseek-account-platform/device` 与 `deepseek-account-platform/default`。）
- 写入由 `writeFileAtomic(..., { mode: 0o600 })`（`dsh-credentials-local/lib/index.js:564-567`）保证原子性；POSIX 下 `assertOwnerOnly` 会拒绝 group/other 可读的文件（`lib/index.js:92-106`），Windows 跳过该检查。
- 内存缓存：`BrowserAuth.secret` 字段（`lib/index.js:415`），Connection 激活时加载一次，之后**同步验签**（`lib/index.js:409-413` 的 doc comment 明说）。
- **重启后是否失效：不失效。** 密钥在文件里，`initializeSecret` 发现记录已存在就原样复用（`current !== undefined` 分支）。lead 已实测：后端重启后旧 cookie 仍 200。
- **但是**：`decodeCookie` 支持 payload `version` 1 和 2（`lib/index.js:361, 374-389`），且 `authenticateApi` 只认 `version === 2`（`lib/index.js:555-558`）。也就是说浏览器 cookie 是 v1，**API cookie 是 v2 且带 `id` 字段**（指向 `peers` map 里的 Peer）。

### 2.7 cookie 有效期与撤销

- 有效期：`cookieMaxAgeDays`，默认 30 天（`lib/index.js:1017`），可用 Connection 行配置覆盖；`Max-Age` 与 `Expires` 双写，payload 里也是绝对区间。
- **没有 logout API。** README.zh.md:83 明确：
  > **没有 logout 操作**：清除浏览器 cookie 会结束单个浏览器会话；删除 owner 凭据记录并重启 `dsh` 会撤销全部会话。
- 撤销手段（实测+源码一致）：
  1. 浏览器侧删 cookie → 只杀该浏览器；
  2. 删除 `.credentials.yaml` 里 `client-connection/browser-session` 记录并重启后端 → **全部 cookie 失效**（密钥变了）。
  3. 注意「删除或替换该记录会在**下一次 Connection 激活**时生效」——运行中删文件不会立刻生效，因为密钥已在内存（README.zh.md:43）。

### 2.8 `/connect` 这条并行链路（API 客户端用）

`authorizeConnect`（`lib/index.js:505-539`）：
- 路由：`GET /connect`，由 `webCtx.webServer.register({ kind: "exact", path: CONNECT_PATH })` 挂载（`lib/index.js:1059-1065`）。
- 参数：`?token=<launch token>&interactions=answer|none`（`CONNECT_PATH = "/connect"`，`lib/index.js:19`）。
- 校验：`tokens.length === 1` 且 token 正确且 `authority !== undefined`，否则 401（`lib/index.js:519-522`）。
- 成功：`publishPeer(interactions)` **同步创建 Peer**（`lib/index.js:781-791`），签发 **v2 cookie 带 `id`**，`302` 到 `./api/remote.mux`（`lib/index.js:523-538`）。
- `interactions` 非法或重复 → **400**（`lib/index.js:509-516`）。
- 一条 API socket 负责清理：`admitConnection` 里若 `ownsSocket` 已为 true → **409**（`lib/index.js:756-776`）。

> **这条链路对多后端很有价值**：它是**为程序化客户端设计的**，返回的是「Peer 句柄化」的 cookie，比浏览器 cookie 更适合多路复用。而且 `publishPeer` 创建的 Peer 是**独立实例**，不像 `browserPeer` 那样全站共享。

---

## 3. 401 的来源

**401 只有一个签发点：`BrowserAuth.writeUnauthorized`。**

```js
writeUnauthorized(req, res) {                                     // lib/index.js:571-577
    res.writeHead(401, {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8"
    });
    res.end(req.method === "HEAD" ? void 0
        : "dsh web authentication required; reopen the URL printed by dsh web.\n");
}
```

调用点（都在 `BrowserAuth` 内）：
- `authorizeIndex` 三处：token 存在但校验失败（`lib/index.js:491`）、无 token 且未认证（`lib/index.js:495`）、以及 `GET /` 带 token 但已认证的重定向分支之后。
- `authorizeConnect` 一处（`lib/index.js:520`）。

**`/api` 的 401 是另一条路径，不是 `writeUnauthorized`**，而是 `HostConnectionService.admit` 的 rejection：

```js
admit(request) {                                                   // lib/index.js:742-750
    if (!this.isTrusted(request)) return { rejection: 403 };        // ← 栅栏失败先 403
    if (this.disposed) return { rejection: 401 };
    const secure = this.owner.get("webServer")?.protocol === "https:";
    if (this.browserAuth.isAuthenticated(request, secure)) return { peer: this.browserPeer };
    const id = this.browserAuth.authenticateApi(request, secure);
    const record = id === void 0 ? void 0 : this.peers.get(id);
    return record === void 0 ? { rejection: 401 } : { peer: record.peer };  // ← 认证失败 401
}
```

判定条件（按顺序）：
1. `isTrusted(request)` false → **403**（Host/Origin 栅栏，`lib/index.js:240-250`）。
2. Connection 已 disposed → **401**。
3. 浏览器 cookie 有效（`isAuthenticated` → payload.version === 1）→ 用共享 `browserPeer`。
4. API cookie 有效（`authenticateApi` → payload.version === 2，拿到 `id`）且 `peers` 里有活着的 record → 用那个 Peer。
5. 否则 → **401**。

401 的响应体在两处 route handler 里统一为纯文本 `"unauthorized"`（`lib/index.js:864-866`、`1051-1053`）：

```js
if ("rejection" in admission) {
    res.writeHead(admission.rejection);
    res.end(admission.rejection === 401 ? "unauthorized" : "forbidden");
    return;
}
```

WebSocket 升级的 rejection 走另一条（`dsh-api-gateway/lib/index.js:680-691`）：

```js
function rejectRemoteStreamUpgrade(socket, status) {
    const reason = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Conflict";
    socket.end([`HTTP/1.1 ${String(status)} ${reason}`, ...].join("\r\n"));
}
```
→ WebSocket 侧会出现 **409**（同一 API cookie 重复占用 socket，`lib/index.js:764`），这是 HTTP 侧没有的状态码。

**lead 实测对应关系核对：**
- 无 token GET `/` → 401 ✅（`authorizeIndex` 走到 `lib/index.js:495`）
- 带正确 token → 303 + `Set-Cookie` ✅（`lib/index.js:464-481`）
- A 端口 cookie 发 B 端口 → 401 ✅（cookie 名反查失败 → `admit` 第 5 步）
- 错误 `Origin` → 403 ✅（`isSameAuthorityOrigin` 返回 false，`lib/index.js:247-249, 258-269`）
- `sec-fetch-site: cross-site` → 403 ✅（`lib/index.js:246`）

---

## 4. 跨源 cookie 限制（最关键的一节）

### 4.1 三重封锁

| 层 | 机制 | 位置 | 后果 |
|---|---|---|---|
| 浏览器 cookie 语义 | `SameSite=Strict` | `lib/index.js:348` | 从 `dsh-app://app`、`file://` 或任意其他 origin 发起的 `fetch` **不带** cookie |
| 浏览器 cookie 语义 | `HttpOnly` | `lib/index.js:348` | JS 无法读取/手工放入 `Cookie` 头 |
| 服务端 Origin 栅栏 | `Origin` 必须与 `Host` 同 authority | `lib/index.js:247-249, 258-269` | 跨源请求即使带了 cookie 也会 **403** |
| 服务端 Fetch-Metadata | `sec-fetch-site: cross-site` 一律拒绝 | `lib/index.js:246` | 显式拦截跨站 |

栅栏完整体（`lib/index.js:240-250`）：

```js
function isTrustedApiRequest(request, trustedHosts, bindHost, protocol = "http:") {
    const host = header$1(request.headers, "host");
    if (host === void 0) return false;
    const hostUrl = parseAuthority(host, protocol);
    if (hostUrl === void 0) return false;
    // 1) Host 必须是 loopback / trustedHosts / 监听器的绑定 IP
    if (!isLoopbackHostname(hostUrl.hostname) &&
        !isTrustedAuthority(hostUrl, trustedHosts, protocol) &&
        !isBindAddressAuthority(hostUrl, bindHost)) return false;
    // 2) 拒绝跨站标记
    if (header$1(request.headers, "sec-fetch-site") === "cross-site") return false;
    // 3) Origin 必须同 authority
    const origin = header$1(request.headers, "origin");
    if (origin === void 0) return true;          // 无 Origin 视为非浏览器，放行
    return isSameAuthorityOrigin(origin, host);
}
```

### 4.2 为什么桌面 shell 能用，而普通浏览器不能

**桌面 shell 根本不在浏览器语义里跑。** 它有两条「主进程特权」通道：

**(a) HTTP：自建 protocol handler + 手工注入 cookie**

`lib/main.js:8229-8236`：
```js
async function authenticateWebHost(url) {
    const response = await fetch(url, { redirect: "manual" });   // Node fetch，无 CORS/SameSite
    const cookie = response.headers.get("set-cookie");
    await response.body?.cancel();
    if (response.status !== 303 || cookie === null) throw new Error("Desktop Host authentication failed");
    const end = cookie.indexOf(";");
    return end < 0 ? cookie : cookie.slice(0, end);              // 只取 "name=value"
}
```

`lib/main.js:8268-8298`：
```js
async function forwardWebRequest(request, host, cookie) {
    const source = new URL(request.url);
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== "dsh-app://app") return new Response(null, { status: 403 });
    const target = new URL(host);
    target.pathname = source.pathname; target.search = source.search;
    const headers = new Headers(request.headers);
    for (const name of ["host", "origin", "cookie", "sec-fetch-site"]) headers.delete(name);
    headers.set("cookie", cookie);                                // ← 手工注入
    const response = await fetch(target, { ...init, redirect: "manual" });
    const outgoing = new Headers(response.headers);
    for (const name of WITHHELD_RESPONSE_HEADERS) outgoing.delete(name);  // 剥掉 set-cookie
    ...
}
```

关键细节：
- **删掉 `origin`、`sec-fetch-site`** → 服务端栅栏第 2、3 步直接通过（`origin === undefined` 时 `isTrustedApiRequest` 返回 true）。
- **删掉 `host`** → Node `fetch` 自动按目标 URL 生成正确的 `Host`。
- **`set-cookie` 在 `WITHHELD_RESPONSE_HEADERS` 里**（`lib/main.js:8243-8255`）→ Host 的 cookie **永不进 Chromium cookie jar**，由 shell 独占。这正是 README.zh.md:30 说的「桌面载体负责认证」。

**(b) WebSocket：`onBeforeSendHeaders` 重写**

`lib/main.js:12447-12469`：
```js
session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["ws://127.0.0.1/*", "wss://127.0.0.1/*"] }, (details, callback) => {
    if (hostUrl === void 0 || hostCookie === void 0 || details.webContentsId !== mainWindow?.webContents.id) {
        callback({}); return;
    }
    const target = new URL(hostUrl);
    const requested = new URL(details.url);
    if (requested.host !== target.host || requested.protocol !== (target.protocol === "https:" ? "wss:" : "ws:")) {
        callback({}); return;
    }
    const headers = ...;
    if (headers.origin !== "dsh-app://app") { callback({ cancel: true }); return; }   // 只允许来自本应用
    callback({ requestHeaders: {
        ...headers,
        origin: target.origin,          // ← 把 origin 改写成后端自己的 origin
        cookie: hostCookie,             // ← 注入 cookie
        "sec-fetch-site": "same-origin" // ← 伪装同源
    } });
});
```

注意这里的三处**硬编码单值**：
- `session.defaultSession`（全局默认 session）
- `mainWindow?.webContents.id`（只认主窗口）
- `hostUrl` / `hostCookie`（**单后端全局变量**，`lib/main.js:12135-12136`）

**这就是多后端的第一处真实阻塞点。**

### 4.3 限制清单（明确写清）

1. **纯浏览器多后端：不可行。** 页面 origin 是 `http://127.0.0.1:<shell端口>`（web 模式）或 `dsh-app://app`（desktop 模式），远程后端是另一个 authority。`SameSite=Strict` 让 cookie 不出场，`Origin` 栅栏会 403。无解，除非改后端代码。
2. **`Origin` 栅栏本身也允许了一种绕过**：`origin === undefined` 时直接 `return true`（`lib/index.js:248`）。这意味着**任何非浏览器客户端（curl、Node fetch、Python）只要 Host 合法就能过栅栏**——但接下来仍需 cookie。所以「同源限制」实际只挡浏览器，不挡程序化客户端。
3. **`--trusted-host` 只解决「Host 是否被接受」，不解决「Origin 是否同源」。** 这是最容易误判的一点：`trustedHosts` 只影响第 1 步（`lib/index.js:245`），第 3 步仍然要求 `Origin` 与该次请求的 `Host` 相同 authority（`lib/index.js:249`）。因此**加了 `--trusted-host` 也不会让跨源浏览器请求成功**。README.zh.md:65 的措辞（「远端浏览器要么经由剥离前缀代理…要么通过端口转发」）也印证：`trusted-host` 的前提是浏览器**直接地址栏访问**那个 authority，而不是从别的页面 fetch 它。
4. **`Secure` 只在 TLS 监听器上出现**（`lib/index.js:349`）。明文 HTTP 部署下 cookie 无 `Secure`——这对「http://127.0.0.1 局域网后端」反而是必要条件（否则浏览器根本不发），但 README.zh.md:81 已警告明文 bearer cookie 泄露风险。
5. **cookie 不能跨 scheme 复用**（`requestAudience` 在 HTTPS 下返回 `url.origin` 含 scheme，HTTP 下只返回 `host`，`lib/index.js:312`）。混合 HTTP/HTTPS 多后端时每个后端独立 cookie，无冲突。
6. **`Host` 必须「看起来像后端自己」**。loopback / `trustedHosts` / 监听器绑定 IP 三选一（`lib/index.js:245`）。所有多后端请求的 `Host` 由 Node `fetch` 按目标 URL 生成，天然满足。

### 4.4 桌面 shell 的结构性约束（这是多后端真正的工程量）

`lib/main.js` 里这两处是**单例**，必须改成 map 才能多后端：

| 变量/对象 | 位置 | 现状 | 多后端需要 |
|---|---|---|---|
| `hostUrl` | `12135` | `let hostUrl;` 单个 | `Map<backendId, url>` |
| `hostCookie` | `12136` | `let hostCookie;` 单个 | `Map<backendId, cookie>` |
| `backend` | `12180` | 单个 `DesktopBackendController` | 每后端一个 controller |
| `protocol.handle(SCHEME, ...)` | `12406-12415` | `dsh-app://app/*` 一律转发到 `hostUrl` | 需要按 host/path 前缀或 query 选后端 |
| `boot` IPC | `12424-12432` | 返回 `{ injections, streamBaseUrl }` 单个 | 每后端一份 injections + streamBaseUrl |
| `onBeforeSendHeaders` | `12447-12469` | 只认 `127.0.0.1` + `mainWindow` + 单 host | 按目标 host 查表 |

而且 `dsh-app://app` 是**单一 origin**（`registerSchemesAsPrivileged` 只有 `SCHEME = "dsh-app"`，`lib/main.js:7009, 11880-11890`），页面内 `fetch` 的相对路径永远打到 `dsh-app://app`，再由 protocol handler 决定转发给谁。**这意味着「多后端切换」可以在协议层实现（按 path 前缀或子域），而不必改前端代码**——这是个乐观信号，但需要实测 `dsh-app://backend-a/` 这种子域写法在 `protocol.handle` 里是否可行（**未完成**）。

另外 `web-frontend` 的 boot 代码（`dsh-web-frontend/dist/assets/index-CN7NIWNw.js`，命中 `__DSH_TRANSPORT__` 约 offset 920703）：

```js
Ms.ready().then(async ({ injections: i, streamBaseUrl: n }) => {
    const s = globalThis;
    s.__DSH_TRANSPORT__ = { ownsHost: !0, streamBaseUrl: n };
    await PZ(i, l => new Promise((d, h) => { /* 注入 <script src=l> */ }));
    r.resolve()
})
```

→ **`__DSH_TRANSPORT__` 是单值的**（`{ownsHost, streamBaseUrl}`），且 `ownsHost: true` 会让 `isLoopback` 恒为 true（`dsh-client-connection/lib/client.browser.js:1424`）。多后端需要把 `streamBaseUrl` 变成「按 namespace 路由」或者在切换后端时重建整个 client tree。**未完成**：切换时 `__DSH_TRANSPORT__` 的替换时机与 client 重挂载成本。

---

## 5. account 命名空间定性

### 5.1 结论

**`account` 是「云端 DeepSeek Platform 账号 / 计费」，与本地后端登录鉴权无关。**

它做四件事：
1. 通过**系统浏览器 OAuth + PKCE** 登录 `platform.deepseek.com`；
2. 把 token 存进本地 credential record（`deepseek-account-platform/default`）；
3. 用该 token 拉取**用户资料、充值余额、赠金**（`getProfile` / `getBalance` / `getUnnotifiedBonuses`）；
4. 把同一个 token 发给 `api.deepseek.com` 作推理凭据（`x-dsh-auth-token` 请求头）。

### 5.2 证据

**(a) 端点与 Header 都是 Platform 的**（`dsh-deepseek-account-platform/README.zh.md:39`）：
> getProfile / getBalance 将保存的授权 token 通过 **x-dsh-auth-token** 请求头，向 platformOrigin 上的 **GET /auth-api/v0/users/current** 和 **GET /api/v0/users/get_user_summary** 发起请求。

**(b) 默认源是官方云服务**（`lib/index.js:501, 508`）：
```js
platformOrigin:   Schema.string().default("https://platform.deepseek.com"),
inferenceOrigin:  Schema.string().default("https://api.deepseek.com"),
```

**(c) 存的是 Platform 授权，带 issuer**（本机 `.credentials.yaml` 实测）：
```yaml
deepseek-account-platform/default:
  kind: grant
  payload:
    version: 1
    token: <...>
    issuer: https://platform.deepseek.com
```
→ `issuer` 必须与 `platformOrigin` 一致，否则启动时删除该授权（README.zh.md:68）。

**(d) 登录形态是 OAuth，不是本地密码**（README.zh.md:43）：
> 提供者先在现有 Host webServer 注册 **/oauth/callback**，再调用 auth_init；校验 **state**、使用 **S256 PKCE** 授权码兑换一次，并在跳转 auth_exchange.biz_data.authorized_url 前提交授权记录。

**(e) 三种凭据完全独立**（`dsh-client-connection/README.zh.md:43` vs account 记录）：

| credential key | scope | 用途 | 谁签发 |
|---|---|---|---|
| `client-connection/browser-session` | dsh 后端 ↔ 浏览器 | cookie HMAC 密钥 | **本地 dsh 自己** |
| `deepseek-account-platform/default` | dsh 后端 ↔ DeepSeek 云 | Platform token / 推理 token | **platform.deepseek.com** |
| `deepseek-account-platform/device` | 设备标识 | device_id UUID | **本地随机生成** |
| `refs.*`（如 `ISTART_API_KEY`） | dsh 后端 ↔ 任意 LLM | 模型 API key | 各家 provider |

**(f) README 自己把「本地鉴权」和「account」分得很清。** `dsh-client-ui-settings-account/README.zh.md:106`：
> Web 登录要求页面 origin 为回环 HTTP（`localhost`、`127.0.0.1` 或 `[::1]`），因为 Host 只接受这些回调 origin。经 `--trusted-host` 或 HTTPS 反向代理访问的 Web UI 仍显示登录入口，但发起登录会进入通用的失败重试状态；这类部署应改为添加 API Key。

→ 这段话说的「Host 只接受这些回调 origin」指的是 `platformOrigin` 回调校验，**不是** `/api` 栅栏；而且它明确说明 **account 登录与 dsh 后端鉴权是两件事**——后者不通过就看不到页面，前者失败只是账号页不可用。

**(g) 命名空间方法全是账号语义**（`dsh-api-account-controller/lib/index.js:60-70, 202`）：
```js
super(ctx, "accountController", { namespace: "account" });
// @Remote: getState, getProfile, getBalance, getUnnotifiedBonuses,
//          ackBonusNotified, startSignIn, cancelSignIn,
//          hasRunningAccountTasks, signOut
// @Remote({mode:'stream'}): watchExpiry, watch
```
没有 login/logout（对后端）、没有 session、没有 token 管理。`signOut` 是退 Platform 账号（`README.zh.md:35`：「本地授权成功删除后，先发布 `deepseek-account/signed-out`…远程撤销独立执行」）。

### 5.3 对多后端的意义

**account 命名空间在多后端方案中可以原封不动。** 理由：
- 它认证的是「人 ↔ DeepSeek 云」，不是「页面 ↔ dsh 后端」；
- 凭据存在**每个后端各自的** `.credentials.yaml` 里，所以多个后端各自独立登录 Platform（除非显式共享 `DSH_HOME`，见 §7 未决项）；
- 唯一需要注意的跨后端副作用是 `dsh-client-ui-settings-account` 的**登录弹窗要求页面 origin 是 loopback HTTP**（上文 (f)），这在多后端场景下同样成立——只要 shell 在 `dsh-app://app` 里渲染，`startSignIn` 传的 callback origin 是 `new URL(transport.streamBaseUrl).origin`（`lib/client.js:4671`），即后端自己的 `http://127.0.0.1:<port>`。**这意味着每个后端必须是 loopback HTTP（或至少可回调），否则 account 登录会失败。** 远端 HTTPS 后端会踩这个坑。

---

## 6. peer / owner 判定

### 6.1 owner 的产出点（全仓只有 2 处）

**(1) 浏览器 cookie → 共享 `browserPeer`（principal 硬编码 owner）**

`dsh-client-connection/lib/index.js:714`：
```js
this.browserPeer = new Peer(ctx, { principal: { kind: "owner" } });
```
`lib/index.js:746`：
```js
if (this.browserAuth.isAuthenticated(request, secure)) return { peer: this.browserPeer };
```

**(2) `/connect` API cookie → `publishPeer`（principal 也是 owner）**

`lib/index.js:781-791`：
```js
publishPeer(interactions) {
    const peer = new Peer(this.owner, {
        principal: { kind: "owner" },        // ← 仍然是 owner
        interactions
    });
    this.peers.set(peer.id, { peer, ownsSocket: false });
    return peer.id;
}
```
经由 `authorizeConnect` 的 `(interactions) => this.publishPeer(interactions)` 回调传入（`lib/index.js:803`）。

`grep 'kind: "owner"'` 在全部 `@deepseek-ai/*/lib` 下命中的**只有这两处**。

### 6.2 所以 owner 判定 ≈ 什么？

**不是「持有有效会话 cookie 的那个连接」——而是「一切通过认证的连接」。**

| 事实 | 含义 |
|---|---|
| `browserPeer` 是**单例**，所有浏览器 cookie 共享它 | 多个浏览器标签/窗口 = 同一个 Peer。cookie 不是「会话」粒度，只是「authority 级通行证」 |
| `browserPeer.principal` 恒为 `{kind:'owner'}` | 任何拿到 cookie 的人都是 owner（= 完全权限） |
| `publishPeer` 的 Peer 也是 owner | API 客户端同样是 owner |
| `createPeer({principal})` 是公开 API（`lib/index.js:752-754`） | 但**全仓无人调用**（grep `createPeer` 只命中 README 与 api-catalog 文档） |
| `remoteAccess.registerPolicy` 无实现方 | 非 owner 的权限表目前是空的 |

**结论：当前版本里不存在「非 owner」的实际运行实例。** `dsh-api-remote-access` 整套 RLS（role/binding/condition/decide）是**已建成但未启用的基础设施**。README.zh.md:46 提到的 liveshare 读者页是**规划中的消费者**，不是现有功能。

### 6.3 `interactions` 才是真正的 per-connection 差异

| 来源 | `interactions` 默认 | 位置 |
|---|---|---|
| `browserPeer` | `"answer"`（构造时未传，`Peer` 默认 `answer`） | `lib/index.js:671` |
| `/connect` | 由 query 指定，**默认 `none`** | `lib/index.js:508` |
| `createPeer` | 省略时 `answer` | `lib/index.js:671` |

`interactions` 决定能否参与转发事件（`dsh-api-gateway/README.zh.md:49`）：
> 无论 principal 是否为 owner，`$events` 与 `$events/result` 都要求 `peer.interactions === 'answer'`；否则返回 `gateway/interactions-forbidden`。只有 owner Peer 接收并回答转发的 waterfall。

**这是多后端要考虑的实际约束**：每个后端只能有**一个** `answer` 类型的 Client 事件流（`requiresInteractions` + `remoteEventClients` 按 Peer 管理）。多个 shell 同时连同一个后端时，`hasLiveClient()` 只算 owner 回答流（`dsh-api-gateway/lib/index.js:841-844`），但 waterfall 回复必须来自**持有该事件流的同一 Peer**（`lib/index.js:969`）。切换后端时如果不释放旧 `/api/remote.mux` socket，可能出现 409（`admitConnection` 的 `ownsSocket` 检查，`lib/index.js:764`）。

### 6.4 对多后端的意义

**多后端不需要动 owner/RLS。** 因为：
- 每个后端各自签自己的 cookie，各自拥有自己的 `browserPeer`；
- 每个后端的 cookie 都映射到 owner，权限模型完全一致；
- 不存在「跨后端身份打通」的需求——identity 本来就是每后端本地的。

**唯一要小心的是 `/connect` 的 socket 独占性**（409）和 `answer` 流的唯一性。多开时建议：
- 浏览器 cookie 走 `GET /?token=` 换（可多个 cookie 并存，因为是单例 Peer，不会冲突）；
- 需要长连流的就用一个进一个出，或改用 `interactions=none` + 轮询。

---

## 7. 未完成 / 需要后续验证

明确标注，不做猜测：

1. **未完成：`dsh-app://` 子域多路复用的可行性。** 设想用 `dsh-app://backend-a/index.html` 让每个后端有独立 origin（同源 cookie 语义自动成立）。未验证：
   - `protocol.registerSchemesAsPrivileged` 的 `standard: true` 是否让 `dsh-app://a` 与 `dsh-app://b` 互视为跨源；
   - `dsh-web-frontend` 的 `<base href="./">`（`dsh-host-frontend-static/lib/index.js:85`）在子域下是否仍正确解析资源；
   - Electron `protocol.handle` 能否按 hostname 分派（当前 `lib/main.js:12407-12414` 只处理 `shell` 和 `app` 两个 hostname）。
2. **未完成：`__DSH_TRANSPORT__` 热切换的成本。** 它是 `globalThis` 单值，且 boot 阶段一次性注入（`index-CN7NIWNw.js` offset ~920703）。未测：切换后端是否必须整页 reload，以及 client plugin 的 `ctx.remote` / `ctx.connection` 是否会干净重建。
3. **未完成：多后端共享同一个 `DSH_HOME` 的后果。** 若两个后端共用 `~/.dsh`，它们会：
   - 共享 `client-connection/browser-session` 密钥 → **cookie 虽因 authority 不同而名不同，但密钥相同**，安全边界实际由 authority 提供的隔离变弱（无害于功能，但削弱「删密钥即全撤」的语义）；
   - 共享 `deepseek-account-platform/default`（Platform token）与 `profiles/`、`sessions/`、`storages/` → session 数据混在一起。
   → 多后端**必须**用不同 `DSH_HOME`（`dsh-home-paths/lib/index.js:109-110`，环境变量 `DSH_HOME`；注意空白值视为未设置）。**这点尚未实测验证。**
4. **未完成：`/api/remote.mux` 409 的实际触发与恢复。** 只从源码读到 `record.ownsSocket` 检查（`lib/index.js:764`），未实测切换后端时 socket 释放是否及时。
5. **未完成：`account` 在远端（非 loopback）后端下的登录。** 从 README 推断会失败（`dsh-client-ui-settings-account/README.zh.md:106` 要求回环 HTTP callback origin），未实测。
6. **未完成：`dsh-api-gateway` 是否有 401 直接签发点。** 全仓 grep `writeHead(401` 只命中 `dsh-client-connection/lib/index.js:572`；Gateway 只消费 `admission.rejection` 转成 WebSocket 的 `401 Unauthorized` 行（`lib/index.js:680-691`）。但 `dispityRpc` 路径上的 `gateway/*` 错误码是否会被 upstream 映射成 HTTP 401 未完整追踪。
7. **未完成：`--public-url` + 反向代理场景下的多后端。** 契约上 `publicUrl` 只影响公告 URL 与打印，不影响 cookie 的 `Secure`（`lib/index.js:454-455`），但代理剥前缀后 `Location: ./` 是否仍正确，未验证。

---

## 8. 证据附录

### 8.1 文件清单（本次引用）

| 路径（相对 `@deepseek-ai/`） | 角色 |
|---|---|
| `dsh-client-connection/lib/index.js` | **核心**：BrowserAuth、HostConnectionService、`isTrustedApiRequest`、`/api` 与 `/connect` 挂载 |
| `dsh-client-connection/README.zh.md` | 鉴权与信任边界的权威描述（41-53 行） |
| `dsh-client-connection/lib/client.browser.js` | 浏览器侧 `installConnection`、`openConnectionWebSocket`、`__DSH_TRANSPORT__` 读取 |
| `dsh-client-connection/lib/client.node.js` | Node 侧同构入口（桌面 worker 用） |
| `dsh-host-frontend-static/lib/index.js` | index 请求 → `authorizeIndex` 的唯一接线点（95 行） |
| `dsh-host-webserver/lib/index.js` | 路由表（exact/prefix/upgrade/fallback）、监听器创建、TLS |
| `dsh-web-app/lib/index.js` | `dsh web:` 打印与浏览器交接（156-177 行） |
| `dsh-web-app/lib/startup.js` | `--host/--port/--public-url/--trusted-host/--tls-*` 解析，通配地址拒绝（48 行） |
| `dsh-web-app/cordis.patch.yml` | connection 行配置：`trustedHosts: !!js ctx.webStartup.trustedHosts`（241 行） |
| `dsh-api-gateway/lib/index.js` | `/api` interceptor、`/api/remote.mux` upgrade、`rejectRemoteStreamUpgrade`（680-691） |
| `dsh-api-remote-access/lib/index.js` | `decide` / `allows` / `follow` / `registerPolicy` |
| `dsh-typert-protocol/lib/types/principal.js` | `principalOf`：owner → `undefined` |
| `dsh-credentials/lib/index.js` | `credentialKey` 文法：`<scope>/<id>`，两段都须 `^[a-z][a-z0-9-]*$` |
| `dsh-credentials-local/lib/index.js` | `.credentials.yaml` 读写、record 校验、0600 原子写、writer lock |
| `dsh-home-paths/lib/index.js` | `resolveDshHome`：`$DSH_HOME` → `~/.dsh` |
| `dsh-deepseek-account-platform/lib/index.js` | `KEY = credentialKey('deepseek-account-platform','default')`、`platformOrigin`/`inferenceOrigin` 默认值 |
| `dsh-deepseek-account-platform/README.zh.md` | Platform 端点、`x-dsh-auth-token`、PKCE、401/40003 处理 |
| `dsh-deepseek-account/README.zh.md` | 账号服务契约、`getPlatformSession` 仅 Host |
| `dsh-api-account-controller/lib/index.js` | `namespace: "account"` 与 11 个 Remote 方法 |
| `dsh-client-ui-settings-account/README.zh.md` | 账号 UI、loopback 回调限制（106 行）、Desktop 引导 |
| `dsh-desktop-host/lib/index.js` | Desktop profile 启动，`authenticatedUrl` 上报（342 行） |
| `dsh-desktop-host/lib/cli.js` | Desktop 内置 CLI |

### 8.2 桌面 shell（asar 根，不在 `@deepseek-ai/` 下）

| 路径 | 行号 | 内容 |
|---|---|---|
| `lib/main.js` | 7009 | `const SCHEME = "dsh-app"` |
| `lib/main.js` | 11880-11890 | `registerSchemesAsPrivileged`：`standard/secure/supportFetchAPI/corsEnabled/stream/codeCache` |
| `lib/main.js` | 8229-8236 | `authenticateWebHost`：Node fetch 换 cookie |
| `lib/main.js` | 8243-8255 | `WITHHELD_RESPONSE_HEADERS`（含 `set-cookie`） |
| `lib/main.js` | 8268-8298 | `forwardWebRequest`：删 `host/origin/cookie/sec-fetch-site`，注入 cookie |
| `lib/main.js` | 12135-12136 | `let hostUrl; let hostCookie;`（单例） |
| `lib/main.js` | 12191-12195 | `hostCookie = await authenticateWebHost(ready.url)` |
| `lib/main.js` | 12406-12415 | `protocol.handle(SCHEME, ...)` |
| `lib/main.js` | 12424-12432 | `DESKTOP_IPC.boot` → `{ injections, streamBaseUrl }` |
| `lib/main.js` | 12447-12469 | `onBeforeSendHeaders`（WebSocket cookie/origin 注入） |
| `lib/preload-app.cjs` | 864-865 | `ready: () => ipcRenderer.invoke(DESKTOP_IPC.boot)` |
| `dsh-web-frontend/dist/assets/index-CN7NIWNw.js` | ~920703 | `__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }` |

### 8.3 关键代码摘录索引

- 常量表：`dsh-client-connection/lib/index.js:271-281`
- token 生成：`294-300`
- authority 规范化：`307-316`
- cookie 名：`335-337`
- cookie 属性：`347-350`
- 签名/验签：`351-390`
- 密钥初始化：`391-408`
- `BrowserAuth` 类：`414-578`
  - `authenticatedUrl`：`440-444`
  - `authorizeIndex`：`458-497`
  - `authorizeConnect`：`505-539`
  - `isAuthenticated` / `authenticateApi` / `authenticate`：`546-570`
  - `writeUnauthorized`：`571-577`
- Trust 栅栏：`240-269`
- Peer 类：`658-684`
- `HostConnectionService`：`692-887`
  - `admit`：`742-750`
  - `createPeer`：`752-754`
  - `admitConnection`：`756-776`
  - `publishPeer`：`781-791`
  - `authorizeConnect` / `authorizeIndex`：`797-810`
- 插件 `apply` / 路由挂载：`1027-1070`
- Config：`1014-1019`

### 8.4 lead 已实测事实对照

| lead 实测 | 代码解释 | 位置 |
|---|---|---|
| `dsh --profile web --no-open --port 0` 打印 `dsh web: http://127.0.0.1:<port>/?token=<32B>` | `authenticatedUrl(appRootUrl())` 在 `console.log(\`dsh web: ${authenticatedUrl}\`)` | `dsh-web-app/lib/index.js:160-162` |
| 无 token GET `/` → 401 | `authorizeIndex` 无 token 且未认证 | `lib/index.js:494-496` |
| 带 token → 303 + `Location: ./` + `Max-Age=2592000` + `HttpOnly` + `SameSite=Strict` | `res.writeHead(303, {...})`，`sessionCookie(..., 30*86400, false)` | `lib/index.js:473-478`, `347-350`, `1017` |
| payload = `{version:1, authority:"127.0.0.1:<port>", issuedAt, expiresAt}` | `encodeCookie({version, authority, issuedAt, expiresAt}, secret)` | `lib/index.js:467-472` |
| 带 cookie GET `/` → 200 | `authorizeIndex` 返回 `true` | `lib/index.js:494` |
| A 端口 cookie 发 B 端口 → 401 | cookie 名按 authority 反查失败 | `lib/index.js:563-564` |
| 错误 Origin → 403 | `isSameAuthorityOrigin` false | `lib/index.js:247-249` |
| `sec-fetch-site: cross-site` → 403 | 显式拒绝 | `lib/index.js:246` |
| 密钥持久化在 `.credentials.yaml` `client-connection/browser-session` | `initializeSecret` + `credentials-local` | `lib/index.js:391-408`, `dsh-credentials-local/lib/index.js:49` |
| 后端重启后旧 cookie 仍 200 | 密钥从文件复用 | `lib/index.js:396-405` |
| 明文 HTTP cookie 不带 `Secure` | `secure` 形参来自 `webServer.protocol === "https:"` | `lib/index.js:349, 809` |
| 通配地址被拒 | `isWildcardHost(options.host)` → `program.error` | `dsh-web-app/lib/startup.js:48` |
| `--host 192.168.55.20` 可绑 + 明文 HTTP 警告 | `console.warn(\`dsh web: listening on ... over plain HTTP...\`)` | `dsh-web-app/lib/index.js:143` |

---

## 9. 给多后端方案的最小结论清单

1. **每个后端 = 一个 token URL + 一份 cookie。** 主进程对每个后端跑一次 `authenticateWebHost`（`lib/main.js:8229`），把 `{url, cookie}` 存进 map。鉴权不需要新代码。
2. **cookie 必须按后端分桶。** authority 绑定天然强制这一点，别试图复用。
3. **不要让浏览器直连远程后端。** `SameSite=Strict` + Origin 栅栏双重封锁。必须走主进程转发（HTTP 用 `forwardWebRequest` 风格，WS 用 `onBeforeSendHeaders`）。
4. **`hostUrl`/`hostCookie` 需要从单值改成按 backend 索引的 map**，`protocol.handle` 与 `onBeforeSendHeaders` 同步改。
5. **每个后端要独立 `DSH_HOME`。** 否则密钥、Platform token、session 数据全部串味（`resolveDshHome`，`dsh-home-paths/lib/index.js:109`）。
6. **account 命名空间不用动。** 它认的是云端 Platform 账号，与后端鉴权正交。但远端非 loopback 后端会踩 `startSignIn` 的回调 origin 限制。
7. **不要指望 `--trusted-host` 解决跨源。** 它只放开 Host 白名单，不放开 Origin 同源要求。
