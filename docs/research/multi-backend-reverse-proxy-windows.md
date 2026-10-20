# Windows 下让本地 dsh 支持反向代理托管

> 调研对象：DeepSeek Harness 桌面版内置 dsh `0.2.1-rc.2`（Windows）
> 方式：源码阅读 + lead 本人端到端实测（起停真实后端 + 自写 Node 反代）
> 性质：**只读调研 + 隔离实测**；未修改源码、未注册服务/计划任务、未改动 `desktop` profile
> 相关报告：[可行性总报告](./multi-backend-feasibility.md)、[插件可移植性](./multi-backend-plugin-portability.md)、[107 原地升级](./multi-backend-legacy-107.md)

---

## 一、结论摘要

1. **dsh 可以被反向代理，已端到端实测通过**（含 WebSocket）。关键只有两条：**反代必须原样透传客户端的 `Host`**，且**后端必须用 `--trusted-host` 声明该公网 authority**。
2. **`--trusted-host` 不是可选项，是必需项。** 对照实验（都带有效 cookie）：声明 + 公网 Host → **404（放行）**；未声明 + 公网 Host → **403（拒绝）**。原因是 Host/Origin 栅栏 `isTrustedApiRequest` 只认 loopback、绑定 IP、或 `trustedHosts` 条目。
3. **绝不能把 Host 改写成 upstream。** cookie 的 audience 是**按客户端发来的 Host 算的**，实测得到 `authority: "myhost.example:34802"`。若反代把 Host 改写成 `127.0.0.1:<port>`，服务端签发的 cookie audience 就变成 loopback，浏览器在公网域名下永远对不上 → **无限 401**。
4. **桌面 GUI 自带的那个后端无法被反代**：壳启动内嵌 host 时硬编码 `--no-open --host 127.0.0.1 --port 0`（`dsh-desktop-host/lib/index.js:234-240`），端口是 OS 临时端口、每次启动都变。**要反代必须另起一个常驻实例。**
5. **推荐 dsh 自己终止 TLS**（`--tls-cert/--tls-key`），而不是让代理终止。因为 `Secure` 标志**只由监听器自身协议决定**：TLS 直供时 cookie 带 `Secure` 且 audience 是完整 origin；代理终止 TLS 时 cookie **没有 `Secure`**（局域网可嗅探）。
6. **`web` profile 才是"纯服务端"的正解**，不是 `desktop`。`desktop` profile 绑定了 Electron 相关实验 bundle 和本机 link 插件路径。
7. **只要"单用户安全远程访问"，原生 flag + Caddy/nginx 就够了**；107 那套插件只在需要**账号密码 / 登出 / 撤销 / 审计**时才有必要。

---

## 二、Windows 上如何常驻一个可被反代的 dsh

### 2.1 为什么必须"另起实例"

| | 桌面 GUI 内嵌后端 | 独立常驻实例 |
|---|---|---|
| 启动方式 | 壳 spawn，硬编码 `--host 127.0.0.1 --port 0` | 你手动/服务启动，端口固定 |
| 端口 | OS 临时端口，**每次启动都变** | 固定，可配反代 |
| 生命周期 | 跟随 GUI | 独立，GUI 关了也在 |
| 可否反代 | ❌ 端口不稳定 | ✅ |

**实践含义**：反代方案不是"给桌面版加个开关"，而是"另跑一个服务端 dsh 实例"。

### 2.2 启动命令

本机 CLI 入口：`D:\program\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`（内容即用 `ELECTRON_RUN_AS_NODE=1` 调 Electron 主程序跑 `dsh-desktop-host/lib/cli.js`，所以**不依赖 GUI**）。

```bat
:: 最小可反代的常驻实例（明文 HTTP，仅内网/仅经反代暴露时使用）
"C:\path\to\dsh.cmd" --profile web --no-open --host 127.0.0.1 --port 34801 --trusted-host dsh.example.com
```

要点：
- **不要用 `--port 0`**：端口必须稳定，否则反代配置无法固定。
- `--host 127.0.0.1` + 反代同机是最小暴露面；也可直接 `--host <LAN IP>`（`0.2.1-rc.2` 支持任意具体 IP，但**拒绝通配 `0.0.0.0`**）。
- `--trusted-host <公网 authority>` 必须与浏览器实际访问的 authority 一致（见第三节）。
- 建议显式设 `DSH_HOME`，避免与服务账户的家目录混淆：
  ```bat
  set DSH_HOME=C:\Users\UT\.dsh
  ```

**实测确认**（lead 本人执行，均成功）：
```
dsh --profile web --no-open --port 0
  → dsh web: http://127.0.0.1:63071/?token=<...>          ✅

dsh --profile web --no-open --host 192.168.55.20 --port 0
  → dsh web: listening on 192.168.55.20 over plain HTTP; restrict this port to a trusted proxy or network
  → dsh web: http://192.168.55.20:63800/?token=<...>       ✅
```

### 2.3 profile 选择：用 `web`，不用 `desktop`

`web` profile（实测读取 `C:\Users\UT\.dsh\profiles\web\package.json`）只有两个 bundle：
```json
"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
```

`desktop` profile（`C:\Users\UT\.dsh\profiles\desktop\package.json`）额外含：
- `@deepseek-ai/dsh-experimental-agent-team-profile`
- `@deepseek-ai/dsh-experimental-inspector-profile`
- 以及 5 个 **本机 link 路径**插件（`link:D:/projects/dsh_plugins/...`）：`git-graph`、`delete-session`、`mentor`、`obedient-preset`、`network-proxy`

**结论**：常驻服务用 `--profile web` 最干净、依赖最少。若你希望服务端也有那几个插件，**应把它们加进 `web` profile**，而不是复用 `desktop`（后者的 link 路径与本机开发目录绑定，换机/换用户即失效）。

### 2.4 Windows 自启方案对比

> ⚠️ 以下仅为配置研究，**本次未执行任何注册操作**。

| 方案 | 优点 | 陷阱 |
|---|---|---|
| **(c) 启动文件夹批处理**（最简） | 零依赖，`shell:startup` 放个 `.bat` 即可 | 只在**用户登录后**运行；注销即停；有黑窗 |
| **(a) 任务计划程序** | 可设"不管用户是否登录"、开机触发、失败重启 | 需"最高权限"选项；工作目录须显式设；服务账户下 `DSH_HOME` 不是你的家目录；无 GUI 时若插件依赖桌面会失败 |
| **(b) NSSM / WinSW 注册为服务** | 真正的服务语义：开机自启、崩溃自动重启、日志重定向 | **Session 0 隔离**（无桌面、无交互）；必须绝对路径；stdout/stderr 要显式重定向否则无日志；Node/Electron 进程被杀时子进程可能残留；卸载不当会留下孤儿 |

NSSM 示例（**仅示例，未执行**）：
```bat
nssm install dsh-web "C:\path\to\dsh.cmd" "--profile web --no-open --host 127.0.0.1 --port 34801 --trusted-host dsh.example.com"
nssm set dsh-web AppDirectory "C:\path\to"
nssm set dsh-web AppStdout "C:\logs\dsh-web.out.log"
nssm set dsh-web AppStderr "C:\logs\dsh-web.err.log"
nssm set dsh-web AppExit Default Restart
nssm set dsh-web AppEnvironmentExtra "DSH_HOME=C:\Users\UT\.dsh"
```
任务计划程序（**仅示例，未执行**）：
```bat
schtasks /create /tn "dsh-web" /tr "\"C:\path\to\dsh.cmd\" --profile web --no-open --host 127.0.0.1 --port 34801 --trusted-host dsh.example.com" /sc onstart /ru SYSTEM /rl HIGHEST
```
> 用 `/ru SYSTEM` 时务必同时 `set DSH_HOME`，否则会去读 `C:\Windows\System32\config\systemprofile\.dsh`，得到一个"空白 dsh"（没有你的凭据、模型配置、会话）。

---

## 三、反代配置（可复制）

### 3.1 铁律：保留原 Host + 设 `--trusted-host`

```nginx
location / {
    proxy_pass http://127.0.0.1:34801;
    proxy_set_header Host $http_host;   # ★ 必须保留客户端 Host，不可改成 upstream
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;           # WebSocket 长连接，不能太短
    proxy_buffering off;                # 流式响应
    client_max_body_size 300m;          # 对应 maxRequestBodyBytes 默认 300MiB
}
```

**为什么不能改写 Host**（本次实测的核心机制）：
- `requestAudience()`（`dsh-client-connection/lib/index.js:307-316`）用 `new URL(\`${secure?"https:":"http:"}//${host}\`)` 计算 audience：`secure` 时取 `url.origin`，否则取 `url.host`。
- 实测：客户端 Host 为 `myhost.example:34802` 时，签发的 cookie payload 是 `authority: "myhost.example:34802"`，cookie 名 = `dsh-auth-<sha256(authority) 的 base64url>`。
- 若反代把 Host 改成 `127.0.0.1:34801`，服务端就按 loopback 签 cookie；浏览器在 `https://dsh.example.com` 下回传时，服务端**按当前 Host 反查 cookie 名**，算出来是另一个名字 → 根本找不到 cookie → **无限 401**。

`--trusted-host` 的作用与边界（务必理解）：
- 它把 authority 加进 `/api` 栅栏的 `trustedHosts` 白名单。宿主必须命中 loopback / 绑定 IP / 该白名单之一。
- **它只放开 Host 白名单，不放开 Origin 同源要求**（`isTrustedApiRequest`，`dsh-client-connection/lib/index.js:245` vs `:249`）。`Origin` 仍必须与 `Host` 同 authority，`sec-fetch-site: cross-site` 仍一律拒。
- 免端口条目 `dsh.example.com` 匹配任意端口；带端口条目 `dsh.example.com:8443` 精确匹配。

**对照实验证据**（均带有效 cookie，访问 `/api/remote.mux`）：

| 后端启动参数 | 请求 Host | 结果 | 含义 |
|---|---|---|---|
| `--trusted-host myhost.example` | `myhost.example:34802` | **404** | 过栅栏，上游无此路由 |
| 无 `--trusted-host` | `myhost.example` | **403** | 栅栏拒绝 |
| 无 `--trusted-host` | `127.0.0.1:34811` | **404** | loopback 天然放行 |

### 3.2 Caddy（Windows）

Caddy 的好处：自动 HTTPS、WebSocket 自动透传、`Host` 默认保留。

```caddyfile
dsh.example.com {
    reverse_proxy 127.0.0.1:34801 {
        # Caddy 默认保留原 Host，无需额外设置
        header_up X-Forwarded-Proto {scheme}
    }
}
```
对应后端应启动为：
```bat
dsh.cmd --profile web --no-open --host 127.0.0.1 --port 34801 --trusted-host dsh.example.com
```

若要加一层账号密码（替代 107 的插件的一部分能力）：
```caddyfile
dsh.example.com {
    basic_auth {
        alice $2a$14$<bcrypt-hash>
    }
    reverse_proxy 127.0.0.1:34801
}
```
> 局限：Caddy `basic_auth` 能挡住**入口**，但没有登录页、没有登出按钮、没有逐设备撤销、没有登录审计。它挡的是"没密码的人"，不是"管理会话"。

### 3.3 `--public-url` 的作用与边界

- 它只影响**对外公告**的 URL 形态：启动时打印的 URL、浏览器自动打开、`DSH_WEB_URL`、以及 agent runtime context 里的地址。
- **它不授予任何信任**（官方文档原文："grants no trust"）。信任仍由 `--trusted-host` 决定。
- 剥离前缀的代理场景示例（把 `/ui/` 前缀去掉后再转发）：
  ```
  dsh --profile web --no-open --port 34801 \
      --public-url https://app.example/ui/ \
      --trusted-host app.example
  ```

---

## 四、Cookie / Secure / audience 的坑

### 4.1 两种 TLS 形态对比（实测）

| | TLS 直供（dsh 自己持证书） | 代理终止 TLS |
|---|---|---|
| 启动参数 | `--tls-cert cert.pem --tls-key key.pem` | 无 TLS 参数，代理持证书 |
| cookie audience 拼写 | **`https://127.0.0.1:34811`**（完整 origin） | **`myhost.example:34822`**（host 形式） |
| cookie 是否带 `Secure` | **✅ 带** | **❌ 不带** |
| 两者 cookie 可否互用 | **不可**（audience 拼写不同，且 cookie 名由 audience 派生） | 同左 |
| 功能是否可用 | ✅ | ✅（含 WS 101） |

机制：`secure` 参数只来自监听器自身协议 —— `this.ctx.get("webServer")?.protocol === "https:"`（`dsh-client-connection/lib/index.js:745, 808-809`）。**`--public-url` 与任何转发头都不参与判断。**

### 4.2 推荐做法

**推荐：让 dsh 自己终止 TLS**，反代只做纯转发。
```bat
dsh.cmd --profile web --no-open --host 127.0.0.1 --port 34811 ^
        --tls-cert "C:\certs\fullchain.pem" --tls-key "C:\certs\privkey.pem" ^
        --trusted-host dsh.example.com
```
好处：cookie 带 `Secure`（只经 TLS 发送），audience 是 `https://` origin，语义正确。

**若必须代理终止 TLS**（例如统一在 Caddy 管证书）：
- 功能能跑通，但 cookie 没有 `Secure`。在明文 HTTP 段（代理→dsh 若跨机）或局域网内，会话 cookie 可被嗅探。
- 缓解：代理与 dsh **必须同机**（`127.0.0.1`），保证明文段不出网卡；并在代理层限制来源 IP。
- 注意：**不要**因此把 dsh 的 `--tls-cert` 和代理 TLS 混着配却指望 cookie 通用——两者的 audience 拼写不同，**不通用**。

### 4.3 其他反代注意点

- **不要剥离或改写 `Origin`**：栅栏要求 `Origin` 与 `Host` 同 authority；乱改会 403。
- 不要注入 `sec-fetch-site: cross-site`：一律拒。
- WebSocket 路径是 **`/api/remote.mux`**（`0.2.0-rc.2` 起；旧版是 `/api/ws`）。反代需支持 Upgrade。
- 大文件/图片上传走 RPC，受 `maxRequestBodyBytes`（默认 300MiB）限制，反代 `client_max_body_size` 要跟上。
- 无 logout：清浏览器 cookie 即结束该会话；彻底撤销需删除 `$DSH_HOME/.credentials.yaml` 里的 `client-connection/browser-session` 记录并重启 dsh。

---

## 五、还需要 107 那套插件吗？

### 5.1 三方案对比

| 能力 | (i) 原生 `--host` + TLS | (ii) 原生 + Caddy/nginx | (iii) 移植 107 auth 网关插件 |
|---|---|---|---|
| 远程访问 | ✅ | ✅ | ✅ |
| 传输加密 | ✅（自签或正式证书） | ✅（Caddy 自动签发） | 取决于部署 |
| **账号密码登录页** | ❌ 只有 token URL | ⚠️ Basic Auth（无页面） | ✅ 完整登录页 |
| **登出** | ❌ | ❌ | ✅ |
| **逐设备撤销 / 踢断** | ❌ | ❌ | ✅ |
| **登录审计** | ❌ | ⚠️ 仅 access log | ✅ |
| 多用户身份区分 | ❌ 认证即 owner | ⚠️ 仅认证层 | ✅ 网关层可区分 |
| Windows 适配 | ✅ 原生 | ✅ 原生 | ⚠️ 需打补丁（见 5.2） |
| 维护成本 | 低 | 低 | 高（跟着 dsh 版本走） |
| 与 dsh 版本耦合 | 无 | 无 | **高**（靠内部 API/字符串打补丁） |

### 5.2 结论

- **只要"我自己安全地远程用一个 dsh"** → **(i) + (ii) 就够**。原生 `--host` 绑局域网 IP、dsh 自己 TLS、Caddy 管证书与入口。零插件、零版本耦合。
- **要"多个人用、能登出、能踢人、能查谁登过"** → 才需要 **(iii)**。这是当前 dsh 的真实缺口：它只有「单一进程 token → 单一 cookie → **所有通过认证的连接都是 owner**」，没有身份、没有登出、没有撤销粒度、没有审计。
- 折中：**(ii) 的 Basic Auth + 反代访问日志**能覆盖"挡外人 + 粗审计"，但补不上登出与逐设备撤销。

### 5.3 若走插件路线：Windows 崩溃根因已定位并验证修复

用户提到"之前尝试直接崩溃"。根因已由本次调研定位并**在 Windows 上亲自复现**：

`index.js:374-387` 的 `readPrivateSecret()` 用 POSIX 权限位判断会话密钥文件是否私有：
```js
const mode = statSync(file).mode & 0o777;
if ((mode & 0o077) !== 0) {
  chmodSync(file, 0o600);
  const repaired = statSync(file).mode & 0o777;
  if ((repaired & 0o077) !== 0) {
    throw new Error("auth-webserver: persistent session secret must be owner-readable only");
  }
}
```
Windows 上 `mode` 恒为 `0o666`，`chmodSync` 只映射"只读属性"、**对权限位是 no-op**，复检永远失败。

**复现实测**（`docs/research/_artifacts/wintest/run-apply.mjs`）：
```
A. cold start  → apply() resolved，`.secret` mode = 0666
B. 2nd start   → REJECTED: persistent session secret must be owner-readable only
C. 3rd start   → REJECTED: 同上
SUMMARY: {"first":"mounted","second":"rejected","third":"rejected"}
```
即**该插件在 Windows 上只能成功启动一次**。若当初把 Linux 的 `$DSH_HOME`（含 `.secret`）一起拷过去，**第一次启动就命中**，表现就是"直接崩溃"。

**修复验证**（`docs/research/_artifacts/wintest/verify-patch.mjs`，不改原文件、内存替换后加载）：
```diff
     const repaired = statSync(file).mode & 0o777;
     if ((repaired & 0o077) !== 0) {
-      throw new Error("auth-webserver: persistent session secret must be owner-readable only");
+      if (process.platform !== "win32") {
+        throw new Error("auth-webserver: persistent session secret must be owner-readable only");
+      }
     }
```
结果：
```
A. cold / B. 2nd / C. 3rd / D. 4th start  → 全部 MOUNTED
SUMMARY: ["mounted","mounted","mounted","mounted"]
PASS: 修复后可在 Windows 反复启动
```

⚠️ **但补丁只是让它能跑**，还须知道：
- **权限位失效是系统性问题**：`sessions.json`、`passkeys.json`、`.secret` 在 Windows 上都是 `0666`，同机其他用户可读。**Windows 上应改用 ACL**（`icacls` 收紧到当前用户），否则等于把会话密钥与 passkey 记录公开。
- 插件仍有 `settings.register`、`core-session.js` 里 `location !== "/"` 等**跟 dsh 版本强耦合**的补丁点（107 在 0.2.0-rc.2 上共需 3 处补丁，见 [107 报告](./multi-backend-legacy-107.md)）。
- 更稳的路子：**按 `0.2.1-rc.2` 的 API 重写一个精简版**，而不是 fork 0.7.6。可复用的内核见 [插件可移植性报告](./multi-backend-plugin-portability.md)：`policy.js`（421 Host/Origin 双栅栏）、`login-page.js`、HMAC 会话 + CSRF、`core-session.js`（借用 `connection.authenticatedUrl()` 自己兑换 core cookie 且永不外泄）、限流、WS 升级反代——全部纯 `node:http/crypto`，**无 child_process、无原生模块、无 Unix socket、无 signal**。
- **必须做健康检查**：插件激活失败是**静默降级**（core 照常起、token 照常打印、`systemctl` 仍 `active`，但 LAN listener 根本没起）。唯一可靠判定是**检查监听 socket 是否真的在 LAN 地址上**，而不是查进程/服务状态。

---

## 六、Windows 特有坑

1. **防火墙弹窗**：首次监听非 loopback 地址时 Windows 会弹窗。若点了"取消"，**绑定仍成功但外部不可达** —— 表现为"服务起来了、手机连不上"。需在防火墙里显式放行该端口。
2. **虚拟网卡**：Hyper-V / WSL / VPN 会额外产生网卡。若插件式方案"枚举所有非 loopback 网卡逐个绑定"，会因某个虚拟网卡不可绑而整体失败（all-or-nothing）。应改 best-effort。
3. **权限位失效**：见 5.3。所有基于 `0600` 的"私有文件"假设在 Windows 上都不成立。
4. **休眠 / 唤醒、Wi-Fi 重连**：网卡地址变化会导致原绑定失效，需要重绑定逻辑。
5. **服务 Session 0**：注册为 Windows 服务后无桌面、无交互、无 GUI。若插件依赖桌面能力（原生目录选择、打开浏览器等）会失败。
6. **工作目录与 `DSH_HOME`**：服务账户下家目录不同，务必显式设 `DSH_HOME`。
7. **PowerShell 陷阱（踩过）**：`Invoke-WebRequest` 的 `-Headers @{Cookie=...}` 在本机实测**会被吞掉**导致误判成 401；做 HTTP 断言请用 `curl.exe`。另：执行策略禁止 `.ps1`，调 npm/npx 要用 `cmd /c`。

---

## 七、实测记录（环境与命令）

**平台**：Windows，dsh 桌面版内置 `0.2.1-rc.2`；node `v24.19.0`。
**反代实验脚本**：`docs/research/_artifacts/proxy-lab/proxy.mjs`（HTTP 反代 + WS 透传）、`proxy-tls.mjs`（TLS 终止反代）。

| # | 实验 | 结果 |
|---|---|---|
| 1 | `--profile web --no-open --port 0` | ✅ 打印 token URL |
| 2 | `--host 192.168.55.20 --port 0` | ✅ 成功 + 明文 HTTP 警告 |
| 3 | 反代 preserve 模式：无 token / 带 token / 带 cookie | 401 → **303** → **200** |
| 4 | cookie audience（Host=`myhost.example:34802`） | `authority: "myhost.example:34802"`，cookie 名由它派生 |
| 5 | `/api/remote.mux` 同源 Origin（带 cookie） | **404**（过栅栏） |
| 6 | `/api/remote.mux` 未声明 Host | **403** |
| 7 | `--trusted-host` 对照 | 声明→404；未声明→403；loopback→404 |
| 8 | TLS 直供兑换 | audience `https://127.0.0.1:34811`，**带 Secure** |
| 9 | 代理终止 TLS 兑换 | audience `myhost.example:34822`，**无 Secure** |
| 10 | 代理终止 TLS 的 WS | **101 Switching Protocols** ✅ |
| 11 | 明文 HTTP 同一后端 | audience `127.0.0.1:34801`，无 Secure |
| 12 | Windows 插件复现 | cold MOUNTED → 2nd/3rd **REJECTED** |
| 13 | 修复后 Windows 插件 | 连续 4 次 **全部 MOUNTED** ✅ |

**清理**：实验进程全部退出（34801/34802/34811/34821/34822/63071/63800/63999 均已关闭）；桌面宿主 `127.0.0.1:62293` 未受影响；未注册任何服务或计划任务；临时补丁文件已删除。

---

## 八、证据索引

| 结论 | 证据 |
|---|---|
| cookie audience 计算方式 | `dsh-client-connection/lib/index.js:307-316` |
| cookie 名由 authority 派生 | `dsh-client-connection/lib/index.js:335-337` |
| cookie 序列化（HttpOnly/SameSite/Secure 条件） | `dsh-client-connection/lib/index.js:347-350` |
| 兑换路由与 303 | `dsh-client-connection/lib/index.js:458-497` |
| `secure` 只来自监听器协议 | `dsh-client-connection/lib/index.js:745, 808-809` |
| Host/Origin 栅栏（trustedHosts 只管 Host） | `dsh-client-connection/lib/index.js:240-269` |
| 壳硬编码 `--host 127.0.0.1 --port 0` | `dsh-desktop-host/lib/index.js:234-240` |
| `0.2.1-rc.2` 接受任意具体 IP、拒通配 | `dsh-host-webserver/lib/index.js:251-266`；`dsh-web-app/lib/startup.js:48` |
| 0.2.0-rc.2 只认 loopback | `dsh-host-webserver/lib/index.js:142`；`dsh-web-app/lib/startup.js:40` |
| 插件 Windows 崩溃点 | auth-webserver `index.js:374-387` `readPrivateSecret()` |
| 无 logout、撤销方式 | `dsh-client-connection/README.zh.md:83` |

## 九、未决问题

1. **Windows 版 nginx/Caddy 本机未安装实测**：第 3.1/3.2 的配置基于源码语义与 lead 自写反代的等价实测（`Host` 透传 + Upgrade 透传已验证），但**未在真实 nginx/Caddy 上跑过**。上线前建议用真实 Caddy 复核一次。
2. **`--public-url` 与挂载目录的完整矩阵**未逐项实测（仅依据源码与文档）。
3. **Windows 服务化（NSSM/WinSW）**未实测，配置示例来自通用做法，需按实际环境验证 Session 0 行为。
4. **`_artifacts` 中的取证物**已在 `.gitignore` 排除；其中曾含真实凭据的文件已清除，但**它们仍存在于本机磁盘**，如需长期留存请自行加密。
