# DSH Plugins

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供的第三方插件集合。

这里持续更新可独立安装、可组合使用的 DSH 插件，目标是补充 Harness 的工作流和开发体验。每个插件尽量保持边界清晰，优先以源码和文档交付，避免修改 Harness 核心代码。

**每个插件是一个独立包**：安装一个只装一个，某个插件出问题可以单独移除，不需要卸载整套。

## 插件

| 插件 | 状态 | 形态 | 作用 |
| --- | --- | --- | --- |
| [`git-graph`](./git-graph) | 可用 | 持久包 | 右侧栏 Git 标签页：提交泳道图、未提交改动、文件差异 |
| [`delete-session`](./delete-session) | 可用 | 持久包 | 带确认的会话永久删除，级联删除子会话记录 |
| [`mentor`](./mentor) | 可用（默认关闭） | 持久包 | 无工具的「纯对话」导师咨询，会话级标签页 + 全局设置 |
| [`network-proxy`](./network-proxy) | 可用 | 持久包 | Host 出站请求的 HTTP/SOCKS5 代理设置页，HTTP 模式支持鉴权 |
| [`auth-gateway`](./auth-gateway) | 可用（默认关闭） | 持久包 | 带账号鉴权的反向代理端口：登录页、会话认证、改密码、TOTP、按设备撤销、远程页面内目录选择器；兼容 dsh 0.2.0/0.2.1 与 Windows/Linux |
| [`obedient-preset`](./obedient-preset) | 可用 | Agent 预设包 | 内置「标准模式」去掉 `workflow` 工具，作为「听话模式」加入模式选择器 |
| [`model-capabilities`](./model-capabilities) | **已弃用** | 动态函数体 | 原为第三方模型补推理等级与图片能力设置；新版 DSH 已内置，不再维护 |

### `git-graph`

在 Web 右侧栏增加 Git 页签，展示当前目录所在仓库的提交历史、未提交改动和文件差异。差异弹窗用的
monaco 与 markdown-it 由本包自己提供，不依赖 CDN。详见 [`git-graph/README.md`](./git-graph/README.md)。

### `delete-session`

给会话标题、会话行菜单和批量选择模式加上**真正删除**的入口：先确认，再 flush/dispose 活动会话，
最后删除受保护的每会话记录目录，并递归删除该会话派生出的子会话记录。详见
[`delete-session/README.md`](./delete-session/README.md)。

### `mentor`

主 Agent 可调用的 `mentor` 工具：召唤一个没有工具、不读工作区、只按固定系统提示作答的独立 Agent，
拿一次第二意见。默认关闭，启用后才工作。详见 [`mentor/README.md`](./mentor/README.md)。

### `network-proxy`

在 Settings 增加「网络代理」页，为 Host 的出站 HTTP 请求安装 HTTP 或 SOCKS5 代理；HTTP 模式支持
用户名/密码鉴权，SOCKS5 不提供鉴权。本机地址始终直连，并支持自定义绕过列表。它只作用于 Host
进程的 `fetch`/undici dispatcher，**不配置桌面端 Chromium 自身的流量**。详见
[`network-proxy/README.md`](./network-proxy/README.md)。

### `auth-gateway`

在 dsh 前面加一个**带账号鉴权的反向代理端口**：登录页、会话认证、改密码、TOTP 两步验证，以及
按设备撤销会话。dsh 核心 Web 服务仍只监听 loopback，不做改动。它补的是 dsh 的真实缺口——当前
所有通过认证的连接都映射到同一个 `owner`，没有账号、没有登出、没有撤销、没有审计。

同一份代码同时支持 dsh `0.2.0-rc.2`（npm）与 `0.2.1-rc.2`（桌面版），以及 Windows/Linux：
关键是它**不依赖 dsh 的 `settings` 服务**（`register()` 已被上游移除且两版形状不一致），
静态策略走 Loader row `Config`，可变账号状态走自管文件。Windows 上也不使用 POSIX 权限位断言
（同类旧插件因此在 Windows 上"只能启动一次"）。详见 [`auth-gateway/README.md`](./auth-gateway/README.md)。

### `obedient-preset`

给 Web 增加一个名为**听话模式**的 Agent 预设：把内置的**标准模式**原样复制，只删掉 model-facing
的 `workflow` 工具（连同它专用的 `workflow-ptc` 运行时）。`subagent`、`subagent_fork`、计划模式、
压缩和其余常规工具保持不变；子 Agent 同样被钉在这个没有 `workflow` 的预设上，且不能再向下派生。
详见 [`obedient-preset/README.md`](./obedient-preset/README.md)。

### `model-capabilities`（已弃用）

新版本 DSH 已内置模型能力设置（思考等级与多模态），本插件所补的缺口不复存在，因此标记为弃用：
保留源码与文档作为历史实现与迁移参考，不再适配新版本，也不建议新装。弃用理由见
[`docs/adr/0002-deprecate-and-split-plugins.md`](./docs/adr/0002-deprecate-and-split-plugins.md)。

## 安装方式

三类交付物的安装路径不同，不能混用：

**持久包**（`git-graph`、`delete-session`、`mentor`、`network-proxy`）是真实 npm 形包，`index.js` / `lib/` 使用顶层
`import`，因此**不能**作为 `cordis_define` 动态插件加载。安装到当前 profile：

```text
plugin_manager action=install_bundle target=<插件目录的绝对路径>
```

或使用 CLI：

```powershell
dsh plugin --profile web add <插件目录的绝对路径>
```

装完通常需要重启 `dsh web` 并刷新页面；`mentor` 还需要把 `dsh-mentor` 行的 `enabled` 改为 `true`。

`git-graph` 额外需要先在它自己的目录里装好前端资源（profile 以符号链接引用包目录，依赖不会装到
profile 里）：

```powershell
cd git-graph
pnpm install --config.auto-install-peers=false
```

`--config.auto-install-peers=false` 必须显式传：否则 pnpm 会把握在 `peerDependencies` 里的 DSH 包
当成待安装依赖，在插件目录里再拉一份约 580 MB 的 DSH。

`network-proxy` 也需要在它自己的目录执行同样的 `pnpm install --config.auto-install-peers=false`：
它自带 `undici@8.11.2`，而 profile 的 linked 安装不会把插件的依赖装进 profile。

**Agent 预设包**（`obedient-preset`）同样是真实 npm 形包，但 patch 里插入的是一行
`@deepseek-ai/dsh-agent-preset` 声明，而不是插件本体。装法相同：

```text
plugin_manager action=install_bundle target=<预设包目录的绝对路径>
```

装完不需要重启：包会被加进 profile 的 `dsh.profile.bundles`，新会话的模式选择器里出现新预设；
已存在的会话保留启动时的预设。

**动态函数体**（`model-capabilities`，已弃用）走 `cordis_define`：`code.host` 填 `host.js`，
`code.client` 填 `client.js`，再 `cordis_run`。

插件目录中的 README 是安装行为的事实来源；DSH 的命令和 profile 布局可能随上游版本变化，使用前请以
当前 Harness 文档为准。

## 兼容性

各持久包按 DSH `0.2.1-rc.2` 核对扩展点，并在自己的 `peerDependencies` 中声明
`@deepseek-ai/dsh >=0.2.1-rc.2 <0.2.2`。`obedient-preset` 复制同一版本的
`presets/standard.patch.yml`，因此同样以 `0.2.1-rc.2` 为基准。升级 DSH 到其他版本前，请对照该包
README 中列出的 Host 服务与 Client 槽位重新核对，而不是假定继续可用。

移植来源：[yiiilin/dsh-plugins](https://github.com/yiiilin/dsh-plugins)（MIT）。本仓库把其中的
`git-graph`、`delete-session`、`mentor` 三个模块拆成独立包，包名、客户端模块 id、页签标识与样式
归属都改到 `@dsh-plugins/` 命名空间下，业务逻辑未改写。

## 仓库文档

- [`CONTEXT.md`](./CONTEXT.md)：领域术语、插件形态和当前上下文；
- [`docs/adr/0001-plugin-boundary.md`](./docs/adr/0001-plugin-boundary.md)：插件集合的边界决策；
- [`docs/adr/0002-deprecate-and-split-plugins.md`](./docs/adr/0002-deprecate-and-split-plugins.md)：弃用 `model-capabilities`、改为独立插件包的决策；
- [`docs/agents/issue-tracker.md`](./docs/agents/issue-tracker.md)：GitHub Issues 工作约定；
- [`docs/agents/domain.md`](./docs/agents/domain.md)：工程 skill 读取领域文档的规则；
- [`docs/agents/triage-labels.md`](./docs/agents/triage-labels.md)：issue triage 标签映射；
- [`AGENTS.md`](./AGENTS.md)：编码代理在本仓库中的工作规则。

## 开发和验证

本仓库没有统一构建系统。持久包在被安装时会由 DSH 的 Client 构建流程处理，仓库内只需要保证源码和
清单自洽。运行仓库校验：

```powershell
node scripts/validate.mjs
```

它会检查：每个包的 `package.json` 能解析、声明了 `dsh.bundle.patch`、`files[]` 条目都存在、
bundle patch 只插入一行且行名等于包名、Client 模块 id 等于包名、每个 JS 文件能按 ES 模块解析、
Locale 带 `meta.title` / `meta.description`；对 Agent 预设包则检查那一行是
`@deepseek-ai/dsh-agent-preset` 声明，且 `config` 里有合法的 `id`、`name` 和可选的整数 `order`；
对动态函数体形态则检查它可以作为函数体编译且没有顶层 `import`/`export`。脚本不会导入或执行任何
插件代码。

提交前还应检查：

- README 与插件实际能力一致；
- Host 和 Client 的 RPC 名称、字段结构同步；
- 新包只插入一行 Loader，不引入聚合安装；
- 不提交本地会话、凭据、构建产物或 Harness 运行数据。

## 贡献

欢迎通过 GitHub Issue 提交插件想法、兼容性问题和改进建议。新插件建议：

- 放在独立目录，并包含自己的 README、`package.json`、`cordis.patch.yml`（持久包另需 Locale 资源和图标）；
- 说明适用的 DSH/Harness 版本、安装方式、权限边界和已知限制；
- 提供可复现的验证步骤；
- 不依赖未记录的本机配置或秘密。

Issue 使用 `needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`
五个标准标签进行跟踪，详见 [`docs/agents/triage-labels.md`](./docs/agents/triage-labels.md)。

## 许可证

[MIT](./LICENSE)
