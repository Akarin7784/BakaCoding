// T-072：上次导入的仓库路径，存在 Electron userData（Windows 为 %APPDATA%\BakaCoding）下。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const REPO_STORE_FILE = "desktop-state.json";

export function readLastRepo(userData: string): string | undefined {
  try {
    const v = JSON.parse(readFileSync(path.join(userData, REPO_STORE_FILE), "utf8")) as unknown;
    const r = (v as { last_repo?: unknown } | null)?.last_repo;
    return typeof r === "string" && r ? r : undefined;
  } catch {
    return undefined;
  }
}

export function writeLastRepo(userData: string, repo: string): void {
  mkdirSync(userData, { recursive: true });
  writeFileSync(
    path.join(userData, REPO_STORE_FILE),
    `${JSON.stringify({ last_repo: repo }, null, 2)}\n`,
  );
}
