import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Toaster } from "./components/ui/sonner";
import { themeStore } from "./lib/useTheme";
import { syncWindowTheme } from "./lib/windowTheme";
import "./index.css";

// 渲染前先按保存的偏好写上 data-theme，避免先闪一帧浅色（UI-01）。
// 再把偏好同步给主进程，标题栏按钮颜色跟着变（UI-02）。
syncWindowTheme(themeStore(), window.bakacoding);

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <App />
      <Toaster />
    </StrictMode>,
  );
