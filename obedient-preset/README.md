# 听话模式（obedient preset）

给 DSH Web 增加一个名为**听话模式**的 Agent 预设：它把内置的**标准模式**原样复制一份，只删掉
model-facing 的 `workflow` 工具。适合想保留常规编码工具、但不需要多 Agent 编排的场景。

子 Agent 也不会重新拿到 `workflow`：父 Agent 派生子 Agent 时把它们钉在同一个预设上，并禁止再向下
派生，见[子 Agent 的权限边界](#子-agent-的权限边界)。

## 与标准模式的差异

| 项目 | 标准模式 | 听话模式 |
| --- | --- | --- |
| 工具集 | 完整 | 除 `workflow` 外完整 |
| `subagent` / `subagent_fork` | 有 | 有 |
| workflow 运行时（`workflow-ptc`） | 有 | **无**，随工具一起移除 |
| 子 Agent 的预设 | 继承父 Agent | 显式钉在 `obedient`，且无 `agent_preset` 切换入口 |
| 派生深度 | 跟随 Host 设置（初始 1） | 固定 `maxDepth: 1`，子 Agent 不能再派生 |
| persona、计划模式、压缩、web、todo、goal、skill | 有 | 原样保留 |

没有 `workflow` 工具后，模型无法运行 JavaScript 编排脚本；`delegation` 分组里也不再需要为
`workflowEngine` 做隔离，所以该隔离项一并去掉。其余插件行、顺序和配置值与 `standard.patch.yml`
一致（对照 DSH `0.2.1-rc.2` 的 `@deepseek-ai/dsh-web-app/presets/standard.patch.yml`）。

预设声明：

- 包名：`@dsh-plugins/obedient-preset`
- Loader 行：`preset-obedient`
- 预设 id：`obedient`，显示名：`听话模式`
- 顺序：`order: 10`，排在四个内置预设之后

## 子 Agent 的权限边界

`workflow` 工具能让一个 Agent 用脚本一次拉起大量子 Agent，所以它不只对主 Agent 关闭，对子 Agent 也
必须关闭。本预设用三个配置把这件事钉死：

- `agentPreset: obedient`：`subagent` 派生的每个子 Agent 都独立挂载**听话模式**本身，而不是继承一个
  可能被改写过的组合；子 Agent 的工具表里没有 `workflow`。
- 不配置 `allowedAgentPresets`：模型没有 `agent_preset` 参数，无法把子 Agent 切到带 `workflow` 的
  模式（例如 `standard`）。
- `maxDepth: 1`：根 Agent 可以派生一次，子 Agent 再尝试派生会被运行时直接拒绝。`subagent_fork`
  子 Agent 继承父组合，因此同样没有 `workflow`；fork 也设了 `maxDepth: 1`。

`maxDepth` 是工具实例自己的上限，不随 Host 的 `subagent.maxDepth` 设置放宽。如果之后给本模式加回
`workflow`，这些边界会一起失效，需要同步复查本节。

## 安装

在 DSH 会话里把包目录作为 bundle 安装：

```text
plugin_manager action=install_bundle target=<本目录的绝对路径>
```

DSH 会把包写进当前 profile 的 `dsh.profile.bundles`，并插入 `preset-obedient` 声明。安装后：

- 新建会话时，模式选择器里出现**听话模式**；
- 已存在的会话保留启动时的预设，不会自动切换。

没有 Host 或 Client 源码，因此不需要重启 `dsh web`，也不需要刷新页面；如果模式列表没有立刻更新，
刷新一次页面即可。

## 限制

- 除移除 `workflow`、把子 Agent 钉在同一预设并限制派生深度外，不改变标准模式的系统提示、权限预设或
  沙箱策略。
- 预设声明由 `@deepseek-ai/dsh-agent-preset` 解释；上游若改动该包的 Config 结构，本包需要跟着更新。
- 通过 Web 编辑器修改模式后会写进 profile patch；本仓库里的 `cordis.patch.yml` 是安装时的默认值。

## 验证

在仓库根目录运行：

```powershell
node scripts/validate.mjs
```

`scripts/validate.mjs` 会检查本包的 `package.json`、`dsh.bundle.patch`、`files[]` 条目，以及
bundle patch 是否只插入一行 `@deepseek-ai/dsh-agent-preset` 声明。

安装后可用：

```text
plugin_manager action=list_plugins name=@deepseek-ai/dsh-agent-preset
```

确认 `preset-obedient` 行存在且已启用。

行为验证（手动，需要新建会话）：切到**听话模式**后做两件事：

1. 让主 Agent 派生子 Agent，要求子 Agent 调用 `workflow`：应报告工具不存在；主 Agent 自己的工具表
   里也没有 `workflow`。
2. 让子 Agent 再派生一个孙 Agent：应在启动时被 `maxDepth: 1` 拒绝，而不是真的创建。
