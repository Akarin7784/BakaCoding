# @bakacoding/desktop

模块 12 桌面界面：参照 electron-vite-react 模板的 Electron + React + TS，shadcn/ui 风格组件（Tailwind v4），lucide 图标。

## 数据来源（T-023）

- 主进程用 better-sqlite3 **只读**打开模块 2 的库（`readonly: true`，不跑迁移、不拿写入者租约），协调服务在写的时候也能看。
- 路径：`--db=<path>` 参数 > 环境变量 `BAKACODING_DB_PATH` > `<cwd>/.bakacoding/bakacoding.db`。库还不存在时界面顶部提示路径，建库后自动接上。
- 主进程每 1 秒按 `seq` 增量轮询（协调服务在另一个进程，进程内总线订阅不到），经 IPC 推给渲染进程：先 `bakacoding:snapshot` 取快照，再收 `bakacoding:update` 增量。只下发 `project_created`、`group_message`、`call_completed`（不带提示词）、`escalated` 和需求单摘要。
- preload 通过 contextBridge 只暴露 `window.bakacoding`：`platform`、`getSnapshot()`、`onUpdate(listener)`，没有写操作；窗口开 `contextIsolation`、`sandbox`，关 `nodeIntegration`。契约在 `src/shared/api.ts`。
- 渲染进程不引入 Node 和存储模块；没有 `window.bakacoding`（测试、浏览器开发）时用 `src/renderer/mock/` 假数据。

## 命令

- `pnpm build`：tsc 类型构建（根目录 `tsc -b` 会走到）
- `pnpm build:app`：vite 打包渲染进程到 `dist-renderer/`，主进程和 preload（`preload.cjs`）到 `dist-electron/`
- `pnpm dev`：开发模式（需要 Electron 二进制；pnpm 10 默认不跑 electron 的安装脚本，需要时执行 `node node_modules/electron/install.js`）
- `pnpm rebuild:electron`：用 `@electron/rebuild` 为当前 Electron 版本另编一份 better-sqlite3，放到 `native/electron/better_sqlite3.node`（已 gitignore），主进程通过 `nativeBinding` 加载。不就地重编，也不放进 postinstall：better-sqlite3 在 pnpm 下只有一份，被模块 2 和 Node 下的 vitest 共用。
  - better-sqlite3 已升到 12.x（T-026），在 Electron 44.9.0 下能编过并正常加载。
