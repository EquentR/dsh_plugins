# auth-webserver 鉴权网关的 Windows 可移植性审计

> 审计对象：`@yiln-dsh/dsh-plugin-auth-webserver@0.7.6`（远端 192.168.55.107 上运行的鉴权网关插件）
> 审计方式：把远端归档拉到本机后**静态通读 + 在本机 Windows 上实跑复现**（远端全程只读，仅 sftp 下载）。
> 结论一句话：**崩溃在插件本体，不在 systemd。插件里只有一处硬依赖 POSIX 权限位（`chmod` + `stat.mode` 校验会话密钥文件），它在 Windows 上是 100% 必然抛错；除此之外整套鉴权/代理内核是跨平台可复用的。而 `dsh-plugin-web-daemon`（systemd 服务化外壳）才是真正不可移植的那一层——但它在 Windows 上不会让进程崩溃，只会变成一堆 `systemctl ENOENT` 的无效按钮。**

本报告中的所有 `文件:行号` 均指归档中的源码。文件根目录记作 **AWS**（`docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver`），systemd 单元归档记作 **UNIT**，`dsh-plugin-web-daemon` 记作 **DAEMON**（`docs/research/_artifacts/extract/plugin-source-repo/dsh-plugins/dsh-plugin-web-daemon`）。

| 简称 | 真实路径 |
|---|---|
| AWS/index.js | [index.js](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/index.js>)（2174 行，Host 主体） |
| AWS/session-store.js | [session-store.js](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/session-store.js>)（182 行） |
| AWS/passkey-store.js | [passkey-store.js](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/passkey-store.js>)（237 行） |
| AWS/policy.js | [policy.js](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/policy.js>)（111 行） |
| AWS/core-session.js | [core-session.js](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/core-session.js>)（217 行） |
| AWS/login-page.js | [login-page.js](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/login-page.js>)（300 行） |
| AWS/totp.js | [totp.js](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/totp.js>)（77 行） |
| AWS/pwa.js / mobile.js | [pwa.js](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/pwa.js>)（129 行）、[mobile.js](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/mobile.js>)（922 行） |
| AWS/settings-editor.js | [settings-editor.js](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/settings-editor.js>)（90 行） |
| AWS/settings-client-patch.js | [settings-client-patch.js](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/settings-client-patch.js>)（80 行） |
| AWS/client.js | [client.js](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/client.js>)（1272 行，GUI 设置卡片） |
| AWS/cordis.patch.yml | [cordis.patch.yml](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/cordis.patch.yml>)（24 行） |
| UNIT | [systemd-user-units](<docs/research/_artifacts/extract/systemd-user-units>)（`dsh-web.service` + `10-preserve-runtime.conf`） |
| DAEMON/index.js | [index.js](<docs/research/_artifacts/extract/plugin-source-repo/dsh-plugins/dsh-plugin-web-daemon/index.js>)（1652 行，systemd 外壳） |

---

## 1. 结论摘要

### 1.1 崩溃归因（核心结论）

**崩溃来自插件本体，且是一条 8 行的"文件权限自检"逻辑，不是 systemd，不是信号，不是 fork，不是原生模块。**

```js
// AWS/index.js:374-387  readPrivateSecret()
const mode = statSync(file).mode & 0o777;
if ((mode & 0o077) !== 0) {
  chmodSync(file, 0o600);                        // Windows 上对权限位是 no-op
  const repaired = statSync(file).mode & 0o777;  // 仍然是 0o666
  if ((repaired & 0o077) !== 0) {
    throw new Error("auth-webserver: persistent session secret must be owner-readable only");
  }
}
```

调用链：`apply()` → `AWS/index.js:504 loadOrCreateSecret()` → `AWS/index.js:391`（文件已存在时）或 `AWS/index.js:405`（并发 EEXIST 时）→ `readPrivateSecret()` → **throw**。

在本机 Windows 上实测（Node v24.19.0 / win32）：

| 场景 | 结果 |
|---|---|
| 冷启动（`$DSH_HOME` 里还没有 `.secret`） | `apply()` 正常 resolve，插件挂载成功，`.secret` 被创建，**mode = 0o666** |
| 第二次启动（`.secret` 已存在） | `apply()` **REJECTED**：`auth-webserver: persistent session secret must be owner-readable only` |
| 第三次启动 | 同上，永远失败 |

即：**在 Windows 上，这个插件"只能成功启动一次"**。第二次起，插件在挂载阶段就抛异常，网关（以及整个 LAN 鉴权入口）不再存在。

> 这条也解释了"用户说之前尝试过直接崩溃"最可能的真实情形：**如果当时把 Linux 的 `$DSH_HOME`（含 `plugins/dsh-plugin-auth-webserver/.secret`、`sessions.json`）一起拷到了 Windows，那么"第一次"启动就已经命中该分支——表现就是"装上/拉起就崩"。** 本机 `%USERPROFILE%\.dsh` 下没有该插件的任何残留（`plugins/` 目录都不存在），所以用户上次的崩溃发生在别的机器/别的 home 上，属于跨平台搬运或重复启动的情形。

仍存的另一种可能：若崩溃发生在"绝对第一次"启动，则不是 `.secret` 分支，而是下面 §5.2 列出的候选（显式 `addresses` 绑不上、端口被占、或 `dsh` 的 loader 把某个条目的挂载失败当作致命错误并退出进程）。两种情形的自检方法见 §5.3。

### 1.2 可移植性判定（插件本体 vs 服务化外壳）

必须把两件事分开看，用户说的"类似 systemd service 的东西不能直接移植"是对的，但它不是崩溃源：

| 层 | 组件 | Windows 可移植性 | 在 Windows 上的实际行为 |
|---|---|---|---|
| **插件本体**（鉴权网关） | `auth-webserver`（AWS/*） | **可移植**，1 行改动即可启动；建议 3–5 处平台分支 | 第 2 次启动 100% 抛错（已复现）；首次启动可用 |
| **服务化外壳** | `dsh-plugin-web-daemon` + `~/.config/systemd/user/dsh-web.service` | **不可移植**（无任何 Windows 分支） | **不会崩**：apply 内所有 `systemctl` 调用都在 try/catch 或 `setTimeout` + try/catch 里；只在用户点 Start/Save 时返回 `systemctl ... failed: spawnSync systemctl ENOENT` 的 400 |
| **周边设施** | UNIT（`dsh-web.service`、`10-preserve-runtime.conf`） | 不可移植 | 概念上需要 Windows 等价物：Windows 服务（SCM）/计划任务 + 用户级自启 |

补充证据：`DAEMON/index.js:51` 的 `isHeadlessHost()` 第一行就是 `if (process.platform !== "linux") return false;`，`DAEMON/index.js:1132` 的磁盘统计同样直接 `return { ..., reason: "unsupported-platform" }`——作者明确只考虑了 Linux，但用的是"降级返回"而非"抛错"，所以外壳是**坏掉**而不是**崩掉**。

结论：**"不能移植"的说法只在服务化层面成立；鉴权网关本身几乎可以原样搬到 Windows。**

---

## 2. 插件架构总览

### 2.1 形态与入口

- 形态：**Cordis bundle 插件**（不是 nginx，不改 core）。`package.json:22-34` 声明 `dsh.bundle.patch` 与 `dsh.client.platform = "web"`。
- 入口：`AWS/index.js` 导出 `name = "auth-webserver"`（:62）、`inject = ["settings", "connection"]`（:67）、`Config` schema（:259-317）、`apply(ctx, config)`（:471-2174）。
- 装配：`AWS/cordis.patch.yml:10-24` 以 `insert` 方式插入一行 `id: webserver-auth`，默认 `port/targetPort` 取 `!!js ctx.webStartup.port ?? 3080`，`targetHost: '127.0.0.1'`。
- 设计契约（文件头注释 :1-19）：stock `dsh web` 继续独占 `127.0.0.1:3080`（含 core 自身的浏览器认证），本插件在**每个非 loopback 网卡地址的同一端口**另起一个 listener，要求账号密码，再反代到 loopback。**公开客户端永远拿不到 core 的进程 token。**

### 2.2 模块划分

| 文件 | 行数 | 职责 | 平台耦合 |
|---|---|---|---|
| `index.js` | 2174 | 网关主体：多网卡 listener、Basic/HMAC-cookie/TOTP/Passkey 认证、Host+Origin 策略、限流、反代 + WebSocket upgrade、`/_dsh/auth-webserver/*` 管理 API、settings 命名空间注册、index-tap 注入 | **有**（`chmod`/`stat.mode`、网卡枚举） |
| `core-session.js` | 217 | **core 会话桥**：校验 `connection.authenticatedUrl()` → 对 loopback 发 `GET /?token=…` → 只接受 `303 + dsh-auth-* cookie` → 内存持有，不落盘 | 无（`node:http`） |
| `login-page.js` | 300 | 自包含中英文登录页（内联 CSS/JS，无外部依赖），`?lang=` 优先于 `Accept-Language`（:62-95） | 无 |
| `policy.js` | 111 | Host / Origin authority 解析与匹配（421 判定、Origin 与 Host 绑定） | 无 |
| `session-store.js` | 182 | 会话注册表 `sessions.json`（**不存 bearer token**），原子写 + 过期/空闲裁剪 | **有**（`chmod` 0o600 / `mkdir` 0o700） |
| `passkey-store.js` | 237 | WebAuthn 凭据 `passkeys.json` + challenge 缓存 | **有**（同上） |
| `totp.js` | 77 | RFC 6238 SHA-1 TOTP，±1 个 30s 步长（:65-74） | 无 |
| `pwa.js` | 129 | 注入 manifest / icons / 直通 service worker；登录前可访问 | 无（`node:fs` 读图标） |
| `mobile.js` | 922 | 注入移动端抽屉外壳（≤760px 去掉桌面 rail） | 无 |
| `settings-editor.js` | 90 | 带 revision 的 YAML 设置文档读写（`withFileLock` + `writeFileAtomic`） | 依赖 DSH core 的 `@deepseek-ai/dsh-atomic-write`（跨平台性取决于 core） |
| `settings-client-patch.js` | 80 | 运行时改写 `@deepseek-ai/dsh-client-ui-settings` 的 client bundle，让网关后的远程浏览器也能用 Host 侧设置 | 有（直接 `writeFileSync` 到 node_modules） |
| `client.js` | 1272 | 设置卡片（React + i18n 字典 `daw-*`），走官方 settings 服务 | 无（浏览器侧） |

依赖面很窄：`node:http` / `node:crypto` / `node:fs` / `node:net` / `node:os` / `node:path` + `@deepseek-ai/schemastery` + `@simplewebauthn/server` + `js-yaml` + `@deepseek-ai/dsh-atomic-write`。**没有 `child_process`，没有原生模块，没有 Unix socket。**

### 2.3 请求生命周期

```
LAN 客户端 → <非 loopback IP>:3080 (auth-webserver listener)
  ├─ validateGatewayRequest()               index.js:670-683
  │    ├─ Host 不在白名单           → 421 Misdirected request          :672-673
  │    ├─ sec-fetch-site=cross-site / Origin 不匹配 → 403               :676-677
  │    └─ requireHttps 且非 HTTPS   → 400                               :679-680
  ├─ 公开 PWA 路径 /favicon /manifest /sw.js → 直接返回（登录前）        :92-96, 2057
  ├─ /api/auth.login | passkey.* | auth.logout | settings-editor        :2058-2072
  ├─ /_dsh/auth-webserver/*（状态/客户端/Passkey/保存/2FA/吊销）         :2073-2097
  ├─ checkAuth() 失败 → 登录页(HTML) 或 401+WWW-Authenticate            :2099-2102, 429-469
  └─ proxyRequest() / proxyUpgrade()                                    :1741-1816 / 1818-1968
        └─ coreSessionBridge.ensure() → core 会话 cookie 注入到 Cookie 头
           剥离 dsh_auth_* 与 dsh-auth-*，改写 Host/Origin 为 127.0.0.1，加 X-Forwarded-For
```

### 2.4 它监听什么 / 如何判定"非本地"

```js
// AWS/index.js:413-425  pickAddresses()
function pickAddresses(config) {
  const override = config.addresses.filter(...);          // 显式白名单优先
  if (override.length > 0) return override;
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.internal) continue;                        // 跳过 loopback
      if (info.family === "IPv4" || info.family === 4) out.push(info.address);
    }
  }
}
```

- **绝不绑 `0.0.0.0`**（README:376-377 明确说明，理由是会和 stock loopback listener 抢端口）。
- 每个地址一个独立 `createServer`（:2039-2144），`server.listen(port, address)`（:2022）。
- 找不到任何非 loopback 地址时**只 warn 不抛**（:1972-1974）。
- `family` 同时兼容字符串（Node ≥18）与数字（旧版），见 :421；本机实测返回 `"IPv4"`（字符串）。
- 无 IPv6：自动枚举只挑 IPv4，因此**天然规避了 Windows 上 IPv6 zone id（`fe80::1%12`）的坑**；但用户显式写 `addresses: ['fe80::1%12']` 时会 `listen` 失败（见 §4-#6）。

---

## 3. Linux 专有依赖逐项排查表

检索方式：对 AWS 全部 `*.js` 做整词 grep（`systemctl|systemd|SIG*|process.kill|chmod|chown|homedir|win32|/proc/|execSync|spawn|child_process|fork|detach|node-pty|koffi|\.node|unref|setInterval`）。

| # | 排查项 | 命中 | 结论 |
|---|---|---|---|
| 1 | `systemctl` / `systemd` 调用 | **0 命中** | 插件本体与 systemd 完全无关 |
| 2 | `~/.config/systemd/user/` | **0 命中** | 同上（该路径只出现在 DAEMON 与 UNIT） |
| 3 | daemonize / fork / detach | **0 命中**（无 `child_process` 导入） | 不自我守护，生命周期完全交给宿主 |
| 4 | `process.kill` / 信号 | **0 命中** | 无信号处理（对比 DAEMON 有 `process.once("SIGTERM")`，见 DAEMON/index.js:519-524） |
| 5 | 文件权限 0600/0700、`chmod`/`chown` | **有，14 处** | **唯一真正的 Linux 专有硬依赖**，详见 §4-#1/#2/#3 |
| 6 | `chown` | 0 命中 | — |
| 7 | POSIX 路径 / `/` 分隔符 | 全部走 `join()`；`~` 展开**同时处理** `~/` 与 `~\`（index.js:138-141） | 兼容 |
| 8 | `os.homedir()` | index.js:134-147（`dshHome()`/`stateDir()`） | Windows 下正确得到 `C:\Users\<user>\.dsh` |
| 9 | `os.networkInterfaces()` 逐网卡绑定 | index.js:413-425 | 兼容（见 §2.4）；虚拟网卡带来的**行为**问题见 §4-#5 |
| 10 | 原生模块（`.node`） | **0**。`@simplewebauthn/server@13.3.3` 的依赖为 `@peculiar/*`、`@levischuck/tiny-cbor`、`@hexagon/base64`，全是纯 JS；`js-yaml` 纯 JS | 无编译产物，Windows 无需 rebuild |
| 11 | `child_process` | 0 命中（AWS 内） | — |
| 12 | Unix socket / `net.Socket` 权限 | 0 命中 | `node:net` 仅用于 `isIP()` |
| 13 | 定时器 / `setInterval` | 无 `setInterval`；仅 `setTimeout` 做 WS 空闲与过期（index.js:1917-1927，钳制在 `0x7fffffff`） | 平台无关 |
| 14 | 时区 | 全部基于 `Date.now()` 毫秒数；TOTP 用 RFC 计数器（totp.js:52） | 无时区依赖 |
| 15 | `process.platform` / win32 分支 | **0 命中** | 不是崩溃点，而是"**没有降级路径**"——移植时必须新增 |

---

## 4. Windows 不兼容点清单

严重度：🔴 崩溃 ｜ 🟡 静默失效（功能/安全属性丢失）｜ 🔵 行为差异/风险

### 🔴 #1 会话密钥文件的 POSIX 权限自检（**确定性崩溃，已实测复现**）

- 位置：[AWS/index.js:374-387](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/index.js#L374-L387>)（`readPrivateSecret`），调用点 [:389-411](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/index.js#L389-L411>) 与 [:504](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/index.js#L504>)。
- 现象：Windows 上 `statSync(f).mode & 0o777` 恒为 `0o666`（十进制 33206）；`chmodSync(f, 0o600)` 只映射"只读属性"，不改权限位；复查仍为 `0o666` → 抛 `persistent session secret must be owner-readable only`。
- 后果：**第 2 次及以后每次启动，`apply()` 直接 reject**，鉴权网关不存在。若 `$DSH_HOME` 是从 Linux 拷来的（`.secret` 已存在），**第 1 次就崩**。
- 修复思路（**1 行**即可跑起来）：把严格校验限定在 POSIX：
  ```js
  if (process.platform !== "win32" && (mode & 0o077) !== 0) { ... }
  ```
  更干净的 5–8 行：抽 `ensurePrivateFile(file)`（POSIX 用权限位；win32 上改用 `icacls` 校验 ACL 或直接跳过并 log 一次 warn）。
- 改动量：**小（1–8 行）**。

### 🔴 #2 `.secret` 不是"普通文件"时同样硬崩（Windows 更易触发）

- 位置：[AWS/index.js:375](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/index.js#L375>) `if (!lstatSync(file).isFile()) throw ...`。
- 现象：Windows 上常见 `C:\Users\x\.dsh` 被 OneDrive / 企业重定向 / junction 接管；若 `.secret` 是符号链接或目录联接，`lstat().isFile()` 为 `false` → 抛出且**未被捕获**（`loadOrCreateSecret` 没有 try/catch 包住这条路径）。
- 对比：`session-store.js:72` 与 `passkey-store.js:86` 的同类检查在 `try` 内（:71-82 / :85-96），只会 warn——所以**只有 `.secret` 这条是致命的**。
- 修复思路：`lstat` 失败/非普通文件时降级为"随机临时密钥 + warn"（与 :397-400、:406-410 已有的降级分支一致）。
- 改动量：小（3–5 行）。

### 🟡 #3 目录/文件 mode 在 Windows 全部无效

- 位置：[index.js:349](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/index.js#L349>)（legacy `state.json` chmod）、[:394](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/index.js#L394>)（`mkdir mode 0o700`）、[:402](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/index.js#L402>)（`writeFile mode 0o600`）；[session-store.js:73,89-96](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/session-store.js#L69-L108>)；[passkey-store.js:87,102-109](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/passkey-store.js#L83-L120>)；[settings-editor.js:87](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/settings-editor.js#L87>)。
- 现象：`chmodSync`/`mode` 在 Windows 上被忽略 → `sessions.json`、`passkeys.json`、`settings.yaml` 对所有本地用户可读。
- 后果：**安全属性静默丢失**（不是崩溃）。在单用户 Windows 桌面上风险低，在多用户/共享机器上是真实漏洞。
- 修复思路：Windows 用 ACL（`icacls <file> /inheritance:r /grant:r "%USERNAME%":F`）或接受"依赖 `%USERPROFILE%` 的默认 ACL"并写进文档。

### 🟡 #4 测试断言直接依赖 POSIX 权限位（说明该假设从未在非 POSIX 上验证）

- 位置：`test/session.test.js:32-33`、`test/passkey-store.test.js:43`（断言 `mode & 0o077 === 0`）。
- 实测：在本机 Windows 跑插件的**无外部依赖**测试子集：**63 项中 61 通过、2 失败，失败项恰好就是这两条权限断言**（`54 !== 0`，54 = 0o066）。其余（Host/Origin 策略、登录页、TOTP RFC 向量、PWA、移动端注入、settings client patch、core-session 桥）**全部通过**。
- 意义：这是"插件内核跨平台、只有权限模型不跨平台"的独立佐证。

### 🔵 #5 自动枚举会把虚拟网卡一起绑上（Windows 特有噪声 → 环境相关崩溃）

- 位置：[index.js:2039-2144](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/index.js#L2039-L2144>) 为每个地址建一个 server，[:2159-2169](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/index.js#L2159-L2169>) 任一 bind 失败即 `throw` 并关闭全部。
- 现象：Windows 桌面通常有 Hyper-V / WSL `vEthernet`、VMware/VirtualBox host-only、Tailscale、VPN 等多个非 loopback IPv4（本机实测只有 1 块 `192.168.55.20`，属幸运情形）。这些地址会**逐个**绑 3080：笔记本电脑休眠/Wi-Fi 重连/VPN 断开时地址消失，枚举与 bind 竞争 → `EADDRNOTAVAIL` → `apply()` 抛 `failed to bind gateway on 3080`。
- 后果：**可能崩**，且是时序相关的偶发崩（Linux 服务器上地址稳定，不容易遇到）。
- 修复思路：`addresses` 显式白名单（已是配置项）；或"逐个 bind，失败的跳过并 warn，只要有一个成功就算挂载成功"（把 :2165-2169 的 all-or-nothing 改成 best-effort）。
- 改动量：小（10–20 行）。

### 🔵 #6 显式 `addresses` 里写 IPv6 zone id 会 bind 失败

- 位置：`addresses` 直通 `server.listen(port, record.address)`（:2022），无任何规范化。
- 现象：`fe80::1%12` 这类写法在 Node/Windows 上不可靠；`::` 会与 stock `127.0.0.1` 并存但和 LAN 语义不同。
- 修复思路：`addresses` 校验时拒绝带 `%` 的项（或走 `listen({address, family, zone})` 的显式形态）。改动量：极小（2–3 行，属配置校验）。

### 🔵 #7 首次在非 loopback 上监听会弹 Windows 防火墙授权

- 现象：Windows Defender 防火墙对"新程序监听非 loopback"弹窗；用户点"取消"后 **bind 仍然成功，但外部不可达** → 观感是"插件起来了但手机连不上"（静默失效，极难自查）。
- 修复思路：文档 + 首次启动时提示"需要放行 Node/dsh 的入站 3080"；或用 `New-NetFirewallRule` 脚本。

### 🟡 #8 `settings-client-patch.js` 运行时改写 node_modules 内的 bundle 文本

- 位置：[settings-client-patch.js:45](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/settings-client-patch.js#L45>) `readFileSync(clientPath)`、[:58](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/settings-client-patch.js#L58>) `writeFileSync(clientPath, body)`、[:63](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/settings-client-patch.js#L63>) 卸载时回写原文。
- 现象：Windows 上如果 OneDrive/AV/索引器持有句柄，写入可能 `EPERM/EBUSY`；已在 try/catch 内 → 只 warn，`allowRemoteSettings` 静默失效。
- 备注：该功能仅 `allowRemoteSettings: true` 时启用（index.js:574-576），Windows 侧建议关闭或改为不落盘方案。

### 🟡 #9 `renameSync` 覆盖写在 Windows 上易被占用打断

- 位置：[session-store.js:95](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/session-store.js#L95>)、[passkey-store.js:108](<docs/research/_artifacts/extract/auth-webserver-plugin/dsh-plugin-auth-webserver/passkey-store.js#L108>)。
- 现象：Node 的 `rename` 在 Windows 上可覆盖已存在文件，但会因 AV/索引器句柄偶发 `EBUSY`；`persist()` 捕获后返回 `false` → **会话不落盘**（重启后全体掉线），只留一条 warn。
- 修复思路：`EBUSY/EPERM` 重试 3 次（退避 20/50/100ms）。改动量：小。

### 🔵 #10 无 `process.platform` 分支（设计层面）

- 全插件 0 命中。这不是单点 bug，而是"该插件从未被当作跨平台代码维护"的直接证据：所有 POSIX 假设都以硬编码形式存在，没有降级路径。移植时应当把"平台相关的 3 件事"集中到一个 `platform.js`：①私有文件权限模型 ②地址枚举/绑定策略 ③（可选）服务化。

---

## 5. 崩溃归因

### 5.1 已证明的因果链（确定性）

```
cold start → .secret 新建(mode 0666) → apply 成功
restart    → readPrivateSecret(): 0o666 & 0o077 ≠ 0
           → chmodSync 无效 → 复检仍 ≠ 0
           → throw → apply() reject
           → 该 bundle 条目挂载失败：日志出现 `auth-webserver: persistent session secret must be owner-readable only`
```

复现记录见 §8.2（本机 Windows 真实 `apply()` 调用，三轮 A/B/C）。

对"进程是否整体退出"这一点，取决于 DSH 的 bundle loader 对"条目挂载失败"的策略（本次审计无法读取 asar 内的 loader 源码，故不作断言）。但无论哪种策略，**结果相同：LAN 鉴权入口消失**。若用户看到的是"进程直接退出"，那就是 loader 把该条目的失败升级成了致命启动错误。

### 5.2 若崩溃发生在"绝对第一次"启动，候选原因（按可能性排序）

1. **`.secret` 已存在**（从 Linux 拷 home、或上次已成功启动过一次）→ 回到 §5.1，这是唯一 100% 必崩的路径。
2. **显式 `addresses` 里的地址当前不存在**（VPN/WSL 网卡名写死、或用 Linux 上的 IP）→ bind 失败 → `:2168` 抛错。
3. **同端口冲突**：`port` 被用户配成与 stock listener 相同的 `0.0.0.0` 语义地址（例如把 `addresses` 写成 `0.0.0.0`）→ 与 core 抢端口 → `EADDRINUSE`。
4. **配置层校验抛错**：`trustedProxyAddresses` 含非 IP（:645-649）、`allowedHosts/allowedOrigins` 拼写不合法（policy.js:4-6, 60-62）、`targetHost` 非 loopback（core-session.js:17-24）——这些都在 apply 早期，**首次启动就会抛**。若从 Linux 配置原样搬过来且其中含 `127.0.0.1`/域名混写，很容易命中。
5. `settings.register` 命名空间冲突（`authEpoch` 等）：可能性低。

### 5.3 一分钟自检清单（给用户/后续实现者）

```powershell
# 1) 是否存在 .secret（存在 ⇒ 必崩分支，先删掉再试即可验证归因）
Test-Path "$env:USERPROFILE\.dsh\plugins\dsh-plugin-auth-webserver\.secret"

# 2) 看启动日志里有没有 auth-webserver: 前缀的致命行
#    "persistent session secret must be owner-readable only"  → §4-#1
#    "failed to bind gateway on 3080: ..."                    → §4-#5/#6
#    "trustedProxyAddresses entry ... must be an IP address"  → §5.2-#4

# 3) 本地枚举会被绑定的地址（与 pickAddresses 等价）
node -e "const n=require('os').networkInterfaces();for(const k of Object.keys(n))for(const i of n[k]||[])if(!i.internal&&(i.family==='IPv4'||i.family===4))console.log(k,i.address)"
```

---

## 6. 最小可移植内核

### 6.1 可以几乎原样复用（跨平台、零 POSIX 依赖）

| 模块 | 可复用度 | 说明 |
|---|---|---|
| `policy.js`（全域） | **100%** | Host/Origin authority 解析与匹配，纯函数。是 421/403 判定的正确实现，直接搬。 |
| `totp.js`（全域） | **100%** | RFC 6238，已含 ±1 步长与重放窗口配合（index.js:1113-1126 的 90s 去重）。 |
| `core-session.js`（全域） | **100%** | 只允许 loopback 目标（:17-24）、校验 `authenticatedUrl` 形状（:126-131）、只接受 `303 + dsh-auth-* + Max-Age` 单 cookie（:155-158）、内存持有、并发折叠（:183-203）。**这是"公开客户端永远拿不到 core token"的关键**。 |
| `login-page.js`（全域） | **100%** | 纯字符串渲染，中英双语，`?lang=` 优先。 |
| `pwa.js` / `mobile.js` | **95%** | 仅读图标文件 + 字符串注入。 |
| HMAC 会话令牌 | **100%** | `sessionId.issuedAt.hmac(secret, id\0user\0pass\0authEpoch\0tokenFactor\0ts)`（index.js:1082-1109），密码/2FA/epoch 变更即时失效。 |
| CSRF | **100%** | cookie + `X-DSH-CSRF` 双重比对，`HMAC(secret,"csrf\0"+token)`（:1088-1090、:1245-1255）。 |
| 认证入口 | **100%** | Basic 与 cookie 双通道，TOTP 开启时主动禁用 Basic（:1220-1229），Basic 也走同一限流（:1225）。 |
| 限流 | **100%** | 双维度（client+user / client）、有界 LRU 淘汰（:1128-1179）。 |
| 反向代理 + WS upgrade | **100%** | 剥离 `authorization`/`x-dsh-csrf`/`x-forwarded-*`（:1725-1739）、改写 Host/Origin 为 loopback（:1761-1765）、剥离 core Set-Cookie（:75-83）、上传/升级双向管道（:1741-1968）。 |
| 安全响应头 | **100%** | :231-246（含 `microphone=(self)` 的取舍）。 |
| `session-store.js` / `passkey-store.js` | **约 95%** | 逻辑（原子写、过期裁剪、`publicSession` 脱敏）全可复用；只需把 4 处 `chmodSync`/`mode` 换成平台抽象（§4-#3）。 |

### 6.2 必须重写/替换

| 项 | 现状 | 为什么必须动 | 工作量 |
|---|---|---|---|
| 私有文件权限模型 | `readPrivateSecret` 硬抛（:374-387） | Windows 无 POSIX 权限位，是崩溃源 | **1–8 行**（最小）/ 30 行（ACL 版） |
| 地址选择与绑定策略 | 全自动枚举 + all-or-nothing（:413-425, :2159-2169） | 虚拟网卡噪声、休眠/重连导致的偶发 bind 失败 | 10–20 行（best-effort 绑定 + 地址白名单） |
| `settings-client-patch.js` | 直接改写 node_modules bundle 文本 | Windows 句柄占用更脆；建议在 Windows 侧关闭该功能 | 0 行（关掉）或 20 行（改写入策略） |
| **服务化外壳（systemd）** | DAEMON 生成/管理 `dsh-web.service`（`renderSystemdUnit`/`writeSystemdUnit`：DAEMON/index.js:1282-1322；`systemctl` 封装：:906-921） | Linux-only，`systemctl` 在 Windows 上是 `ENOENT` | 300–500 行（Windows 服务 SCM / 计划任务 / 登录自启 + 日志重定向），或**直接不用** |
| 信号与优雅停机 | DAEMON `SIGTERM/SIGINT`（:519-524） | Windows 无 SIGTERM；服务停止走 SCM 控制，`Ctrl+C` 是 SIGINT | 归入上一条 |
| `isHeadlessHost` / `/proc` 磁盘统计 | DAEMON:51, 1131-1178 | Linux-only | 可砍掉（仅监控用） |

### 6.3 建议的"Windows 版认证网关"最小实现路径

1. **直接复用** AWS 的 `policy.js` + `totp.js` + `core-session.js` + `login-page.js` + （改造后的）`session-store.js`，把 `index.js` 的认证/代理部分原样搬（它们只依赖 `node:http`）。
2. **只改 3 处平台假设**：①`ensurePrivateSecret()` ②`pickAddresses()`/`listenAll()` ③（可选）`settings-client-patch` 关闭。
3. **不搬 web-daemon**。Windows 上"服务化"用最小替代：`nssm`/Windows 服务包装、或"登录时启动 + 计划任务保活"，都只需 1 个配置文件，不需要 300 行 systemd 生成器。
4. 若不想写代码：**保留插件形态 + 关掉 web-daemon + 修 `.secret` 校验**，是成本最低的"在 Windows 上有等价能力"路径（网关本身跨平台）。

---

## 7. 配置项参考（设计参考）

### 7.1 `webserver-auth` 行配置（`Config`，index.js:259-317）

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | `3080` | 网关在每个非 loopback 地址上监听的端口 |
| `targetHost` | `127.0.0.1` | 上游 host（必须是 loopback，否则 `createLoopbackTarget` 抛错） |
| `targetPort` | `3080` | 上游端口（stock `dsh web`） |
| `addresses` | `[]` | 显式绑定列表；空 = 自动枚举非 loopback IPv4 |
| `username` | `admin` | |
| `password` | `""`（secret role） | 空 = 拒绝任何认证（但 stock loopback 仍可用） |
| `realm` | `DeepSeek Harness Authentication` | Basic 认证域 |
| `twoFactorEnabled` | `false` | 开启后 **Basic 被完全禁用**，必须走表单/POST |
| `requireTwoFactor` | `false` | 部署级强制（settings 无法关掉） |
| `twoFactorSecret` | `""`（secret role） | Base32 |
| `mobileMode` | `auto` | `auto`/`off`；`?dsh_mode=mobile|desktop` 单页覆盖 |
| `mobileBreakpoint` | `760` | 320–1600 |
| `allowedHosts` | `[]` | 空 = 由 `allowedOrigins` 派生，再空 = 用绑定地址 |
| `allowedOrigins` | `[]` | 附加 Origin 白名单（Origin 仍须与 Host 一致） |
| `trustedProxyAddresses` | `[]` | 允许用 `X-Forwarded-Proto: https` 断言 HTTPS 的源 IP |
| `requireHttps` | `false` | 非 HTTPS 一律 400 |
| `allowRemoteSettings` | `false` | 网关后的远程浏览器可用 Host 侧设置页（触发 client bundle patch） |
| `allowInsecureRemoteSettings` | `false` | 允许明文 HTTP 下的远程设置 |
| `allowInsecureSettingsEditor` | `false` | 允许明文 HTTP 下用全量设置编辑器 |
| `passkeyRpName` | `DeepSeek Harness` | |
| `passkeyRpId` | `""` | 空 = 用请求 hostname；注册后不可变 |
| `sessionMaxAgeSeconds` | `86400` | 300 – 30d |
| `sessionIdleTimeoutSeconds` | `43200` | 0 = 关闭空闲检查 |
| `loginMaxAttempts` | `10` | 1–1000 |
| `loginWindowSeconds` | `60` | 1–3600 |
| `maxLoginAttemptEntries` | `10000` | 限流表容量上限 |
| `upstreamTimeoutMs` | `30000` | |
| `requestTimeoutMs` | `120000` | |
| `headersTimeoutMs` | `15000` | |
| `keepAliveTimeoutMs` | `5000` | |

### 7.2 settings 命名空间 `auth-webserver`（index.js:323-330）

`username`、`password`(secret)、`realm`、`twoFactorEnabled`、`twoFactorSecret`(secret)、`authEpoch`。

- `authEpoch` 是**会话代数**：任何凭据/2FA 变更都会 `+1` 并吊销全部会话（:742-760、:608-619、:1059-1066）。这是"改密码即刻踢掉所有已登录浏览器"的实现。
- 优先级：**env > settings(用户文档) > 行配置(基础层)**（:15-18、:622-712）。

### 7.3 环境变量（index.js:622-634）

`DSH_AUTH_USER`/`AUTH_USER`、`DSH_AUTH_PASS`/`AUTH_PASS`、`DSH_AUTH_2FA_SECRET`/`AUTH_2FA_SECRET`、`DSH_AUTH_2FA_ENABLED`/`AUTH_2FA_ENABLED`、`DSH_AUTH_2FA_REQUIRED`/`AUTH_2FA_REQUIRED`、`DSH_AUTH_ALLOWED_HOSTS`、`DSH_AUTH_ALLOWED_ORIGINS`、`DSH_AUTH_TRUSTED_PROXY_ADDRESSES`、`DSH_AUTH_REQUIRE_HTTPS`、`DSH_AUTH_PASSKEY_RP_ID`、`DSH_AUTH_PASSKEY_RP_NAME`。均可写在 `$DSH_HOME/.env`（README:147-167）。

### 7.4 网关自有 API（设计参考）

`/api/auth.login`、`/api/auth.passkey.login.options|verify`、`/api/auth.logout`、`/_dsh/auth-webserver/{state,clients,save,2fa,clients/revoke,sessions/revoke,passkeys,passkeys/register/options,passkeys/register/verify,passkeys/revoke}`、`/_dsh/auth-webserver/settings-editor/document`（index.js:2058-2097、settings-editor.js:6）。

### 7.5 状态文件布局

`$DSH_HOME/plugins/dsh-plugin-auth-webserver/` 下：`.secret`（HMAC 主密钥）、`sessions.json`（会话注册表，**不含 bearer token**）、`passkeys.json`（公钥凭据）、历史遗留 `state.json`（一次性迁移到 settings，index.js:343-372）。

### 7.6 systemd 外壳（UNIT，仅作对照）

`dsh-web.service`：`ExecStart=.../node/bin/dsh --profile web --no-open --port 3080`、`Restart=always`、`RestartSec=2`、`Environment=DSH_WEB_DAEMON_WORKER=1/DSH_HOME/HOME/PATH`、`WantedBy=default.target`。
`dsh-web.service.d/10-preserve-runtime.conf`：手工 drop-in，保留 `WorkingDirectory`（工作区与 sandbox 边界）、`LANG`、`TimeoutStopSec=30`、`KillMode=mixed`——**这四项在 Windows 上没有对等物**（工作目录要靠服务参数、locale 靠系统区域、停机超时靠 SCM、子进程回收靠 Job Object）。

另一个移植细节：`renderSystemdUnit` 把**生成进程的 `process.env.PATH` 原样写进 `Environment=`**（DAEMON/index.js:1299-1306），并在 `PATH` 缺失时回退到 POSIX 默认值（`/usr/local/sbin:...`）；`workerCommandFor` 的默认端口是 3081（:1273，与 UNIT 实物里的 3080 不同，说明端口来自 profile 配置）。这两处在 Windows 上不会报错，但会写出无意义的单元内容——属于"外壳必须重写"的又一证据。

---

## 8. 证据附录

### 8.1 取数方式（远端只读）

ssh2/SFTP 下载三个归档到 `docs/research/_artifacts/`，本机 `tar -xzf` 解包（Windows 自带 `tar` 可解 gzip tar）：

| 归档 | 大小 | 内容 |
|---|---|---|
| `auth-webserver-plugin.tgz` | 108,870 B | 插件全量源码（13 个 `*.js` + `pwa/` + `test/` + `cordis.patch.yml` + README） |
| `plugin-source-repo.tgz` | 689,627 B | `~/.review/dsh-plugins` 仓库（含 `dsh-plugin-web-daemon`） |
| `systemd-user-units.tgz` | 1,266 B | `dsh-web.service`、`10-preserve-runtime.conf`、两个 `.wants` 符号链接 |

### 8.2 Windows 上实跑 `apply()`（决定性证据）

脚本：`docs/research/_artifacts/wintest/run-apply.mjs`（用 stub 顶替 `@deepseek-ai/schemastery`、`@simplewebauthn/server`、`js-yaml`、`@deepseek-ai/dsh-atomic-write`，只为让 `index.js` 能被 import；被测代码是**真实 `apply()`**）。为避免触碰真实端口，`port: 0`、`addresses: ['127.0.0.1']`。

```
platform: win32 node: v24.19.0
NIC IPv4 candidates (pickAddresses equivalent): [ { "name": "以太网 3", "address": "192.168.55.20", "family": "IPv4" } ]

=== A. cold start (DSH_HOME=C:\Users\UT\AppData\Local\Temp\dsh-auth-winrepro-3igkP7) ===
  [info] auth-webserver: LAN gateway listening on http://127.0.0.1:0 -> http://127.0.0.1:1
  RESULT: apply() resolved (plugin mounted)
  state dir contents: .secret
  .secret mode = 0666 (owner-only check: (mode & 0o077) = 0o66)

=== B. restart with existing .secret ===
  RESULT: apply() REJECTED -> auth-webserver: persistent session secret must be owner-readable only

=== C. third start ===
  RESULT: apply() REJECTED -> auth-webserver: persistent session secret must be owner-readable only

SUMMARY: {"first":"mounted","second":"rejected","third":"rejected"}
```

最小复现（不需要 DSH，只验权限语义）：

```
platform win32 / mode decimal 33206 octal 666 / mode&0o077 = 66
chmod 0o600 → 无异常，但复检仍是 666 → "needsRepair" 恒为 true
```

### 8.3 在 Windows 上跑插件自带测试（无外部依赖子集）

```
node --test test/session.test.js test/passkey-store.test.js test/policy.test.js \
          test/login-page.test.js test/totp.test.js test/pwa.test.js test/mobile.test.js \
          test/client.test.js test/settings-client-patch.test.js test/core-session.test.js

ℹ tests 63   pass 61   fail 2
✖ test/session.test.js:12        AssertionError: 54 !== 0   (断言 mode & 0o077 === 0)
✖ test/passkey-store.test.js:21  AssertionError: 54 !== 0   (同上)
```

即：**只有权限位相关断言失败，其余 61 项（含 TOTP RFC 向量、Host/Origin 策略、core-session 桥、PWA/移动端注入、settings client patch）在 Windows 上全部通过。**

未在本机跑的两组：`proxy.test.js`（需要真实 npm 依赖，本机 registry 缺 `@deepseek-ai/*`）与 `settings-editor.test.js`（需要 `@deepseek-ai/dsh-atomic-write`）。另注：`proxy.test.js:119` 绑定 `127.0.0.2`，在 Windows 上通常 `EADDRNOTAVAIL`（Windows 默认只把 `127.0.0.1` 给 loopback），说明该测试套件本身也未考虑 Windows。

### 8.4 关键代码位置索引

| 结论 | 位置 |
|---|---|
| 崩溃点：私有密钥权限自检 | `AWS/index.js:374-387` |
| 崩溃调用点 | `AWS/index.js:389-411`（:391 / :405）、`AWS/index.js:504` |
| 密钥文件写入 mode | `AWS/index.js:402` |
| 目录 mode | `AWS/index.js:394`、`session-store.js:89`、`passkey-store.js:102` |
| 非致命但已生效的 chmod | `index.js:349`、`session-store.js:73,94,96`、`passkey-store.js:87,107,109` |
| 地址枚举 | `AWS/index.js:413-425` |
| bind all-or-nothing | `AWS/index.js:2159-2169` |
| 421 / Origin 判定 | `AWS/index.js:670-683` + `policy.js:50-57, 89-104` |
| HMAC 令牌 / CSRF | `AWS/index.js:1082-1109`、`1186-1202`、`1236-1256` |
| 限流 | `AWS/index.js:1128-1179` |
| TOTP 重放窗口 | `AWS/index.js:1113-1126` |
| core 会话桥（token 不外泄） | `AWS/core-session.js:126-167`、`183-203` |
| 代理 / WS upgrade | `AWS/index.js:1741-1816` / `1818-1968` |
| settings-client bundle 改写 | `settings-client-patch.js:29-79` |
| web-daemon 的 Linux-only 判定 | `DAEMON/index.js:51`、`1131-1134` |
| web-daemon 的 systemctl 封装 | `DAEMON/index.js:906-966` |
| web-daemon 的启动自拉（不致命） | `DAEMON/index.js:1457-1469`、`1442-1444` |
| systemd 单元实物 | `UNIT/dsh-web.service`、`UNIT/dsh-web.service.d/10-preserve-runtime.conf` |

### 8.5 审计边界与未验证项

- DSH 的 bundle loader 对"插件 apply 抛错"是否升级为进程退出：**未验证**（asar 内的 core 源码本次不可读）。
- `@deepseek-ai/dsh-atomic-write` 的 `withFileLock` 在 Windows 上的实现（是否依赖 POSIX 锁文件语义）：**未验证**（本机无该包，且 registry 镜像缺失）。这会影响"远程设置文档编辑器"（`allowInsecureSettingsEditor`/`settings-editor`）而非核心网关。
- `client.js`（GUI 卡片）的浏览器侧行为：未逐行审（平台无关的 React + i18n）。
- 远端服务未做任何启动/重启/配置变更；`%USERPROFILE%\.dsh` 下无该插件残留，故"上次 Windows 崩溃"的具体机型状态无法取证。

### 8.6 归档说明

`docs/research/_artifacts/` 为本次审计的临时取证目录（含 3 个 tgz、解包源码、`wintest/` 复现脚本、stub `node_modules`）。这些不应提交：建议在 `.gitignore` 增加 `docs/research/_artifacts/`。仓库的 `scripts/validate.mjs` 使用显式包名白名单（`BUNDLES`/`PRESETS`/`FUNCTION_BODIES`），不会扫描该目录，因此不影响校验结果。
