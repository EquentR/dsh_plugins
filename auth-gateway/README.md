# @dsh-plugins/auth-gateway

为 dsh 增加一个**带账号鉴权的反向代理端口**：登录页、会话认证、修改密码、TOTP 两步验证，
以及按设备撤销会话。dsh 核心 Web 服务仍只监听 `loopback`，不做任何改动。

## 它解决什么问题

dsh 本身用「每进程一个随机启动令牌 → 换成一个签名 cookie」来认证浏览器，而**每个通过认证的连接
都映射到同一个 `owner`**。也就是说它没有账号、没有登出、没有按设备撤销、没有登录审计。
一旦你把端口暴露到局域网，任何拿到那条 URL 的人都是完全权限，且无法收回。

本插件在核心 Web 服务前面加一个独立端口：先要求账号密码，通过后再由插件自己持有核心 cookie 去
反代。于是形成双层会话：

```
远程浏览器 → 账号密码 → 网关会话（HMAC cookie）→ 网关持有的核心 cookie → dsh 核心
```

## 兼容性

| 环境 | 状态 |
|---|---|
| dsh `0.2.0-rc.2`（npm 版） | ✅ |
| dsh `0.2.1-rc.2`（桌面版） | ✅ |
| Windows | ✅ |
| Linux | ✅ |

**为什么同一份代码能同时支持两个版本**：本插件**不依赖 dsh 的 `settings` 服务**。上游把
`settings.register()` 移除了（`0.2.1` 只导出 `SettingsConflictError` / `SettingsForms` /
`redactSecrets`），而 `0.2.0` 与 `0.2.1` 的这个 API 形状并不一致。插件改为：

- **静态策略**放在自己的 Loader row `Config`（`cordis.patch.yml`），由 Loader 解析校验；
- **可变账号状态**（口令哈希、TOTP 密钥、会话、`authEpoch`）放在自己的文件里：
  `$DSH_HOME/plugins/dsh-auth-gateway/`。

这样就没有任何版本相关的配置分支。其余版本差异集中在 `lib/version.js`。

另外还处理了两个已知的上游变化：
- 核心令牌兑换的 `303` 重定向 `Location` 从 `/` 变成 `./`（`lib/core-session.js` 同时接受两者）；
- **Windows 上没有 POSIX 权限位**（见下）。

## Windows 上为什么能跑

之前同类插件（`@yiln-dsh/dsh-plugin-auth-webserver@0.7.6`）在 Windows 上会**只能启动一次**，
第二次启动直接抛错：

```js
// 原实现：Windows 上 mode 恒为 0o666，chmod 对权限位是 no-op，复检永远失败
if ((statSync(file).mode & 0o077) !== 0) throw new Error('... must be owner-readable only')
```

本插件的 `lib/safe-fs.js` **完全不使用权限位断言**：POSIX 上 `chmod 0700/0600`，
Windows 上尽力用 `icacls` 收紧到当前用户，**加固失败只记录警告、绝不抛错**。
`test/kernel-a.test.js` 里有一个跨进程重启用例专门锁住这个回归。

## 开关与设置页

**`enabled` 是真正的 UI 开关，不是重启配置。** 它在 Loader row 里声明为 `.volatile()`，
所以设置页保存后会立即启动或停止监听器，不需要重启 dsh：

```
设置 → 认证网关
  [x] 启用网关        ← 拨动即生效
      运行中 / 已停止 / 未设置密码
      监听于: 192.168.1.10:3080
```

设置页在**核心的 `/api` 通道**上与 Host 通信（`/api/auth-gateway`），而不是走网关自己的端口。
这一点是必须的：网关关闭时那个端口并不存在，如果设置页去敲它，就永远无法把开关重新打开
——这正是早期版本显示「认证网关当前不可用」的原因。

关闭状态下设置页仍然完整可用：能读取状态、改密码、配置 TOTP、修改监听参数。

设置页使用 Harness 的主题颜色，内容最大宽度为 820px，分为监听设置、账号密码、两步验证和诊断四张卡片。
开关可通过键盘操作，并提供焦点提示和辅助技术可读的开关状态；开关保存成功后才显示新的位置。
开关只提交启用状态，不会顺带保存或清空其他字段的草稿。修改密码或 TOTP 也会保留监听草稿；
成功保存监听设置，或主动点击「重新读取设置」后，表单才会采用 Host 返回的设置。

保存前会检查端口范围、会话时长整数范围、上游地址和登录页标题；新密码至少 8 个字符，
启用 TOTP 前需要生成密钥并输入 6 位数字验证码。上游地址与现有 Host 限制一致，仅支持
`127.0.0.1` 或 `::1`（也接受 `[::1]` 写法），上游端口 `0` 仍表示自动探测核心端口。
输入无效时仍可点击操作按钮，页面会在相应卡片内说明原因。

每张卡片各自保留一条可替换的操作反馈：错误以警告播报，成功以状态播报；重新编辑该卡片的字段
会清除旧反馈。普通错误不再附带原始 RPC JSON。状态读取失败时仍可重试和执行「诊断 Host 接线」，
诊断详情以可展开的 JSON 显示。诊断是只读操作；重新诊断会清除上一份结果。
这些改动只涉及设置页，不改变网关登录、鉴权或会话策略。

> **没有设置密码时不会启动。** 日志会给出警告，设置页显示「未设置密码，网关不会启动」。
> 这是 fail-closed：一个没人能登录的网关不该对外监听。

## 安装

在仓库根目录执行（与仓库其他插件一致）：

```powershell
node scripts/validate.mjs      # 先校验
```

然后把 `auth-gateway` 目录作为 bundle 安装到目标 profile。安装后它是**禁用状态**，
需要显式启用——安装插件不应该悄悄多开一个网络监听。

## 配置

配置在本插件的 Loader row 里（Settings → 认证网关，或直接编辑 `cordis.patch.yml`）。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `false` | 总开关。关闭时核心服务完全不受影响。 |
| `port` | `3080` | 网关在每个非 loopback 地址上监听的端口。 |
| `targetHost` | `127.0.0.1` | 上游地址。运行时强制 loopback，不要指向网络地址。 |
| `targetPort` | `0` | 上游端口。`0` 表示「读取当前 `webServer` 端口」——桌面版以 `--port 0` 启动核心，必须用这个。 |
| `addresses` | `[]` | 显式绑定地址。空表示枚举所有非 loopback IPv4 网卡。 |
| `username` | `admin` | 首次运行时的账号名。 |
| `password` | `''` | 首次运行的口令，用于播种凭据文件。**之后以文件为准**。 |
| `realm` | `DeepSeek Harness Authentication` | 登录页显示的域名。 |
| `allowedHosts` | `[]` | 额外接受的 Host authority（裸 `host` 或 `host:port`）。 |
| `allowedOrigins` | `[]` | 额外接受的浏览器 Origin。 |
| `remoteDirectoryPicker` | `true` | 给经网关访问的浏览器注入页面内目录选择器（见下文）。 |
| `sessionMaxAgeSeconds` | `86400` | 会话绝对有效期。 |
| `sessionIdleTimeoutSeconds` | `43200` | 空闲超时。 |
| `upstreamTimeoutMs` | `30000` | 上游连接与握手超时。 |
| `requestTimeoutMs` | `120000` | 网关监听器请求超时。 |

也可以先用环境变量 `AUTH_USER` / `AUTH_PASS` 播种，优先级低于 Config。

> **首次使用必须设置口令**。没有口令时插件会启动但**拒绝一切登录**（fail-closed），
> 并在日志里给出警告——这是有意的，避免"装上了但其实是敞开的"。

## 反向代理场景

如果你在网关前面再套一层 nginx/Caddy：

1. **必须保留客户端发来的 `Host`**（`proxy_set_header Host $http_host`）。不要改写成上游地址。
2. 把公网 authority 加进 `allowedHosts`，例如 `allowedHosts: ['dsh.example.com']`。

原因：网关按**请求的 Host** 做栅栏判定并绑定会话；改写 Host 会导致后续请求对不上。

## 远程浏览器的目录选择（页面内选择器）

### 问题

dsh 的目录选择器由 `dsh-host-directory-picker-auto` 在**启动时一次性**判定：桌面平台
（Windows/macOS）+ 仅回环绑定 + 没有远程 authority 信任 → `native`。Windows 上 native 后端会在
**宿主机器**上 spawn 子进程弹 `IFileOpenDialog`。

桌面窗口本身没问题：它的 preload 提供 `__DSH_DIRECTORY_PICKER__`，走 Electron 对话框。但经本网关
访问的浏览器没有 preload，同一个 native 表面会退回 Host RPC，于是点「添加工作区」时对话框弹在
**宿主屏幕上**——操作者在自己浏览器里看不到任何反应。

参考部署（npm 版 `.107`）是在 profile 里直接 pin 了 browse 选择器；桌面 profile 不能照抄，因为桌面
窗口与远程浏览器共用同一张客户端模块表，pin browse 会连桌面窗口的原生对话框一起换掉。

### 解决

网关是远程浏览器的载体，所以由网关补齐这个载体事实：已认证的文档会在 `<head>` 起始处注入一段
脚本，定义 `__DSH_DIRECTORY_PICKER__ = { pick() }`（**仅在页面尚无该全局时**，不覆盖桌面 preload）。
`pick()` 打开页面内的目录浏览器，通过网关自己的两个受权路由列目录/建目录：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/_dsh/auth-gateway/fs/list?path=` | 列一级子目录（需网关会话） |
| POST | `/_dsh/auth-gateway/fs/mkdir` | `{path, name}` 建目录（需网关会话 + CSRF） |

于是：远程浏览器 = 页面内选择器（与 npm 版观感一致）；桌面窗口 = 仍然走 Electron 原生对话框。
不需要改上游、不需要改 profile。`remoteDirectoryPicker: false` 可关闭注入，回到宿主原生行为。

### 安全与限制

- 这两个路由的权限等于反代页面本身：网关把宿主 core cookie 交给该页面，Workspace UI 本来就能
  读写宿主文件。`mkdir` 额外要求会话 CSRF；Host/Origin 栅栏与认证顺序不变。
- 路径必须是完全限定路径；文件夹名必须是单个路径段；单层最多列 1000 条。
- 该注入覆盖 `ui-workspace` 的目录流程 slot（「添加工作区」等处）。若上游新增了**绕过 slot、
  直接调用** Host `directoryPicker.pick` 的入口，那些入口仍会弹宿主原生对话框。


## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 未认证 → 登录页；已认证 → 反代核心 UI |
| POST | `/api/auth.login` | `{username, password, totp?}` |
| POST | `/api/auth.logout` | 撤销当前会话（需 CSRF） |
| POST | `/api/auth.change-password` | `{currentPassword, newPassword, totp?, csrf}` |
| POST | `/api/auth.totp` | `{action: 'begin'\|'enable'\|'disable', ...}` |
| GET | `/_dsh/auth-gateway/state` | 设置页读取状态 |
| GET | `/_dsh/auth-gateway/fs/list?path=` | 页面内目录选择器：列子目录（需会话） |
| POST | `/_dsh/auth-gateway/fs/mkdir` | 页面内目录选择器：建目录（需会话 + CSRF） |
| 其余 | `/*` | 已认证则反代；否则 401 或登录页 |

**栅栏顺序不可颠倒**：① Host（不匹配 → **421**）→ ② Origin（不匹配 → **403**）→ ③ 认证
（未认证 → 401 / 登录页）→ ④ 反代。

## 安全设计

- 口令只存 **scrypt + 16 字节随机盐**，比对用常量时间比较。
- 会话 cookie `HttpOnly` + `SameSite=Strict`（走 TLS 时额外加 `Secure`）；写操作另需 CSRF。
- `authEpoch`：改密码会递增，**所有既有会话立即失效**（包括其他设备）。
- 登录限流：滑动窗口内超过阈值返 429。
- 上游强制 **loopback**，核心进程令牌不会发到网络目的地。
- 核心 cookie **只留在内存**；浏览器带来的 `dsh-auth-*` 和网关自己的 cookie 都会在转发前剥掉，
  上游返回的核心 `Set-Cookie` 也不会透传给浏览器。
- 宿主不匹配一律 **fail-closed**，不降级放行。

## 已知限制

- 不提供 WebAuthn/passkey、PWA 安装、移动端抽屉布局（相对 `0.7.6` 的有意缩减）。
- 单账号模型：一套账号口令，不支持多用户与按用户权限。
- 状态文件加密依赖操作系统：Windows 上没有 POSIX 权限位，靠 `icacls` 尽力收紧；
  若需更强隔离，请把 `$DSH_HOME` 放在受控目录。
- 明文 HTTP 部署时网关会话 cookie 不带 `Secure`；对外暴露请务必终止 TLS。

## 开发

```powershell
node --test auth-gateway/test/*.test.js    # 单元 + 端到端，共 96 项
node scripts/validate.mjs                  # 仓库校验
```

`test/gateway.e2e.test.js` 会起一个假的 dsh 核心，然后跑真实网关，覆盖：栅栏 421/403、登录页、
登录、反代、cookie 隔离、WebSocket 101、TOTP 登记与登录、改密码撤销、限流。
模块间接口约定见 [CONTRACT.md](./CONTRACT.md)。
