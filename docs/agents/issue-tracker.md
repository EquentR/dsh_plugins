# Issue tracker: GitHub

本仓库使用 GitHub Issues 跟踪插件想法、缺陷、兼容性问题和文档工作。仓库远程为 `EquentR/dsh_plugins` 时，从仓库根目录执行 `gh issue` 命令即可自动定位项目。

## 常用操作

```powershell
gh issue create --title "..." --body "..."
gh issue list --state open --label needs-triage
gh issue view <number> --comments
gh issue comment <number> --body "..."
gh issue edit <number> --add-label ready-for-agent
gh issue close <number> --comment "..."
```

Issue body 应包含背景、期望行为、影响范围和验证方式。缺少复现信息时使用 `needs-info`，不要先猜测实现方案。

## PR 作为请求入口

**PRs as a request surface: no.** 外部 PR 不自动进入 triage 请求队列；维护者仍可以按普通 PR 流程审查贡献。

## 发布到 issue tracker

当工程 skill 要求“发布到 issue tracker”时，创建一个 GitHub issue，并在完成工作后补充结果评论、验证命令和相关提交或 PR 链接。
