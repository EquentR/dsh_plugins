# Delete Session — 真会话删除插件

给 DSH Web 加上**真正删除**会话的能力：删掉会话的持久化记录，而不只是把它从列表里隐藏或归档。

本插件是独立包：安装它只会插入 `dsh-delete-session` 一行 Loader 配置，不会连带安装 `dsh_plugins` 仓库中的其他插件。

## 移植来源

移植自 [yiiilin/dsh-plugins](https://github.com/yiiilin/dsh-plugins) 的 `delete-session` 模块（MIT 许可），并按 `dsh_plugins` 的独立包边界重新打包。

## 功能

- **会话标题旁的删除入口**：当前会话标题旁一个图标按钮，沿用会话头部自带的图标按钮尺寸；
- **会话行菜单项**：每个普通会话的三点菜单里增加"删除会话"，只在**该行自己的菜单**打开时渲染，不会跑到别的弹窗里；
- **批量管理**：在"新建工作区"旁增加批量管理入口，进入管理态后每个可见会话带复选框，配合"取消 / 删除所选"；
- **二次确认**：所有删除都要经过一个显式确认卡片，未确认不会发出请求；
- **连带删除子会话**：会沿着 `origin: "subagent"` 递归删除该会话派生出的所有子会话记录，深度不限，避免留下孤立 transcript；
- **安全释放**：活动会话会先 flush 再 dispose，确认写入方已经消失后才删除记录文件；
- **串行化**：多个删除请求进同一个队列，不会交叉执行。

## 删除范围

删除的是**受保护的每会话目录**（`session.jsonl` / `session.vN.jsonl`，含 zstd 压缩变体，以及该目录下的临时文件）。

不会删除：

- 工作区目录本身；
- 内容寻址的图片对象（可能被其他会话共用）；
- 其他会话的日志。

## 架构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半：`POST /_dsh/delete-session/delete`，接受 `{ sessionId }` 或 `{ sessionIds: [...] }`（最多 100 个）并强制要求 `confirm: true`；负责 flush/dispose、解析受保护的会话目录、级联子会话。 |
| `client.js` | Client 半：在 `conversation.session.header.actions`、`sidebar.workspaces.session.menu.item`、`sidebar.workspaces.session.row.action` 注册入口，并复用自带 `Modal` 做确认。 |
| `cordis.patch.yml` | 只声明 `dsh-delete-session` 一行；`inject` 为 `webServer`、`sessions`、`agents`、`sessionPersistence`。 |

## 安装

持久包，不是 `cordis_define` 动态插件：`index.js` 使用顶层 `import`（`node:fs/promises`、`node:path`），动态插件只接受函数体。

```text
plugin_manager action=install_bundle target=<本目录的绝对路径>
```

或：

```powershell
dsh plugin --profile web add <本目录的绝对路径>
```

装好后**必须重启 `dsh web`**：Host 半需要在挂载后开始跟踪 Agent handle，安装前就已经打开的会话没有可用的释放句柄。

## 兼容性

- 按 DSH `0.2.1-rc.2` 核对：`webServer.register`、`sessions.get/flush`、`agents.get`、`agent/disposed` 事件、`sessionPersistence.list`、以及 `sessionPersistence` 暴露的每会话 artifact 位置；
- `peerDependencies` 声明 `@deepseek-ai/dsh >=0.2.1-rc.2 <0.2.2`；
- 只支持**每会话 JSONL 持久化后端**（含所有已提交的 Session 格式代际，可选 zstd 压缩）。SQLite 之类不暴露每会话 artifact 位置的后端会返回明确的 unsupported 错误，而不会去大范围删库。

## 限制

- **不可恢复**：确认后日志被 `rm` 删除，没有回收站；
- 安装前就已打开的会话若仍是活动状态，删除会被拒绝并提示重启，这是刻意的保护，不会"只删文件不释放进程"；
- 批量上限 100 个/次；
- 依赖 Client 会话服务的 `refresh()` 来刷新侧边栏；过旧的 shell 会退化为整页刷新；
- 没有权限分级：能打开这个 Web 的人就能删除会话。

## 验证

```powershell
cd <仓库根目录>
node scripts/validate.mjs
```

### 已实测（2026-10-18，DSH 0.2.1-rc.2，desktop profile）

安装 `application: applied` 后在运行中的 Host 上实测：

| 检查 | 结果 |
| --- | --- |
| `GET /_dsh/delete-session/delete` | 405 `method not allowed`（路由已注册） |
| `POST {}` | 400 `sessionId is required` |
| `POST {"sessionId":...}` 无 `confirm` | 400 `explicit delete confirmation is required`（确认闸门有效，未触达删除） |
| Client 槽位 `conversation.session.header.actions` | 出现 occupant `delete-session`，`order: 100`，`active: true` |

尚未验证：真正的删除动作（会不可恢复地删掉会话记录）。这一条需要你自己拿一个用完即弃的会话来试。

### 安装后的人工检查

1. 新建一个用完即弃的会话，从标题旁图标删除，确认卡片出现 → 取消 → 会话仍在；
2. 再次删除并确认 → 会话从侧边栏消失，在会话存储目录中确认其 JSONL 已不存在；
3. 在一个带子 Agent 的会话上删除，检查返回值里的 `subagentSessionIds` 与实际消失的目录一致；
4. 对安装前就已打开的活动会话尝试删除，应得到 409 与重启提示。
