# dsh-session-scrub

[中文](#中文) | [English](#english)

## 中文

给 DeepSeek Harness (DSH) 加一个**彻底清理会话**的入口：不只是删掉侧边栏那一行，而是把这个会话在本机留下的**所有**痕迹一起收走。

官方只有「归档」（把会话藏起来，日志永远留在磁盘上），以及 `workspace` 的删除（保留会话）。本插件补的是**真正的删除**。

### 和其他会话删除插件有什么不同

| 能力 | dsh-session-scrub | dsh-session-purge | dsh-session-cleaner |
|---|---|---|---|
| 删除会话日志 | ✅ | ✅（移入回收站） | ✅ |
| 工作区登记摘除 | ✅ | ✅ | ✅ |
| 子代理（subagent）级联删除 | ✅ | — | — |
| 定时任务联动删除 | ✅ | — | — |
| 投影缓存清理 | ✅ | 部分 | — |
| 临时溢出文件（spill）清理 | ✅ | — | — |
| **附件引用感知回收**（只删无人引用的 blob） | ✅ | — | — |
| 图片变体缓存清理 | ✅ | — | — |
| 浏览器本地（草稿/右栏/排序）清理 | ✅ | — | — |
| 孤儿会话自愈 | ✅ | — | — |
| 可撤销（回收站） | ❌ | ✅ | ❌ |

一句话：**它们管“删掉那一条”，本插件管“删干净”。**

### 安装

**桌面版（DeepSeek Harness 应用）**：桌面版只能用自带 CLI 管理 `desktop` profile，普通 `dsh` 命令管不了它。

```sh
"%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-session-scrub
```

装在别处就把前半段换成 `<安装目录>\resources\runtime\cli\bin\dsh.cmd`。也可以在 DSH 的**插件市场**里按包名 `dsh-session-scrub` 安装（市场和 profile 用同一个 npm 源即可）。

**Web / TUI 版**：

```sh
dsh plugin --profile <你的 profile> add dsh-session-scrub
```

也可以从本地目录或 tgz 安装：

```sh
dsh plugin --profile <你的 profile> add file:/path/to/dsh-session-scrub
```

装完**重启 DSH**（Host 半边只在启动时装载），然后刷新页面。

### 使用

会话行右键 → **彻底清理此会话** → 确认。

删除分两段，弹窗里都能看到：

1. **立即段**：删除日志目录、子代理会话、定时任务、工作区登记、投影缓存、spill 文件 → 会话立刻从侧边栏消失；
2. **后台段**：扫描所有存活会话的附件引用，回收“谁都不引用”的附件对象，并在确实回收了对象时清空图片变体缓存。弹窗会实时显示进度（“已回收 N 个…”→“回收 X 个，保留 Y 个”）。

### 会被保护、不会被删的东西

- **正在运行的会话**：拒绝删除（提示“该会话正在运行”）；
- **当前正在看的会话**：拒绝删除；
- **仍有其它会话引用的附件**：保留（删除只会破坏别的会话里的图）；
- **正在运行的子代理**：级联时跳过并提示；
- **1 小时内的新附件**：保留（可能是你还没发出去的草稿附件）；
- **fork 出去的新会话**：它们是独立会话，不受影响。

### 配置（可选）

装好后可在 profile 的 `cordis.patch.yml` 里覆盖，全部有默认值：

```yaml
- id: dsh-session-scrub
  config:
    attachmentSweep: true        # 是否回收无人引用的附件
    orphanSweep: true            # 删完是否顺带清理孤儿会话
    orphanMinimumAgeHours: 24    # 多久没主人的会话才算孤儿
    draftGraceMinutes: 60        # 新附件保护窗口
    sweepBudgetSeconds: 90       # 后台回收的时间上限
    diagnostics: false           # 是否挂载只读诊断路由（开发用）
```

### 边界与风险

- **删除不可撤销**。本插件不提供回收站；需要可撤销请用 `dsh-session-purge`。
- **只会删本机数据**：已经上传到服务端的会话日志副本无法删除。
- **不会动别处的引用**：其它会话日志里提到它的文字、飞书/IM 侧的绑定都保留（删完后 IM 侧会提示“找不到会话”）。
- **依赖一个非公开方法**：从工作区登记里摘除会话用的是 `detachSession`。若某个 DSH 版本没有它，插件会提示“该行可能残留”而不是静默失败。

### 兼容性

- **已验证**：DSH `0.2.2-rc.1` · Windows 11 · Node 24。没有在 macOS/Linux 上实机验证。
- **预期兼容**：DSH `0.2.2-rc.2`（同一 patch 线，会话层接口未变）。
- 只依赖公开服务（`connection.fetch`、`webServer`、`sessionPersistence`、`sessionQuery`、`workspaceRegistry`、`schedule`、`agents`）与上面那一个内部方法。
- DSH 升级后如果会话层接口变动，插件可能失效——失效时表现为菜单点不动或提示“无法确定 DSH 主目录”，不会误删。

### 开发

```sh
node --test test/*.test.js
```

`lib/logic.js` 是纯函数（配置归一化、孤儿判定、附件引用解析、路径守卫、告警折叠），测试只覆盖它；`lib/index.js` 只有副作用。

## English

Adds **deep scrubbing** of one DSH session: not just removing the sidebar row, but
reclaiming everything the session left on this machine — its log, subagent children,
scheduled tasks that reference it, workspace accounting, projection cache, spill files,
and every attachment no other session still cites.

Official DSH only offers *archive* (hide the row, keep the log forever). This plugin
performs the actual removal.

### How it differs

- **vs. `dsh-session-purge`** (recycle bin): purge is undoable but moves only the
  session directory; this plugin additionally cascades subagents, removes schedules,
  clears projection cache/spill, and reclaims unreferenced attachments.
- **vs. `dsh-session-cleaner`**: cleaner deletes the row; this plugin also cleans the
  derived state around it.

### Safety

Refuses running sessions and the session currently open in the conversation view;
keeps attachments still cited by any surviving session; skips running subagents;
keeps attachment objects younger than the draft grace window; never touches forks.

### Install

**Desktop app**: only the CLI bundled with the app can manage the reserved `desktop` profile.

```sh
"%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-session-scrub
```

For a custom install location, replace the leading path with `<install dir>\resources\runtime\cli\bin\dsh.cmd`. You can also install it from the DSH plugin marketplace by package name.

**Web / TUI**:

```sh
dsh plugin --profile <profile> add dsh-session-scrub
```

Restart DSH afterwards, then refresh the page. Right-click a session →
**Scrub this session**.

### Config

`attachmentSweep`, `orphanSweep`, `orphanMinimumAgeHours`, `draftGraceMinutes`,
`sweepBudgetSeconds`, `diagnostics` — see the Chinese section for a YAML example.

### Compatibility

Verified on DSH `0.2.2-rc.1`, Windows 11, Node 24; expected compatible with `0.2.2-rc.2`. Not verified on macOS/Linux.

## License

MIT