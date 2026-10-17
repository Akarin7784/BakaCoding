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
      main: { entry: "src/electron/main.ts", vite: { build: { outDir: "dist-electron" } } },
      preload: {
        input: "src/electron/preload.ts",
        vite: { build: { outDir: "dist-electron" } },
      },
    }),
  ],
  build: { outDir: "dist-renderer" },
});
