import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Toaster } from "./components/ui/sonner";
import { themeStore } from "./lib/useTheme";
import "./index.css";

// 渲染前先按保存的偏好写上 data-theme，避免先闪一帧浅色（UI-01）。
themeStore();

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <App />
      <Toaster />
    </StrictMode>,
  );
