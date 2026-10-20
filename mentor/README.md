# Mentor — 导师模式插件

给主 Agent 一个**纯对话的第二意见**工具：需要时召唤一个没有工具、看不到工作区、只按固定系统提示作答的独立 Agent，把它的判断当作参考。

本插件是独立包：安装它只会插入 `dsh-mentor` 一行 Loader 配置，不会连带安装 `dsh_plugins` 仓库中的其他插件。

## 移植来源

移植自 [yiiilin/dsh-plugins](https://github.com/yiiilin/dsh-plugins) 的 `mentor` 模块（MIT 许可），按 `dsh_plugins` 的独立包边界重新打包。设置命名空间（`dsh-mentor`）与持久化格式保持原样。

## 为什么是"纯对话"

导师 Agent 拿到的是一个被刻意收紧的环境：

- 没有工具：Agent scope 拒绝继承的工具，并在执行入口做单调拒绝（即使模型伪造工具调用也不会执行）；
- 不读工作区：不传 `cwd`，不复制父会话 transcript；
- 完整覆盖系统提示，并请求禁用 runtime context；
- 在 DSH `llm/stream` 边界再校验一次最终请求的路由、消息与工具集，任何工具 schema 或非导师消息都在发往 provider 前被拒绝。

也就是说：**导师只说话，不干活**。它的建议仍需主 Agent 自己验证和执行。

> 一个已知例外：DSH 0.2.1 起 `suppressRuntimeContext()` 不再移除标为 `required: true` 的动态 context（例如 `working-directory:current`），所以子会话会多带一条 DSH 自己的 `runtime-context` 快照并随请求发出。校验只放行子会话已记录且 id 匹配的这类快照，其他来源一律拒绝。

## 使用方式

插件默认 **disabled**。启用后主 Agent 在需要第二意见时调用 `mentor` 工具（参数只需要 `message`，可选 `evidence`）。

- 每个主会话自动使用一条导师线程；成功且已送达的上下文可继续；
- 同一主会话的咨询按提交顺序**串行**执行，超过 `globalConcurrency` 的请求排队等待，等待可取消；
- 旧线程有失败 / 未决 / 未送达记录时，新调用自动封存并新建干净线程，不需要手工 reset；
- `/mentor status` 查看路由、当前线程、usage 与待交付计数；`/mentor reset` 封存当前线程（同样排队）。

### 与 Agent 预设的关系

`mentor` 是 **Host 级插件**，工具按"主 Agent"逐个注册，**不由任何 Agent 预设声明**。所以
标准模式、真 · 标准模式（true-standard）、cordis 等预设创建的主 Agent 都会拿到同一个
`mentor` 工具；子 Agent 一律看不到。反过来，也不需要（也不应该）把 `@dsh-plugins/mentor`
写进某个预设的 `plugins` 列表——那样会和 Host 行重复挂载、并破坏 `inject` 的服务边界。

注册时机覆盖三种情形：插件加载时枚举现存 Agent、`agent/created` 时为新建 Agent 注册、
以及每条输入被认领（`agent/inbox/claimed`）时做一次幂等自检。自检读的是该 Agent 自己视角下的
工具表，因此即使注册被后续的插件重载或工具层重建丢掉，也会在下一轮输入前补回来，不需要手动
重开设置页或重启。

## 界面

- **会话标签**：在自带"对话 / 轨迹"旁增加会话级 `Mentor` 标签（顺序 30），显示最近 20 条已完成咨询、问题、可折叠证据、回复与交付状态；只读；
- **全局设置页**：`Settings > Mentor`（`settings.section` 顺序 25），读写本插件的 `dsh-mentor` 行：启用开关、模型（从当前 ModelCatalog 选，或留空用目录默认值）、思考强度、单次超时、全局并发。存在 `configForms` 时也会以 `settings.plugins.tab` 出现在"内置插件"分区。

设置是**全局的**：任何会话共享同一份值。

设置页按启用状态、模型与推理、执行设置分组，使用 Harness 主题色、统一卡片和表单样式，启用开关支持键盘操作和可见焦点。超时与并发字段在离开字段或保存时显示范围错误；只读部署显示原因。保存成功或失败会在保存按钮附近替换显示，编辑后清除旧反馈。配置冲突时重新读取最新设置，并保留冲突说明供检查；首次读取失败可重试。已保存模型不在当前目录时会明确提示重新选择。

本轮界面调整经过 JavaScript 语法和仓库校验；实际深浅色、窄屏显示及保存操作仍需在安装后的 Web UI 中检查。

## 架构

| 文件 | 作用 |
| --- | --- |
| `index.js` | 声明 `inject` 与 `Config`（`enabled`、`provider`、`model`、`reasoningEffort`、`requestTimeoutMs`、`globalConcurrency`、`maxInputBytes`），把 `defineTool` / `freezeMessage` / `SESSION_FORMAT_VERSION` 注入实现层。**故意没有 default export**，否则 Loader 会读不到 `Config` 而失去可编辑设置。 |
| `lib/mentor.js` | 主体：线程管理、串行队列、Agent scope 收紧、`llm/stream` 边界校验、journal 读写、设置读写。 |
| `lib/journal.js` / `lib/protocol.js` | 持久化 journal 与规范结果编码，用于幂等与恢复。 |
| `client.js` | Client 半：会话标签 + 设置页。 |
| `cordis.patch.yml` | 只声明 `dsh-mentor` 一行，`enabled: false`。 |

`inject` 依赖 `tools`、`agents`、`agentLoop`、`commands`、`connection`、`sessions`、`sessionPersistence`、
`sessionController`、`settings`、`systemPrompt`。其中 `agentLoop` 不直接被调用，保留它是为了让
**具体 Agent 工厂在导师首次咨询之前就已注册**，避免激活时序上的竞态。`configEditor` 刻意**不**注入：
它缺失时会退回到 `dsh-mentor` 命名空间，设置页仍可只读展示。

## 安装与启用

持久包，不是 `cordis_define` 动态插件：`index.js` 与 `lib/` 都使用顶层 `import`（`node:crypto`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session`），动态插件只接受函数体。

```text
plugin_manager action=install_bundle target=<本目录的绝对路径>
```

装好后在 `dsh-mentor` 行把 `enabled` 改为 `true`（或直接用设置页开启），然后重启 DSH Web daemon。

`provider` / `model` 留空表示使用 DSH 全局模型目录默认值；填写则作为全局固定路由：

```yaml
- id: dsh-mentor
  name: '@dsh-plugins/mentor'
  config:
    enabled: true
    provider: ''          # 留空 => ModelCatalog 默认
    model: ''             # 留空 => ModelCatalog 默认
    reasoningEffort: ''   # 留空 => 模型/Profile 默认
    maxInputBytes: 98304
    requestTimeoutMs: 300000
    globalConcurrency: 2
```

## 兼容性

- 按 DSH `0.2.1-rc.2` 核对：`tools.register` / `tools.guard` / `tools.restrict`、`agents.createAgent/resume`、`agentLoop`、`systemPrompt.suppressRuntimeContext()`、`llm/stream` 事件、`settings` / `configEditor`、`commands.register`；
- `peerDependencies` 声明 `@deepseek-ai/dsh`、`dsh-llm`、`dsh-session`、`dsh-tools` 为 `>=0.2.1-rc.2 <0.2.2`；
- 设置页写入 profile patch 需要 `dsh-settings` 与 `dsh-config-editor`；缺任一时设置页显示只读，可直接改 YAML。

## 限制

- **没有 token/成本上限**：插件不再限制生成次数、输入、上下文、输出或回复字节；这些量只被测量并写入 journal。`requestTimeoutMs` 只限制单次实际咨询（不含排队）；
- 度量用 JSON/UTF-8 序列化字节数，不是 provider 的精确 tokenizer 计数；provider 未报告 usage 时保留 `null` 与 `unknown`，不会记成 0；
- `mentor` 工具只注册在 root Agent scope，子 Agent 看不到；
- 导师会话与 journal 都是 **DSH 自己的持久化会话存储**里的普通记录（带 `origin: subagent`），不是私密存储；Web 会话列表会隐藏冷 journal，但受信代码仍能发现它，DSH 也没有通用的保留期 API；
- 这不是同进程插件沙箱：其他受信插件仍可能改动组合；提交给导师的文字仍可能包含语义层面的 prompt injection，证据按 JSON 数据编码（不会被反引号或 Markdown fence 逃逸），但建议仍由主 Agent 自行验证；
- `/mentor` 命令依赖 `dsh-commands` 与交互式 Web adapter，headless / ACP / JSON-RPC 不在支持范围。

## 验证

```powershell
cd <仓库根目录>
node scripts/validate.mjs
```

### 已实测（2026-10-18，DSH 0.2.1-rc.2，desktop profile）

安装 `application: applied` 后，在**保持默认关闭**的状态下实测：

| 检查 | 结果 |
| --- | --- |
| Host Config | `patchId: dsh-mentor`，`status: schema`（`Config` 被 Loader 正确读到） |
| Client 槽位 `settings.section` | 出现 occupant `mentor`，`order: 25`，`active: true` |

`enabled: false` 时不注册 `mentor` 工具、不挂 Agent scope guard、不装工具限制；`llm/stream` 监听器在没有
导师线程时直接放行。因此默认关闭状态对现有会话没有行为影响。

尚未验证：真正启用后的咨询链路（需要模型额度），以及会话里的 `Mentor` 标签页。启用前请先在一份
可以浪费额度的会话里试。

### 已实测：开启后各预设都能拿到工具（2026-10-18，desktop profile，DSH 0.2.1-rc.2）

`enabled: true`、路由 `istart/gpt-6.1-sol`、`reasoningEffort: max` 时，用一次只读探针逐 Agent 读取
`tools.get('mentor', agent)` 与 `tools.schemas(agent)`：

| 场景 | 结果 |
| --- | --- |
| 现存 6 个主 Agent（3 个 standard、3 个 true-standard） | 全部 `mentor: true` |
| 新建 Agent（`meta.agentPreset: 'true-standard'`） | `mentor` 出现在它的工具表里 |
| `set_plugin` 关闭 → 开启（等价于设置页保存后的重载） | 旧注册全部释放，6 个主 Agent 重新注册成功 |
| `scripts/validate.mjs` | `validation passed` |

排查过程中确认了两件事：预设不是原因（`standard` 会话在重启后同样会丢工具），以及"工具消失"来自
插件实例重载后没有重新登记——这正是上面 `agent/inbox/claimed` 自检要兜住的情形。

### 安装后的人工检查

1. `Settings > Mentor` 能打开并保存 `enabled`、`provider`、`model`，重启后值仍在；
2. 在主会话里要求"调用 mentor 问问这件事"，得到一条只含文字的回复，会话出现 `Mentor` 标签；
3. 让导师尝试执行命令（例如提示它运行 shell），确认它给出的是拒绝或纯文本，且**没有**工具真的被执行；
4. `/mentor status` 报告的路由与 provider usage 合理。
