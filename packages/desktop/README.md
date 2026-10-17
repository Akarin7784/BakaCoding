# @bakacoding/desktop

模块 12 桌面界面：参照 electron-vite-react 模板的 Electron + React + TS，shadcn/ui 风格组件（Tailwind v4），lucide 图标。

## 数据来源（T-023）

- 主进程用模块 2 的 `openStorageReadonly` 打开库（T-027 起；T-023 时是手写 SQL）：不跑迁移、不拿写入者租约，协调服务在写的时候也能看。事件用 `queryEvents({ after_seq, types })`，需求单用 `query({ project_id })`，不再直接碰表。
- 轮询先看 `maxSeq()`，没有新事件就不查事件表；需求单（`saveTicket` 不产生事件）每次照查，有变化才下发。
- 项目列表用存储的 `listProjects()`（T-033 起；之前从 `project_created` 和群消息事件里收集项目 id），再按项目 `query({ project_id })` 取需求单。
- 需求单标题取正文第一行非空文本，按 `\r\n`、`\r`、`\n` 分行并去掉行尾空白，Windows 换行不会在标题末尾留下 `\r`；超过 80 字符截断。
- 界面顶部的状态：库文件不存在显示路径；库版本和代码不一致（`StorageVersionError`）显示存储给的说明；原生模块 ABI 不对时提示先跑 `rebuild:electron`。打开或读取失败后每次轮询重试，恢复后补发全部数据。
- 路径：`--db=<path>` 参数 > 环境变量 `BAKACODING_DB_PATH` > `<cwd>/.bakacoding/bakacoding.db`。库还不存在时界面顶部提示路径，建库后自动接上。
- 主进程每 1 秒按 `seq` 增量轮询（协调服务在另一个进程，进程内总线订阅不到），经 IPC 推给渲染进程：先 `bakacoding:snapshot` 取快照，再收 `bakacoding:update` 增量。只下发 `project_created`、`group_message`、`call_completed`（不带提示词）、`escalated` 和需求单摘要。
- preload 通过 contextBridge 只暴露 `window.bakacoding`：`platform`、`getSnapshot()`、`onUpdate(listener)`，没有写操作；窗口开 `contextIsolation`、`sandbox`，关 `nodeIntegration`。契约在 `src/shared/api.ts`。
- 渲染进程不引入 Node 和存储模块；没有 `window.bakacoding`（测试、浏览器开发）时用 `src/renderer/mock/` 假数据。

## 命令

- `pnpm build`：tsc 类型构建（根目录 `tsc -b` 会走到）
- `pnpm build:app`：vite 打包渲染进程到 `dist-renderer/`，主进程和 preload（`preload.cjs`）到 `dist-electron/`
- `pnpm dev`：开发模式（需要 Electron 二进制；pnpm 10 默认不跑 electron 的安装脚本，需要时执行 `node node_modules/electron/install.js`）
- `pnpm package:win`（先 `pnpm build:app`）：打 Windows x64 免安装 zip 到 `release/win32/`；`pnpm package:linux` 打 Linux 目录版（冒烟用）。用 better-sqlite3 12.12.0 官方 electron-v148 预编译包（下载按 SHA256 校验），见 `scripts/package-app.mjs`（T-073）。electron-builder、resedit 是本包 devDependency；Windows exe 的版本信息用 resedit 写（不需要 wine），有 `build/icon.ico` 时一并换图标。
- `pnpm rebuild:electron`：用 `@electron/rebuild` 为当前 Electron 版本另编一份 better-sqlite3，放到 `native/electron/better_sqlite3.node`（已 gitignore），主进程通过 `nativeBinding` 加载。不就地重编，也不放进 postinstall：better-sqlite3 在 pnpm 下只有一份，被模块 2 和 Node 下的 vitest 共用。
  - better-sqlite3 已升到 12.x（T-026），在 Electron 44.9.0 下能编过并正常加载；T-027 实测窗口能显示真实库的数据（#22 里 ABI 报错的已知问题已解决）。
  - T-073 起 `electron` 固定为 43.8.0（ABI 148）：better-sqlite3 还没有 Electron 44（ABI 149）的预编译包，Windows 版不能从 Linux 交叉编译，开发和打包用同一个 Electron；上游出了再升。
  - `@bakacoding/storage` 打包进主进程，`better-sqlite3` 保持 external、运行时从本包的 `node_modules` 加载，所以本包仍直接依赖 better-sqlite3：这也是 `rebuild:electron` 编译的那一份，两者版本一致。

## 未归属的上报（T-049）

对不上任何项目的 `escalated`（比如合并队列对认不出的 PR 用 `unattributed:<pr_id>` 作需求号）不再丢掉，而是放进侧栏最后的「未归属」：显示 PR 号（或单号 / 需求号）、原因和说明；说明以 `merged_but:` 开头的标「代码已进集成分支」。没有这类上报时侧栏不显示这一项。

## 需求单提示（T-050）

模块 10 发的 `ticket_warning`（单级警告，不需要人工介入）显示在项目群顶部的「需求单提示」里，用灰字，排在「需要人工介入」下面；侧边栏 PR 列表里对应的单带一个提示图标，悬停看文案。`write_scope_defaulted`（没给写入范围，按整个仓库可写处理）和 `fields_invalid`（结构化字段缺失或损坏，不能续跑）有中文文案；文案表故意不按代码穷举，以后加了新代码而这里还没配文案时，原样显示代码，类型检查也不会挂。项目号对不上任何项目的警告放进「未归属」。

`escalated` 的 `reason` 是 `merged_but`（T-038 起）或说明以 `merged_but:` 开头（旧库）时，都标「代码已进集成分支」。

## 高风险 PR 裁决（T-062）

- 主进程经 `assemble` 拿到 `App.supervisor` 后，IPC 暴露：
  - `getPendingHighRisk()` → 同步调用 `pendingHighRisk()`（内存清单；只读模式为空）
  - `decideHighRisk(ticket_id, pr_id, "release" | "reject", detail?)` → 转调 `decideHighRisk`；`stale_pr` 返回文案「PR 已更新，请重新查看」
  - `onPendingHighRisk`：清单刷新推送
- 刷新时机：`onHighRiskHeld`（经主管通知）、`escalated` / `ticket_warning`、裁决完成后、以及事件轮询（PR 状态经 sync 变化时不发新事件，靠轮询补刷）。不新增事件类型。
- 界面顶部「高风险 PR 待裁决」：理由用 `HighRiskReason` 中文；命中文件用模块 8 的 `HighRiskFile`，有 `old_path` 显示 `package.json → x.json`。
- 裁决错误码九个都有中文（`HIGH_RISK_DECISION_ERROR_LABEL`）。
- 警告列表：`requirement_truncated` / `pr_close_failed` / `high_risk_reject_not_applied` / `takeover_skipped` 配中文；按 `ticket_id+code` 去重带 ×N；最多约 50 条，其余 `+N 条`；detail 预览约 500 字，悬停全文上限 4000。
- **不在本单**：`syncState()` 接线（T-067）。
