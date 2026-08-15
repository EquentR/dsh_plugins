# Model Capabilities — 模型能力配置插件

这是 [`dsh_plugins`](../README.md) 中的第一个插件，面向 DeepSeek Harness 的第三方模型配置场景。

为 DeepSeek Harness 的第三方(自定义)模型补上**推理等级**与**图片支持**的配置界面。

## 背景:harness 的现状

- 推理等级(reasoning effort)是**每模型**能力,不是每提供商能力。
- `@deepseek-ai/dsh-llm-pi-ai`(负责 OpenAI-compatible 自定义提供商的适配器)的配置 schema **已经支持**模型条目的两个能力字段,但模型设置页(shipped UI)没有编辑控件,用户只能手写 `settings.yaml`:

| 字段 | 含义 | 取值 |
| --- | --- | --- |
| `reasoningEfforts` | 该模型支持的推理等级 | `false`(不支持推理)或字典,如 `{ off: null, low: "low", high: "high" }` |
| `input` | 输入模态(图片支持) | `["text"]` 或 `["text", "image"]` |

- 配置写入后链路自动生效,无需改动内核:
  - pi-ai 适配器 `resolveModel()` 把 `reasoningEfforts` 暴露为模型目录的 `reasoning.efforts`;
  - composer 的模型选择器**已内置**推理等级下拉,只要有 `reasoning` 元数据就显示;
  - 选择模型与流式调用时按 `inputModalities` / `input` 校验图片支持。

## 本插件做什么

在设置面板新增一个 **「模型能力」** 页面(`settings.section`, id=`model-capabilities`):

- 每个 pi-ai 提供商一张卡片,列出其全部模型;
- 每个模型一行:
  - **支持推理** 开关;开启后勾选该模型支持的推理等级(off / minimal / low / medium / high / xhigh / max);
  - **支持图片** 开关(控制 `input` 是否含 `image`);
- 提供商级 **默认推理等级** 下拉(写入 `providers.<route>.reasoning`,模型选择器把它作为该模型的默认等级);
- 「保存全部」把能力写入 `settings.yaml` 的 `llm-pi-ai` 命名空间(路径化 `mutate`,保留未编辑字段),pi-ai 适配器随即重解析,模型选择器立即生效。

### 架构

- **Host 半**:两个包私有 RPC(`harness.handle`)
  - `model-caps:list` — 只读取**已配置**的 pi-ai provider(settings.yaml `providers` keys)的模型及当前能力;**排除** pi-ai 内置目录里那些未配置的候选供应商;
  - `model-caps:save` — 仅对已配置 route 合并编辑并经 `settings.mutate('llm-pi-ai', ops)` 持久化,从不新建/误写未配置或未知 route。
- **Client 半**:注册 `settings.section` 新页面,纯 React(无 JSX)。

## 文件

- `host.js` — Host 半源码(可直接用于动态插件 `cordis_define` 的 `code.host`)
- `client.js` — Client 半源码(可直接用于 `code.client`)
- `package.json` — 若作为持久 npm 插件安装时使用
- 本 README

Host 与 Client 通过以下包私有 RPC 通信，修改任一侧时必须同步检查另一侧：

| RPC | 作用 | 写入范围 |
| --- | --- | --- |
| `model-caps:list` | 读取已配置 provider 和模型能力 | 只读 |
| `model-caps:save` | 合并模型能力并持久化 | 已配置的 `llm-pi-ai` route，或已配置的官方 `llm-deepseek` 命名空间 |

## 安装与使用

### 方式一:动态插件(快速试用,进程内有效)

在当前会话中调用 `cordis_define`(`plugin.kind: "new"`,`code.host` 填 `host.js` 内容,`code.client` 填 `client.js` 内容),再 `cordis_run` 激活。批准后在设置面板出现「模型能力」页。

### 方式二:持久插件(重启后仍生效)

1. 把本目录放入 DSH 能解析的本地包位置,例如 `$DSH_HOME/profiles/web/node_modules/@dsh-plugins/model-capabilities`,或通过 `dsh plugin --profile web add <path>` 安装;
2. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 的 patch 数组中插入本插件的加载行(参考 dsh-app-boot 的 patch 语法,`insert` 进根插件列表);
3. 重启 `dsh web`。

> 注意:持久安装涉及 DSH 的 web 客户端模块扫描与构建,若你的部署通过 pnpm workspace 管理 profile 依赖,推荐走 `dsh plugin --profile web add`。

### 本地验证

源码是传给 `cordis_define` 的 JavaScript 函数体，不是可直接执行的 Node 程序。可以从仓库根目录用下面的命令检查函数体语法和包元数据：

```powershell
node -e "const fs=require('fs'); for (const f of ['model-capabilities/host.js','model-capabilities/client.js']) new Function(fs.readFileSync(f,'utf8')); JSON.parse(fs.readFileSync('model-capabilities/package.json','utf8')); console.log('validation passed')"
```

## 作用范围与限制

- 仅对 **pi-ai 适配器**(OpenAI-compatible 自定义提供商及其模型)生效;DeepSeek 官方适配器(`deepseek-official`)的模型 schema 没有这两个字段,其推理等级是提供商级统一配置,本插件不适用。
- 推理等级的 wire 值默认取等级名(`off` 为省略);若你的网关需要不同的 wire 拼写,直接在 `settings.yaml` 的 `reasoningEfforts` 里写 `等级: 拼写` 即可,本页面会原样保留并展示。
- 模型目录 wire schema 目前不把 `inputModalities` 传给模型选择器 UI,因此选择器上暂无图片标记;但图片能力校验(选择模型、流式调用)会按配置生效。

## 兼容性说明

插件依赖 Harness 提供的 `harness.handle`、`settings`、`llm`、`slots`、`styles` 和 `host.call` 扩展接口。上游接口或设置 schema 发生变化时，插件可能需要同步调整；请在 issue 中附上 DSH/Harness 版本、安装方式和最小配置。
