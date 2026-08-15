# Domain Docs

工程 skill 在探索仓库前应读取根目录 `CONTEXT.md`，再读取与当前改动相关的 `docs/adr/` 文件。

本仓库是单上下文布局：

```text
/
├── CONTEXT.md
├── docs/adr/
├── docs/agents/
└── <plugin directories>/
```

使用 `CONTEXT.md` 中的领域词汇描述 issue、重构建议、测试和文档。若新增概念与现有词汇冲突，应先更新上下文或建立 ADR，不要在不同文档中使用多个同义词。

如果某个改动与 ADR 冲突，要在变更说明中明确指出并说明是否需要重新审议 ADR。领域文档按需创建，不因为文件缺失而阻塞普通插件开发。
