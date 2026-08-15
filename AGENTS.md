# DSH Plugins Agent Guide

## 适用范围

本文件适用于 `dsh_plugins` 仓库。仓库是基于 DeepSeek Harness 的第三方插件集合；当本文件与插件源码或上游 Harness 行为不一致时，以实际源码和当前上游接口为准，并在必要时修正文档。

## 仓库结构

- `model-capabilities/`：当前插件，包含 Host 源码、Client 源码、插件说明和包元数据。
- `CONTEXT.md`：领域词汇、插件边界和当前上下文，探索相关代码前优先阅读。
- `docs/adr/`：记录会影响多个插件或长期维护方式的架构决策。
- `docs/agents/`：工程 skill 使用的 issue tracker、triage 和领域文档约定。
- `.github/ISSUE_TEMPLATE/`：GitHub issue 的提问模板。

## Agent skills

### Issue tracker

Issues and follow-up work live in GitHub Issues for this repository. Use `gh issue` from the repository root; see `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`; see `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. Read `CONTEXT.md` and relevant files under `docs/adr/` before making domain or architecture changes; see `docs/agents/domain.md`.

## 工作边界

- 先读目标插件的 README、Host、Client 和 `package.json`，再修改；不要假定 Harness 内部服务或命令一定存在。
- 插件必须通过 Harness 已有扩展边界工作，除非 issue 明确要求，不要修改或复制 Harness 核心代码。
- Host 与 Client 的 RPC 名称、请求字段和响应结构是一个契约；任何一侧变化都要同步检查另一侧和文档。
- 设置写入必须保留未编辑字段，只允许修改已配置的 provider route；不要为了方便创建未知配置。
- 动态插件代码是函数体而不是独立 Node 程序，不能在源码文件顶层添加 import、启动逻辑或运行时副作用。
- 不提交 API key、token、会话文件、Harness profile 数据或本机生成的构建目录。
- 新增插件应独立放置，至少包含用途、安装、兼容性、限制和验证步骤；需要持久安装时补充包元数据。

## 文档规则

- README 面向使用者，描述可观察行为和安装步骤；`CONTEXT.md` 面向维护者，记录术语和边界；ADR 记录长期决策，不要把三者混成一份。
- 使用中文维护仓库级文档，代码中的标识符和上游名称保持原文。
- 任何依赖上游版本的结论都注明版本假设或链接到上游文档。
- issue 标题应描述可行动的结果；提交前给 issue 加上合适的 triage 标签。

## 验证

仓库目前没有统一构建系统。修改插件源码后执行：

```powershell
node -e "const fs=require('fs'); for (const f of ['model-capabilities/host.js','model-capabilities/client.js']) new Function(fs.readFileSync(f,'utf8')); JSON.parse(fs.readFileSync('model-capabilities/package.json','utf8')); console.log('validation passed')"
```

同时做一次 `git diff --check`，并人工检查文档是否仍与源码一致。若引入测试或构建脚本，应把命令补充到根 README 和本文件。

## GitHub 与提交

- 默认远程为 `origin`，目标仓库是 `EquentR/dsh_plugins`；创建或修改远程前先用 `git remote -v` 确认。
- issue、label 和 PR 元数据使用 `gh` CLI；不要把个人 token 写入仓库。
- 保持提交小而有意义，提交消息说明用户可观察的变化。
- 推送前确认 `git status`、`git diff --stat` 和 `git diff --check`，不要覆盖其他人的未提交改动。
