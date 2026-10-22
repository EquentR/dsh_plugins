# auth-gateway 实现契约（v1）

本文件是 `@dsh-plugins/auth-gateway` 各模块之间的**唯一接口约定**。所有实现必须遵守；
如需变更契约，先改本文件再改代码。

来源：抽离自 `55.107` 的 `@yiln-dsh/dsh-plugin-auth-webserver@0.7.6`（已取源码到
`docs/research/_artifacts/extract/auth-webserver-plugin/`，仅作参考，不作运行时依赖）。

## 0. 目标与范围

- **范围（已与用户确认）**：登录页、会话认证、账号密码修改、TOTP 两步验证、
  Host/Origin 双栅栏（421）、HTTP + WebSocket 反向代理、密钥文件安全、
  远程浏览器的页面内目录选择器（见 3.12）。
- **不做**：WebAuthn/passkey、PWA、移动端抽屉布局。
- **版本自适应**：同一份代码同时支持 dsh `0.2.0-rc.2`（npm 版）与 `0.2.1-rc.2`（桌面版），
  以及 Windows / Linux。
- **分发形态**：与仓库其他插件一致的可持久安装包（`index.js` + `client.js` +
  `cordis.patch.yml` + `locale/` + `icon.svg` + `lib/` + `package.json` + `README.md`）。

## 1. 关键架构决策：不依赖 `settings.register`

**事实**：`0.2.0-rc.2` 与 `0.2.1-rc.2` 的 `@deepseek-ai/dsh-settings` **都没有** `register()`
（0.2.1 只导出 `SettingsConflictError, SettingsForms, redactSecrets`）。原插件用
`settings.register(NS, Schema, ...)`，这是它在两版上都失败的根本原因。

**决策**：
1. **静态配置**走 Loader row `Config`（`cordis.patch.yml` 的 `config:` 块），由 Loader 负责解析与
   校验。`inject` 列表**不含 `settings`**。
2. **可变状态**（账号、口令哈希、TOTP 密钥、会话、authEpoch）走**插件自管 JSON/文本文件**，
   放在 `$DSH_HOME/plugins/dsh-auth-gateway/`。
3. 客户端设置页通过**插件自有的 `/api` RPC**（沿用 `connection` 的 shared fetch handler）
   读写，不经过 Host settings 服务。

好处：两版完全共用代码，无 `settings.register` 兼容分支；不再受 `settings.yaml` 改名影响。

## 2. 目录结构

```
auth-gateway/
  index.js            Host 入口：apply(ctx, config)、Config schema、网关装配
  client.js           客户端设置页（settings.section slot + __ModuleLoader__ 注册）
  cordis.patch.yml    bundle patch（一行 Loader row）
  package.json
  README.md
  icon.svg
  locale/{zh,en}.json
  lib/
    paths.js          状态目录/文件定位（含 DSH_HOME 解析、Windows 适配）
    safe-fs.js        私有文件读写（跨平台权限：POSIX chmod / Windows icacls）
    policy.js         Host/Origin 解析与栅栏（源自 107，纯函数，零依赖）
    totp.js           TOTP 生成/校验（base32 + HMAC-SHA1）
    credentials.js    账号/口令哈希/TOTP 密钥的读写与迁移（自管）
    sessions.js       会话存储（HMAC cookie 记录、CSRF、过期/空闲超时）
    login-page.js     登录页 HTML 渲染（中英双语）
    core-session.js   借用 core `connection.authenticatedUrl()` 兑换并持有 core cookie
    gateway.js        HTTP + WS 鉴权反代主体
    version.js        版本探测与自适应（0.2.0 / 0.2.1 行为差异集中于此）
    carrier-picker.js 远程浏览器的页面内目录选择器（注入脚本 + 受权 FS 原语）
```

## 3. 模块接口（必须严格遵守）

### 3.1 `lib/paths.js`

```js
export function dshHome(): string            // $DSH_HOME 或 os.homedir()/.dsh
export function stateDir(): string           // <dshHome>/plugins/dsh-auth-gateway
export function stateFile(name: string): string
```

### 3.2 `lib/safe-fs.js`

```js
// 目标：POSIX 用 chmod 0600；Windows 用 icacls 收紧到当前用户，绝不因权限位失败而抛错。
export function ensurePrivateDir(dir: string): boolean
export function readPrivateFile(file: string): string | undefined
export function writePrivateFile(file: string, content: string): void
export function hardenFile(file: string): boolean   // best-effort，失败只 warn 不抛
```

**硬性要求（这是 107 在 Windows 崩溃的根因，必须避免）**：
- **绝不**基于 `statSync(f).mode & 0o077` 判断并抛错。Windows 上 mode 恒为 `0o666`。
- 平台分支集中在 `hardenFile`；非 POSIX 平台跳过 mode 断言。

### 3.3 `lib/policy.js`（直接沿用 107 的语义）

```js
export function parseAllowedHost(value, index?): { hostname, port, host }
export function parseRequestHost(value): { hostname, port, host } | undefined
export function parseAllowedOrigin(value, index?): string
export function parseAllowedOriginHost(value, index?): { hostname, port, host }
export function hostMatches(requestHost, allowedHosts, secure?): boolean
export function originMatches(originValue, requestHost, allowedOrigins): boolean
export function parseList(value): string[] | undefined
```

### 3.4 `lib/totp.js`

```js
export function base32Encode(value): string
export function base32Decode(value): Buffer | null
export function generateTotpSecret(): string      // base32, 20 bytes
export function totpCode(secret, timestamp?): string | null
export function verifyTotp(secret, submitted, timestamp?): boolean   // ±1 窗口
export const TOTP_PERIOD_SECONDS_VALUE = 30
export const TOTP_DIGITS = 6
```

### 3.5 `lib/credentials.js`

```js
export const CREDENTIALS_VERSION = 1
// 读取；不存在时返回 undefined（调用方决定是否首次初始化）
export function readCredentials(): Credentials | undefined
export function writeCredentials(next: Credentials): void
export function hashPassword(password: string, salt?: Buffer): { salt: string, hash: string }
export function verifyPassword(password: string, record: Credentials): boolean   // 常量时间
export function effectiveCredentials(config): { username, realm, twoFactorEnabled, twoFactorSecret, hasPassword }
// 合并顺序：文件（可变）> Config（静态）> 环境变量 AUTH_USER / AUTH_PASS
```

`Credentials` 形状（JSON）：
```json
{
  "version": 1,
  "username": "admin",
  "salt": "<base64>",
  "hash": "<base64 scrypt>",
  "authEpoch": 1,
  "totpSecret": "",
  "twoFactorEnabled": false,
  "updatedAt": 0
}
```

口令哈希用 `scrypt`（node 内置 `crypto.scryptSync`），**绝不存明文**。

### 3.6 `lib/sessions.js`

```js
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u
export class SessionStore {
  constructor(options: { file: string, maxAgeSeconds: number, idleTimeoutSeconds: number, authEpoch?: number })
  load(): void
  // 第三参 `authEpoch` 是必需的：会话按 epoch 打标，`verify` 才能拒绝改密码前的旧会话。
  // 省略它会让新会话 stamp 0，与 seed 后的 authEpoch=1 不匹配，导致登录后每个请求都被判匿名。
  create(userAgent: string, remoteAddress: string, authEpoch: number): { id: string, csrf: string }
  verify(id: string, authEpoch: number): boolean
  touch(id: string): void
  revoke(id: string): boolean
  revokeAll(): number
  list(): SessionInfo[]
  persist(): void
  dispose(): void
}
```

会话只存**元数据 + HMAC**，不落 bearer。`authEpoch` 变更即全局失效。

### 3.7 `lib/login-page.js`

```js
export const loginLocales: string[]
export function selectLoginLocale(req): string
export function loginErrorMessage(locale, key): string
export function renderLoginPage(options: {
  realm: string, twoFactorEnabled?: boolean, locale?: string,
  rawRequestUrl?: string, error?: string
}): string
```

**不含 PWA 注入**（范围外），因此不 import `pwa.js`。

### 3.8 `lib/core-session.js`（沿用 107 语义，关键安全属性不变）

```js
export function createLoopbackTarget(host, port): { hostname, port, authority, origin }
export function isCoreSetCookie(value): boolean
export function stripCoreCookies(header): string | undefined
export function attachCoreCookie(header, session): string
export function stripCoreSetCookies(headers): object
export function stripLaunchToken(rawUrl): string
export function createCoreSessionBridge(connection, target, options?): {
  ensure(): Promise<{ name, value, expiresAt }>, invalidate(): void, dispose(): void
}
```

**硬性安全属性**：upstream 必须是 loopback（`createLoopbackTarget` 强制）；core cookie 只在内存；
对外剥掉浏览器传来的 `dsh-auth-*`；不把 core 的 `Set-Cookie` 透传出去。

### 3.9 `lib/version.js`

```js
export function detectVersion(ctx): { raw: string, major: number, minor: number, patch: number, flavor: 'npm' | 'desktop' | 'unknown' }
// 各版本行为差异集中在这里，gateway 只调用这些能力探测函数：
export function capabilities(ctx): {
  hasSettingsRegister: boolean,
  coreIndexRedirect: '/' | './',     // 兼容两种
  supportsTapIndex: boolean,
  supportsAuthenticatedUrl: boolean,
}
export function assertRequiredSeams(ctx): void   // 缺关键接缝时抛出明确错误
```

### 3.10 `lib/gateway.js`

```js
export function createGateway(ctx, config, deps): {
  start(): Promise<{ listening: Array<{ address: string, port: number }> }>,
  stop(): Promise<void>,
  status(): { listening: Array<{address,port}>, sessions: number, authEpoch: number },
  routes: {                    // 交给 connection 的 shared fetch handler 或自有 listener
    handleHttp(req, res): boolean,
    handleUpgrade(req, socket, head): boolean,
  }
}
```

`deps` = `{ credentials, sessions, policy, coreSession, version, logger }`（便于单测注入）。

**路由契约（客户端与 Host 的 RPC 契约，两侧必须一致）**：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 未认证 → 登录页；已认证 → 反代上游 |
| POST | `/api/auth.login` | `{username, password, totp?}` → `{ok:true}` + Set-Cookie；失败 `{ok:false,error}` |
| POST | `/api/auth.logout` | 撤销当前会话 |
| POST | `/api/auth.change-password` | `{currentPassword, newPassword, totp?}` |
| GET | `/api/auth.status` | `{authenticated, username, twoFactorEnabled, authEpoch}` |
| POST | `/api/auth.totp` | `{action:'enable'\|'disable'\|'verify', secret?, code?}` |
| GET | `/_dsh/auth-gateway/state` | 供设置页读取状态 |
| GET | `/_dsh/auth-gateway/fs/list?path=` | 页面内目录选择器：列一级子目录（需会话） |
| POST | `/_dsh/auth-gateway/fs/mkdir` | 页面内目录选择器：`{path, name}` 建目录（需会话 + CSRF） |
| 其余 | `/*` | 已认证则反代上游；否则 401/登录页 |

**栅栏顺序（不可颠倒）**：① Host 校验（不匹配 → **421**）→ ② Origin 校验（不匹配 → 403）
→ ③ 认证（未认证 → 401 或登录页）→ ④ 反代。

### 3.10 `lib/settings-rpc.js`（设置页通道）

```js
export const RPC_ENDPOINT = 'auth-gateway'
export const RPC_PATH = '/api/auth-gateway'
export const RPC_VERSION = 1
export function createSettingsRpc(ctx, deps): { dispose }
```

**硬性要求：设置页必须走核心的共享 `/api` 路由（`connection.fetch.register`），
不许走网关自己的监听端口。** 原因：网关关闭时自己的端口不存在，若设置页依赖它，就永远
无法把开关重新打开——早期版本正是因此在 `enabled: false` 时显示「不可用」。

**线协议（三层，全部必需；已由 `test/client-contract.test.js` 锁定）**：

```jsonc
// 1) 请求：connection.rpc.call('/api','auth-gateway', payload)
{ "type": "client-request", "rpcId": "...", "method": "auth-gateway", "payload": { "v": 1, "op": "status", ... } }

// 2) 响应外层：核心的 parseConnectionResponse 只认这个形状
{ "type": "server-response", "rpcId": "...",
  "result": { "ok": true, "value": { /* 见 3 */ } } }

// 3) value 里才是插件自己的信封
{ "v": 1, "op": "status", "result": { "enabled": false, "running": false, ... } }

// 失败：外层直接给错误（error.details 是核心强制字段）
{ "type": "server-response", "rpcId": "...",
  "result": { "ok": false, "error": { "code": "bad_request", "message": "...", "details": {} } } }
```

⚠️ **不要把 `{v, op}` 包到外层 `result` 上。** 核心的 `parseConnectionResponse`
（`dsh-client-connection/lib/client.browser.js`）要求 `result` 恰好是 `{ok,value}`
或 `{ok,error:{code,message,details}}`；多包一层会让核心抛
`TypeError: invalid server-response result`，页面只能显示「保存失败」——这正是早期版本的
真实故障原因。`error.details` 也**必须存在**，缺失同样会被核心判为非法。

**开关语义**：`enabled` 是 `.volatile()` 配置。设置页保存 → `settings.update()` 写 Loader row
→ 同时以刚保存的值 `reconcile()` 立即启停监听器，不等 volatile 事件回流。
`status` 报告的是**配置意图**（`enabled`）与**运行状态**（`running`）两个独立字段：
用户打开开关后必须看到「已启用 + 未在监听 + 原因」，而不是开关自己弹回去。

**namespace 必须从 configEditor 现场发现**：`settings.update(ns)` 的 `ns` 是**运行时** profile
entry id，不等于 `cordis.patch.yml` 里写的那一行。桌面 profile 里写的是 `dsh-auth-gateway`，
而运行时 id 是 **`include:dsh-auth-gateway`**（已用 `Config.listConfigs` 核对）。用错 id 会让
每次保存都失败。

### 3.12 `lib/carrier-picker.js`（远程浏览器目录选择）

```js
export const PICKER_ROUTES = { list: '/_dsh/auth-gateway/fs/list', mkdir: '/_dsh/auth-gateway/fs/mkdir' }
export const CARRIER_PICKER_GLOBAL = '__DSH_DIRECTORY_PICKER__'
export class CarrierPickerError extends Error { code: 'bad-request'|'directory-unreadable'|'directory-exists'|'directory-create-failed', path }
export function fullyQualified(path, platform?): boolean
export function listDirectory(path?, options?): Promise<{
  path, home, crumbs: Array<{name,path}>,
  entries: Array<{name,path,hidden}>, truncated: boolean
}>
export function createDirectory(path, name): Promise<string>
export function injectCarrierPicker(html): string
export const CARRIER_PICKER_SCRIPT: string
```

**为什么存在**：dsh 的目录选择器由 `dsh-host-directory-picker-auto` 在启动时**一次性**判定。
桌面（win32/darwin）且仅回环绑定、无远程 authority 信任时判定为 `native`；它的 Windows 后端
在**宿主机器**上 spawn 子进程弹 `IFileOpenDialog`。桌面窗口因为有 preload 的
`__DSH_DIRECTORY_PICKER__` 而走 Electron 对话框，但经本网关访问的浏览器没有 preload，于是
native 表面会退回 Host RPC，对话框弹在没人看的宿主屏幕上。

**契约**：

1. `injectCarrierPicker` 只在 `200 + text/html + 未压缩` 的文档里，于 `<head>` 起始处插入
   `CARRIER_PICKER_SCRIPT`。脚本在 `globalThis.__DSH_DIRECTORY_PICKER__` 已存在时**立即返回**，
   绝不覆盖桌面壳 preload 提供的真实载体。
2. 脚本定义 `__DSH_DIRECTORY_PICKER__ = { pick(): Promise<string|null> }`，与 preload 的窄接口
   形状一致：选中返回绝对路径，取消返回 `null`。内部用无框架模态框，通过上面两个网关路由
   列目录/建目录，CSRF 取自 `dsh_gw_csrf`（或 `__Host-` 变体）cookie。
3. `list` 是只读路由但**仍要求会话**；`mkdir` 是写路由，必须校验会话 CSRF。
4. 路径必须是完全限定路径（POSIX 绝对；Windows 盘符/完整 UNC）。`name` 必须是单个非空路径段，
   禁止 `/`、`\`、`.`、`..`。列目录上限 1000 条，超出置 `truncated`。
5. 注入由 `Config.remoteDirectoryPicker`（默认 `true`）控制；关闭时不改写文档，也不提供路由。

**安全边界**：这两个路由的权限等于反代页面本身——网关把宿主 core cookie 交给该页面，Workspace UI
本来就能读写宿主文件。`mkdir` 额外要求 CSRF；栅栏与认证顺序不变。

### 3.11 `index.js`

```js
export const name = 'auth-gateway'
export const inject = ['connection']        // 注意：不含 settings
export const Config = z.object({ ... })
export async function apply(ctx, config): Promise<void>
```

## 4. 客户端契约（`client.js`）

- 必须 `__ModuleLoader__.load({ id: '@dsh-plugins/auth-gateway', ... })`（validate.mjs 校验）。
- 设置页注册到 `settings.section` slot，`id: 'auth-gateway'`，`order` 取 20（general=0/models=10/plugins=15）。
- 通过 `ctx.connection` 发 RPC 读写上述路由；**不直接 fetch 绝对地址**。
- Locale：`locale/zh.json`、`locale/en.json` 必须含 `meta.title` 与 `meta.description`。

## 5. 安全要求（不可妥协）

1. 口令只存 `scrypt` 哈希 + 随机盐，常量时间比较。
2. 会话 cookie `HttpOnly` + `SameSite=Strict`（TLS 时加 `Secure`）；另有独立 CSRF cookie，
   改密码等写操作必须校验 CSRF。
3. 登录限流（窗口内最大尝试次数）。
4. 状态文件权限收紧；**Windows 上不因权限位断言失败而抛错**。
5. upstream 强制 loopback；core cookie 永不外泄；`?token=` 从转发 URL 剥离。
6. 栅栏失败必须 fail-closed（Host 不匹配 421、Origin 不匹配 403），**不得**降级放行。

## 6. 验证要求

- `node scripts/validate.mjs` 通过（需先把 `auth-gateway` 加入 `BUNDLES`）。
- `lib/` 下各纯函数模块有单元测试（`node --test test/*.test.js`），至少覆盖：
  policy 栅栏、totp 正负例、credentials 哈希/校验与迁移、sessions 过期/撤销/authEpoch 失效、
  safe-fs 在 Windows 下不抛错、carrier-picker 的路径校验/列目录/建目录/文档注入。
- 端到端：本机起 `--profile web` 后端 + 网关，实测登录 → 会话 → 反代 → WS 101 → 改密码 → 栅栏 421/403
  → 页面内目录选择器的 list/mkdir 路由与匿名拒绝。
