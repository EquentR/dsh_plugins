# DSH Plugins

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供的第三方插件集合。

这里会持续收集可独立安装、可组合使用的 DSH 插件，目标是补充 Harness 的模型、工作流和开发体验。每个插件尽量保持边界清晰，优先以源码和文档交付，避免修改 Harness 核心代码。

## 当前插件

| 插件 | 状态 | 作用 |
| --- | --- | --- |
| [`model-capabilities`](./model-capabilities) | 可试用 | 为已配置的第三方模型补充推理等级和图片输入能力配置 |

## `model-capabilities`

这个插件在 DSH 设置面板中增加“模型能力”页面：

- 为已配置的 `llm-pi-ai` provider 展示模型列表；
- 按模型启用/关闭推理能力，并选择 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` 等等级；
- 按模型配置图片输入支持；
- 配置 provider 默认推理等级；
- 通过 Host RPC 读取和持久化 `settings.yaml`，只修改已配置的 provider；
- 识别 `llm-deepseek` 官方适配器，但保留其“提供商级推理设置、暂不支持图片输入”的限制。

详细行为、安装方式和限制见 [`model-capabilities/README.md`](./model-capabilities/README.md)。

## 安装方式

目前插件支持两种使用方式：

1. **动态试用**：将插件文件内容传给 DSH 的 `cordis_define`，分别填入 `code.host` 和 `code.client`，再通过 `cordis_run` 激活。
2. **持久安装**：把插件目录放入对应 profile 的本地包位置，或使用 `dsh plugin --profile web add <path>` 安装，再在 `cordis.patch.yml` 中加载并重启 DSH。

插件目录中的 README 是安装行为的事实来源；DSH 的命令和 profile 布局可能随上游版本变化，使用前请以当前 Harness 文档为准。

## 仓库文档

- [`CONTEXT.md`](./CONTEXT.md)：领域术语、插件边界和当前上下文；
- [`docs/agents/issue-tracker.md`](./docs/agents/issue-tracker.md)：GitHub Issues 工作约定；
- [`docs/agents/domain.md`](./docs/agents/domain.md)：工程 skill 读取领域文档的规则；
- [`docs/agents/triage-labels.md`](./docs/agents/triage-labels.md)：issue triage 标签映射；
- [`docs/adr/0001-plugin-boundary.md`](./docs/adr/0001-plugin-boundary.md)：插件集合的边界决策；
- [`AGENTS.md`](./AGENTS.md)：编码代理在本仓库中的工作规则。

## 开发和验证

本仓库当前没有统一构建产物或依赖安装步骤。插件代码以 DSH 动态插件函数体形式维护，因此修改后至少应执行：

```powershell
node -e "const fs=require('fs'); for (const f of ['model-capabilities/host.js','model-capabilities/client.js']) new Function(fs.readFileSync(f,'utf8')); JSON.parse(fs.readFileSync('model-capabilities/package.json','utf8')); console.log('validation passed')"
```

提交前还应检查：

- README 与插件实际能力一致；
- Host 和 Client 的 RPC 名称、字段结构同步；
- 不把未配置的 provider 或未知 route 写入 `settings.yaml`；
- 不提交本地会话、凭据或 Harness 运行数据。

## 贡献

欢迎通过 GitHub Issue 提交插件想法、兼容性问题和改进建议。新插件建议：

- 放在独立目录，并包含自己的 README、`package.json`（如需要）和源码；
- 说明适用的 DSH/Harness 版本、安装方式、权限边界和已知限制；
- 提供可复现的验证步骤；
- 不依赖未记录的本机配置或秘密。

Issue 使用 `needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix` 五个标准标签进行跟踪，详见 [`docs/agents/triage-labels.md`](./docs/agents/triage-labels.md)。

## 许可证

[MIT](./LICENSE)
