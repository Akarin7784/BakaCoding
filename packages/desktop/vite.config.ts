// 参照 electron-vite-react 模板：vite + vite-plugin-electron（主进程 / preload）+ React 渲染进程。
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import electron from "vite-plugin-electron/simple";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    electron({
      main: {
        entry: "src/electron/main.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            // @bakacoding/storage 打包进来；原生模块不打包，运行时从本包 node_modules 加载，.node 用 nativeBinding 指定。
            rolldownOptions: { external: ["better-sqlite3"] },
          },
        },
      },
      preload: {
        input: "src/electron/preload.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            // 插件产出的 preload 是 CommonJS，用 .cjs 扩展名，才能在 sandbox 下加载。
            rolldownOptions: { output: { entryFileNames: "preload.cjs" } },
          },
        },
      },
    }),
  ],
  build: { outDir: "dist-renderer" },
});
