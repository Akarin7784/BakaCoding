# @bakacoding/desktop

模块 12 桌面界面（T-013 壳子）：参照 electron-vite-react 模板的 Electron + React + TS，shadcn/ui 风格组件（Tailwind v4），lucide 图标。全部用 `src/renderer/mock/` 假数据，未接入其他模块。

- `pnpm build`：tsc 类型构建（根目录 `tsc -b` 会走到）
- `pnpm build:app`：vite 打包渲染进程到 `dist-renderer/`，主进程和 preload 到 `dist-electron/`
- `pnpm dev`：开发模式（需要 Electron 二进制；安装时可用 `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 跳过下载，只做构建和测试）
