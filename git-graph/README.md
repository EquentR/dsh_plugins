# Git Graph — Git 图谱插件

在 DSH Web 右侧栏增加一个 **Git** 标签页，用于查看当前工作目录所在仓库的提交历史、未提交改动和文件差异。

本插件是独立包：安装它只会插入 `dsh-git-graph` 一行 Loader 配置，不会连带安装 `dsh_plugins` 仓库中的其他插件。

## 移植来源

移植自 [yiiilin/dsh-plugins](https://github.com/yiiilin/dsh-plugins) 的 `git-graph` 模块（MIT 许可），并按 `dsh_plugins` 的独立包边界重新打包：包名、客户端模块 id、标签页标识和样式归属都改到本仓库的 `@dsh-plugins/` 命名空间下，不再依赖参考仓库的统一 bundle。

## 功能

- **提交泳道图**：可切换"所有分支 / 当前分支"，彩色泳道 + 提交点 + 合并曲线，可手动刷新；
- **装饰标签**：分支、远程、tag、HEAD 以 pill 形式标在提交旁；
- **未提交改动行**：由 `git status` 生成的改动行，显示改动文件数量；未跟踪目录会逐个列出其中的文件；
- **提交详情**：点击提交展开完整提交信息与改动文件清单，带 A/M/D/R 状态标记；
- **文件差异**：点击文件在弹窗中打开补丁——提交用 `git show`，工作区用 `git diff HEAD`。

差异弹窗需要的两个库由本插件自己提供，不依赖 CDN，也不需要额外构建步骤：

| 资源 | 路由 | 来源 |
| --- | --- | --- |
| monaco 编辑器 | `/_dsh/git-graph/monaco/vs` | 本包 `node_modules/monaco-editor` |
| markdown 渲染 | `/_dsh/git-graph/vendor/markdown-it.mjs` | 本包 `node_modules/markdown-it` |

## 架构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半：在 `/_dsh/git-graph` 下注册只读路由（`git-log`、`git-commit`、`git-diff`、`git-status`），用机器可读分隔符运行 `git`，只返回 JSON；同时提供上面两个前端静态资源路由。 |
| `client.js` | Client 半：在 `ctx.sidebarRightTabs` 注册 Git 页签类型，并在 `sidebar.right.pane.tab` 槽位按类型 id 注册页签主体。 |
| `cordis.patch.yml` | 只声明 `dsh-git-graph` 一行；`inject` 为 `webServer`、`subprocess`、`fs`、`sandboxPolicy`，等这些 Host 服务就绪后才会激活。 |
| `locale/*.json` | `meta.title` / `meta.description`，供插件列表显示。 |

## 安装

这是一个**持久包**，不是 `cordis_define` 动态插件：`index.js` 使用了顶层 `import`（`node:fs`、`node:module`、`node:path`），而动态插件代码是函数体，不接受顶层 import。

先安装依赖，让 monaco 与 markdown-it 可用。profile 以符号链接方式引用本目录，因此这两个依赖必须装在**本目录**的 `node_modules` 里：

```powershell
cd <本目录>
pnpm install --config.auto-install-peers=false
```

`--config.auto-install-peers=false` 不能省：`peerDependencies` 里声明的是宿主 profile 已经提供的 DSH 包，
pnpm 默认会把它们当成需要安装的依赖，从而在插件目录里再拉一份约 580 MB 的 DSH；加上这个参数后只装
`markdown-it` 与 `monaco-editor`（约 98 MB）。`.npmrc` 与 `pnpm-lock.yaml` 的 `settings` 在当前
pnpm（v11）下都不足以关闭这个行为，必须显式传参。`peerDependencies` 保留不动，因为 DSH 的安装器用它
做版本闸门。

然后安装到当前 profile：

```text
plugin_manager action=install_bundle target=<本目录的绝对路径>
```

或使用 CLI：

```powershell
dsh plugin --profile web add <本目录的绝对路径>
```

装好后重启 `dsh web`，刷新页面；右侧栏出现 Git 图谱的引导卡片，点开即是 Git 页签。

## 兼容性

- 按 DSH `0.2.1-rc.2` 核对扩展点：`webServer.register({ kind: 'exact' | 'prefix' })`、`subprocess.resolveExecutable`、`sidebarRightTabs` 注册项、`sidebar.right.pane.tab` 键位槽、`locale.register/bind`；
- `peerDependencies` 声明 `@deepseek-ai/dsh >=0.2.1-rc.2 <0.2.2`；换到其他 DSH 版本前请重新核对上面这些接口；
- 参考实现的验证基线是 DSH `0.2.0-rc.2` / `0.2.1-alpha.2`，本包的改动只涉及命名与打包边界，未改动 git 调用与渲染逻辑。

## 限制

- 仓库根目录由**请求方传入的目录**决定，插件不会跨仓库聚合；
- 只读：不提供提交、暂存、切分支等写操作；
- 路由是只读 JSON 接口，但仍会在 Host 上真实执行 `git` 子进程；请只在自己的工作目录使用；
- 插件默认对所有能访问 Web 的人可见，没有额外的鉴权层，部署在公网前请自行加保护；
- 首次安装需要重启 Host，Client 半需要刷新页面才会加载。

## 验证

```powershell
cd <仓库根目录>
node scripts/validate.mjs
```

该脚本会检查三个插件包的 JSON 清单、`cordis.patch.yml` 与包名一致性，并把 JS 文件按 ES 模块语法解析。

### 已实测（2026-10-18，DSH 0.2.1-rc.2，desktop profile）

安装 `application: applied` 后在运行中的 Host 上实测：

| 检查 | 结果 |
| --- | --- |
| `GET /_dsh/git-graph/monaco/vs/loader.js` | 200，`text/javascript`，39848 字节 |
| `GET /_dsh/git-graph/vendor/markdown-it.mjs` | 200，`text/javascript`，124681 字节 |
| `POST git-log`（本仓库目录） | `ok:true`，返回 `root`、`head=master` 与真实提交列表 |
| `POST git-status` | `ok:true`，`entries` 与 `git status --short` 一致 |
| `POST git-diff`（工作区 `README.md`） | `ok:true`，返回补丁正文 |
| Client 槽位 `sidebar.right.pane.tab` | 出现 occupant `@dsh-plugins/git-graph/git`，`active: true` |

尚未验证：浏览器里的实际渲染（提交泳道图、diff 弹窗、markdown 预览）需要人眼确认。

### 安装后的人工检查

1. 右侧栏能打开 Git 页签，提交图与 `git log --graph --oneline` 一致；
2. 在工作区改动一个文件，"未提交改动"计数随之变化，点击文件能看到 diff；
3. 断开 Host 的 `subprocess` 时页面给出错误提示而不是白屏。
