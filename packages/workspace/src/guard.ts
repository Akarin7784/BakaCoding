import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { minimatch } from "minimatch";
import {
  DEFAULT_PERMISSION_LEVEL,
  type PermissionList,
  type PermissionLevel,
} from "@bakacoding/types";

/** 工具层错误：code 原样交还模型（FS_* 错误码）。 */
export class FsToolError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "FsToolError";
  }
}

/**
 * 权限判定：按顺序逐条匹配，后面的条目覆盖前面的（同 .gitignore），
 * 一条都没匹配上按 DEFAULT_PERMISSION_LEVEL（deny）处理。
 * glob 相对工作区根目录，`dot: true`（点文件也能被 `**` 匹配）。
 */
export function permissionFor(list: PermissionList, rel: string): PermissionLevel {
  let level: PermissionLevel = DEFAULT_PERMISSION_LEVEL;
  for (const entry of list) {
    if (minimatch(rel, entry.glob, { dot: true })) level = entry.level;
  }
  return level;
}

const ENV_SEGMENT = /^\.env(rc)?(\..*)?$/i;
const KEY_BASENAME = /^(id_(rsa|dsa|ecdsa|ed25519)|\.netrc|\.pgpass|_netrc)$/i;
const KEY_EXT = /\.(pem|key|p12|pfx|jks|keystore)$/i;

/** 唯一的只读例外：文件名正好是 `.env.example`（大小写不敏感）。 */
const ENV_EXAMPLE = /^\.env\.example$/i;

/**
 * 外层硬边界里不放行的路径（权限清单写 rw 也不行）：
 * 任何一段是 `.git`；任何一段是 `.env` / `.env.*` / `.envrc` / `.envrc.*`（大小写不敏感，与模块 11 同规则）；
 * 私钥类文件（id_rsa 等、.netrc、.pgpass、*.pem / *.key / *.p12 / *.pfx / *.jks / *.keystore）。
 * 例外：`access` 为 "ro" 时，最后一段是 `.env.example` 且前面各段都不受保护，放行给权限清单判定（只读）；
 * 写 `.env.example` 仍然拒绝。
 */
export function isProtectedPath(rel: string, access: "ro" | "rw" = "rw"): boolean {
  if (rel === "" || rel === ".") return false;
  const segs = rel.split("/");
  const base = segs[segs.length - 1] ?? "";
  const dirs = segs.slice(0, -1);
  if (dirs.some((s) => s.toLowerCase() === ".git" || ENV_SEGMENT.test(s))) return true;
  if (access === "ro" && ENV_EXAMPLE.test(base)) return false;
  if (base.toLowerCase() === ".git" || ENV_SEGMENT.test(base)) return true;
  return KEY_BASENAME.test(base) || KEY_EXT.test(base);
}

export interface ResolvedPath {
  /** 模型给的路径规范化后的样子（相对工作区根，posix 分隔符），用于提示和权限判定。 */
  display: string;
  /** 真实路径（符号链接已解析；不存在的部分原样接在最近存在的祖先后面）。 */
  abs: string;
  /** 真实路径相对工作区根（posix），也参与权限判定，防止经符号链接绕过。 */
  realRel: string;
  exists: boolean;
}

/** p 在 root 内时返回相对路径（posix，根目录为 ""），否则 null。 */
export function relInside(root: string, p: string): string | null {
  const rel = relative(root, p);
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return sep === "/" ? rel : rel.split(sep).join("/");
}

function outside(input: string): FsToolError {
  return new FsToolError(
    `"${input}" is outside the workspace — use a path relative to the workspace root`,
    "FS_OUTSIDE_WORKSPACE",
  );
}

/**
 * 把模型给的路径解析到工作区内的真实路径。
 * 拒绝：空串、含 NUL、绝对路径（含 Windows 盘符 / UNC）、`..` 越出根目录、
 * 中间目录或文件本身是指向工作区外的符号链接、悬空符号链接。
 */
export async function resolveInWorkspace(
  root: string,
  input: unknown,
  field = "file_path",
): Promise<ResolvedPath> {
  if (typeof input !== "string" || input.length === 0) {
    throw new FsToolError(`${field} must be a non-empty string`, "FS_INVALID_INPUT");
  }
  if (input.includes("\0"))
    throw new FsToolError(`${field} contains a NUL byte`, "FS_INVALID_INPUT");
  const slashed = input.replace(/\\/g, "/");
  if (isAbsolute(input) || slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) {
    throw outside(input);
  }
  const display = posix.normalize(slashed).replace(/\/+$/, "") || ".";
  if (display === ".." || display.startsWith("../")) throw outside(input);

  const segs = display === "." ? [] : display.split("/");
  let cur = root;
  for (let i = 0; i < segs.length; i++) {
    const next = join(cur, segs[i] as string);
    let st;
    try {
      st = await lstat(next);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const abs = join(cur, ...segs.slice(i));
        const rel = relInside(root, abs);
        if (rel === null) throw outside(input);
        return { display, abs, realRel: rel, exists: false };
      }
      throw err;
    }
    if (st.isSymbolicLink()) {
      let target: string;
      try {
        target = await realpath(next);
      } catch {
        throw new FsToolError(
          `"${display}" goes through a symbolic link whose target does not exist`,
          "FS_OUTSIDE_WORKSPACE",
        );
      }
      if (relInside(root, target) === null) {
        throw new FsToolError(
          `"${display}" resolves through a symbolic link to a location outside the workspace`,
          "FS_OUTSIDE_WORKSPACE",
        );
      }
      cur = target;
    } else {
      cur = next;
    }
    if (i < segs.length - 1) {
      const real = st.isSymbolicLink() ? await lstat(cur) : st;
      if (!real.isDirectory()) {
        throw new FsToolError(`"${display}": a parent path is not a directory`, "FS_NOT_FOUND");
      }
    }
  }
  const rel = relInside(root, cur);
  if (rel === null) throw outside(input);
  return { display, abs: cur, realRel: rel, exists: true };
}

export function protectedError(display: string): FsToolError {
  return new FsToolError(
    `"${display}" is a protected path (.git, .env files and private keys are never accessible; .env.example is read-only)`,
    "FS_PROTECTED_PATH",
  );
}

/** 判定一次访问：硬边界 → 权限清单。need 为 "ro" 时 ro/rw 都放行，为 "rw" 时只放行 rw。 */
export function assertAllowed(
  list: PermissionList,
  target: Pick<ResolvedPath, "display" | "realRel">,
  need: "ro" | "rw",
): void {
  const rels = [...new Set([target.display, target.realRel])];
  if (rels.some((r) => isProtectedPath(r, need))) throw protectedError(target.display);
  for (const rel of rels) {
    const level = permissionFor(list, rel);
    if (level === "deny") {
      throw new FsToolError(
        `access to "${target.display}" is denied by the permission list`,
        "FS_PERMISSION_DENIED",
      );
    }
    if (need === "rw" && level !== "rw") {
      throw new FsToolError(
        `"${target.display}" is read-only under the permission list — writing it needs a wider write scope`,
        "FS_PERMISSION_DENIED",
      );
    }
  }
}
