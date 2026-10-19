# 听话模式（obedient preset）

给 DSH Web 增加一个名为**听话模式**的 Agent 预设：它把内置的**标准模式**原样复制一份，只删掉
model-facing 的 `workflow` 工具。适合想保留常规编码工具、但不需要多 Agent 编排的场景。

## 与标准模式的差异

| 项目 | 标准模式 | 听话模式 |
| --- | --- | --- |
| 工具集 | 完整 | 除 `workflow` 外完整 |
| `subagent` / `subagent_fork` | 有 | 有 |
| workflow 运行时（`workflow-ptc`） | 有 | **无**，随工具一起移除 |
| persona、计划模式、压缩、web、todo、goal、skill | 有 | 原样保留 |

没有 `workflow` 工具后，模型无法运行 JavaScript 编排脚本；`delegation` 分组里也不再需要为
`workflowEngine` 做隔离，所以该隔离项一并去掉。其余插件行、顺序和配置值与 `standard.patch.yml`
一致（对照 DSH `0.2.1-rc.2` 的 `@deepseek-ai/dsh-web-app/presets/standard.patch.yml`）。

预设声明：

- 包名：`@dsh-plugins/obedient-preset`
- Loader 行：`preset-obedient`
- 预设 id：`obedient`，显示名：`听话模式`
- 顺序：`order: 10`，排在四个内置预设之后

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

- 只移除 `workflow` 工具，不改变标准模式的系统提示、权限预设或沙箱策略。
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
