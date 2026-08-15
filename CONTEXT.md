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

## 当前上下文

当前仓库只有 `model-capabilities` 插件。它通过两个包私有 RPC 读取和保存模型信息：

- `model-caps:list` 读取已配置的 `llm-pi-ai` provider，并在配置存在时展示 `llm-deepseek` 官方适配器；
- `model-caps:save` 合并编辑后的模型显示名称、模型能力，并通过 `settings.mutate` 持久化；
- 未配置的 provider、未知 route 和未声明的模型不会被当作可编辑目标。

当新增插件或改变这些术语的含义时，先更新本文件和相关 ADR，再更新 README 或 issue 文案。
