# ADR-0001: 插件集合保持在 Harness 扩展边界内

- 状态：已接受
- 日期：2026-08-15

## 背景

DSH Plugins 面向 DeepSeek Harness 的第三方扩展。当前插件通过 `cordis_define`/`cordis_run` 或 profile 本地包加载，Host 和 Client 分别运行在 Harness 提供的扩展环境中。

## 决策

每个插件都应通过 Harness 已有的插件、slot、RPC 和 settings API 提供能力，不直接修改或复制 Harness 核心实现。插件应明确记录兼容性假设；当上游接口不足时，通过 issue 讨论扩展边界，而不是在插件中建立隐式替代运行时。

## 影响

- 插件可以独立发布和停用，降低对 DSH 核心升级的影响。
- 插件必须接受上游扩展 API 的兼容性约束，并在 README 中记录限制。
- Host/Client 契约、设置写入范围和动态/持久安装差异需要在每个插件中明确说明。
