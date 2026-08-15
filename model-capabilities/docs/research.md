# 调研笔记:DSH 第三方模型的推理等级 / 图片支持配置

> 结论先行:Host 侧链路已完整,缺的只是**设置页 UI 的编辑控件**。本插件补上 UI。

## 1. 模型能力的类型定义

来源:`@deepseek-ai/dsh-llm/lib/types/types.d.ts`(版本 0.1.0-rc.6)

- `LlmModelInfo.inputModalities?: readonly ModelModality[]` — 模型接受的输入模态(`ModelModalityMap`: text | image),即"是否支持图片"。
- `LlmResolvedModelInfo.reasoning?: LlmModelReasoningInfo` — 精确路由的推理元数据:
  - `efforts: readonly LlmReasoningEffortInfo[]`(可选的推理等级,含 `id` / `name`);
  - `defaultEffort?: ReasoningEffortId`(适配器配置的默认等级)。
- `LlmDiscoveredModel` — 端点发现候选,仅 id/name/contextWindow/maxTokens,能力由采用方补充。

## 2. pi-ai 适配器已支持的配置字段(每模型)

来源:`@deepseek-ai/dsh-llm-pi-ai/lib/index.js`(`lib/types/config.js` 区域)

```js
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const MODALITIES = ['text', 'image']
const modelFields = {
  name, contextWindow, maxTokens,
  input: z.array(z.union(MODALITIES)),                       // ← 图片支持
  reasoningEfforts: z.union([z.const(false), reasoningEfforts]), // ← 推理等级,false=非推理模型
  compat: compatProfile,                                     // openai-completions 的 thinkingFormat/supportsReasoningEffort
}
```

- `reasoningEfforts` 是 `{ 等级: wire拼写 | null }` 字典;`off` 的 wire 可为空(`null` 表示"发送时省略参数")。
- 校验(`resolveModelReasoning`):空字典非法;必须至少声明一个非 `off` 等级。
- `resolveModel()` 把 `reasoningEfforts` → `thinkingLevelMap` → `getSupportedThinkingLevels()` → `reasoning.efforts`;把 `input` → `inputModalities`。
- 请求路径(`stream`)校验:图片内容需 `model.input.includes('image')`;推理等级需模型支持(`resolveReasoningLevel`)。
- 提供商级 `reasoning` 字段是默认等级;`describableReasoningLevel` 只在模型支持时把它暴露为 `defaultEffort`。

## 3. 消费链路(无需改动)

1. 设置写入:`settings.mutate('llm-pi-ai', ops)`,pi-ai 的 `installSettingsSection` onChange 重解析。
2. 适配器:`listModels()` / `resolveModel()` 暴露 `inputModalities` 与 `reasoning.efforts`。
3. Host API:`dsh-host-apiproxy` 的 `buildModelCatalog()` 组装模型目录,把 `reasoning`(efforts + defaultEffort)放入每个模型条目(`modelCatalogModelSchema`)。注意:该 wire schema 目前**不含** `inputModalities`,选择器 UI 不显示图片标记,但选择/调用时的校验仍生效。
4. 模型选择器:`dsh-client-ui-model-selection` 的 `ModelSelect` — `model.reasoning` 存在时自动渲染推理等级下拉(含 "provider default" 项),选择结果 `{provider, model, reasoningEffort}` 回传 Host。
5. 校验:选择模型(`selectModel`)时按 `inputModalities` 拒绝图片;流式调用按 `input` 拒绝图片内容。

## 4. 缺口与设计决策(shipped UI)

- 模型设置页(`dsh-client-ui-settings-models`,注册在 `settings.section` id=`models`)的模型行编辑器(`DeepSeekModelsEditor` / `ModelListEditor`)只有 id / name / contextWindow / maxTokens 四个字段。
- 源码注释明确:"reasoning effort 是每模型能力,提供商级控件无法表达,模型选择器为每个模型提供各自的等级" — 但**模型行级控件也缺失**,用户只能手写 `settings.yaml`。
- 设置页内部没有可注入的 slot;但 `settings.section` 是 list 槽,可**新增**页面条目(风险为零)。
- 模型行保存是结构开放的(`{...model}` 保留未知字段),插件写入的 `reasoningEfforts` / `input` 不会被设置页保存时丢弃。

## 5. 本插件的实现

- Host 半:`harness.handle` 两个 RPC:
  - `model-caps:list` — `settings.get('llm-pi-ai')` 的已配置 provider keys + `llm.listModels()`(缺省时)组装纯 JSON;
  - `model-caps:save` — 基线(解析值 models,缺省时 listModels,合并 modelOverrides)上应用编辑,`settings.mutate('llm-pi-ai', [{op:'set', path:['providers',<route>,'models'], value}])`,附带 provider 级 `reasoning`(默认等级)set/unset。
- Client 半:注册 `settings.section` 新页面(id=`model-capabilities`,order=11,label「模型能力」),React 无 JSX,`host.call` 读写。
- 保存后 pi-ai 适配器自动重解析 → 模型选择器立即显示推理等级下拉。

## 6. 边界与已知限制

- 仅适用 pi-ai 适配器(OpenAI-compatible 自定义提供商);DeepSeek 官方适配器(`llm-deepseek`)的模型 schema 无这两个字段(其推理等级为提供商级统一配置)。
- wire 值默认取等级名;自定义 wire 拼写需手写 `settings.yaml`(本页面原样保留展示)。
- 模型目录 wire schema 不含 `inputModalities`,选择器暂无图片标记(能力校验仍生效);如需显示,需改 `dsh-host-apiproxy` 的 `buildModelCatalog` 与 `modelCatalogModelSchema`(超出插件范围)。

## 7. 关键源码位置(0.1.0-rc.6,node_modules 安装目录)

- `@deepseek-ai/dsh-llm/lib/types/types.d.ts` — 模型能力类型
- `@deepseek-ai/dsh-llm-pi-ai/lib/index.js` — 配置 schema、resolveModelReasoning、resolveModel、listModels
- `@deepseek-ai/dsh-host-apiproxy/lib/index.js` — buildModelCatalog(模型目录组装)
- `@deepseek-ai/dsh-host-apiproxy/lib/types/api/sessions.schema.js` — modelCatalogModelSchema / modelReasoningSchema
- `@deepseek-ai/dsh-client-ui-model-selection/lib/client.js` — 推理等级下拉 UI(现成)
- `@deepseek-ai/dsh-client-ui-settings-models/lib/client.js` — 模型设置页(shipped,无内部扩展点)
- `@deepseek-ai/dsh-settings/lib/types/index.d.ts` — SettingsPathOp(`{op:'set'|'unset', path, value?}`)
