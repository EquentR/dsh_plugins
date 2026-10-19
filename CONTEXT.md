# DSH Plugins 上下文

## 项目定位

DSH Plugins 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的第三方插件集合。插件运行在 Harness 提供的动态插件/扩展边界内，用来补充可选能力，不承担 Harness 核心运行时、官方适配器或 profile 管理的职责。

## 领域词汇

- **DSH / Harness**：DeepSeek Harness 上游项目及其运行时。
- **插件**：可以被 DSH 动态定义或作为本地包加载的独立扩展单元。
- **Host 半**：运行在 Harness Host/Cordis 环境中的插件代码，负责服务访问、RPC 和设置持久化。
- **Client 半**：运行在 Harness 设置 UI 环境中的插件代码，负责页面、交互和 Host 调用。
- **provider route**：`settings.yaml` 中 provider 的配置键；只有已配置的 route 才是插件允许编辑的对象。
- **模型能力**：模型是否支持推理等级、图片输入等能力元数据，不等同于 provider 的认证或网络配置。
- **动态插件**：通过 `cordis_define` 注入 `code.host`/`code.client`，当前会话内生效的插件。
- **持久插件**：作为 profile 本地包安装并在 patch 配置中加载，重启后继续生效的插件。
- **Agent 预设**：`@deepseek-ai/dsh-agent-preset` 的一行声明，定义模式选择器里的一个模式及其插件列表；
  预设包通过 bundle patch 插入这行声明，本身不提供 Host/Client 代码。

## 当前上下文

仓库提供三类交付物，**每个交付物一个独立包**，装一个就是装一个：

| 目录 | 形态 | 状态 | 作用 |
| --- | --- | --- | --- |
| `git-graph/` | 持久包 | 可用 | Web 右侧栏的 Git 图谱：提交泳道图、未提交改动、文件差异 |
| `delete-session/` | 持久包 | 可用 | 带确认的会话永久删除，级联删除子会话记录 |
| `mentor/` | 持久包 | 可用（默认关闭） | 无工具的"纯对话"导师咨询，会话级标签页 + 全局设置 |
| `network-proxy/` | 持久包 | 可用 | Host 出站请求的 HTTP/SOCKS5 代理设置，HTTP 模式支持鉴权 |
| `obedient-preset/` | Agent 预设包 | 可用 | 标准模式去掉 `workflow` 工具，子 Agent 固定同一预设且不能再派生，作为「听话模式」加入模式选择器 |
| `model-capabilities/` | 动态函数体 | **已弃用** | 已被新版 DSH 内置的模型能力设置取代 |

### 三类交付物形态

- **持久包**（`git-graph`、`delete-session`、`mentor`、`network-proxy`）：真实 npm 形包，`index.js` / `lib/` 使用顶层
  `import`，通过 `dsh.bundle.patch` 插入 Loader 行。安装走 `plugin_manager install_bundle` 或
  `dsh plugin --profile web add`，装完通常需要重启 Host、刷新页面。
  **不能**用 `cordis_define` 动态加载。
- **Agent 预设包**（`obedient-preset`）：同样是真实 npm 形包，但 patch 只插入一行
  `@deepseek-ai/dsh-agent-preset` 声明（`id`、`name`、`description`、`order`、`plugins`），描述一个
  模式而不是插件。安装方式与持久包相同，装完出现在新会话的模式选择器里，不提供也不修改任何服务。
  预设可以对子 Agent 施加约束：`tool-subagent` 的 `agentPreset` 固定子 Agent 的预设，
  `maxDepth` 限制派生深度；两者都写在预设自己的插件列表里。
- **动态函数体**（`model-capabilities`）：`host.js` / `client.js` 是函数体，出现顶层 import 会直接
  失败；通过 `cordis_define` 的 `code.host` / `code.client` 注入当前会话。

### 跨包约定

- 包名统一在 `@dsh-plugins/` 作用域下，Client 模块 id **必须**等于包名，由 `scripts/validate.mjs` 校验；
- 每个包只在自己的 `cordis.patch.yml` 里插入**一行**：持久包是插件 Loader 行，预设包是
  `@deepseek-ai/dsh-agent-preset` 声明行；不提供聚合安装包；
- 预设包复制内置预设时按 `presets/<id>.patch.yml` 逐行对齐，只改 `id` / `name` / `description` /
  `order` 与刻意增删的插件行，并注明对照的 DSH 版本；
- 会消耗模型额度或改写数据的能力默认保守：`mentor` 用 `enabled: false`；
- `network-proxy` 只改写 Host 进程的 `fetch`/undici dispatcher，不尝试配置桌面端 Chromium；
  其 `enabled` 只控制是否安装代理，设置页在关闭时仍可用；
- 兼容性窗口声明为 DSH `>=0.2.1-rc.2 <0.2.2`，每包 README 记录其依赖的 Host 服务与 Client 槽位。

### 已弃用的 model-capabilities

它通过两个包私有 RPC 读取和保存模型信息：

- `model-caps:list` 读取已配置的 `llm-pi-ai` provider，并在配置存在时展示 `llm-deepseek` 官方适配器；
- `model-caps:save` 合并编辑后的模型显示名称、模型能力，并通过 `settings.mutate` 持久化；
- 未配置的 provider、未知 route 和未声明的模型不会被当作可编辑目标。

其能力（思考等级、多模态）现由 DSH 内置设置提供，因此该插件只作为历史实现保留，见
[`docs/adr/0002-deprecate-and-split-plugins.md`](./docs/adr/0002-deprecate-and-split-plugins.md)。

当新增插件或改变这些术语的含义时，先更新本文件和相关 ADR，再更新 README 或 issue 文案。
