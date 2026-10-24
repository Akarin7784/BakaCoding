// UI-07a：设置 › 关于（app:about）。只给版本号、commit 和运行时版本，全部按白名单格式过滤，绝不带路径。
import type { DesktopAbout } from "../shared/api.js";

/** 构建时由 vite define 注入（vite.config.ts 取 `git rev-parse HEAD`）；tsc / 测试环境没有就是 undefined。 */
declare const __BAKACODING_COMMIT__: string | undefined;

export function buildCommit(): string | null {
  return typeof __BAKACODING_COMMIT__ === "string" ? __BAKACODING_COMMIT__ : null;
}

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;

export interface RawAbout {
  version: unknown;
  commit: unknown;
  electron?: unknown;
  chrome?: unknown;
  node?: unknown;
}

const ver = (v: unknown): string | null => (typeof v === "string" && VERSION_RE.test(v) ? v : null);

/** 白名单过滤：不像版本号 / commit 的值（比如带 / 或 \ 的路径）一律换成 null。 */
export function aboutInfo(raw: RawAbout): DesktopAbout {
  const commit =
    typeof raw.commit === "string" && COMMIT_RE.test(raw.commit.toLowerCase())
      ? raw.commit.toLowerCase()
      : null;
  return {
    version: ver(raw.version),
    commit,
    runtime: { electron: ver(raw.electron), chrome: ver(raw.chrome), node: ver(raw.node) },
  };
}
