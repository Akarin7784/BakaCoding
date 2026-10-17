import { randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";
import { chmod, mkdir, open, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { minimatch } from "minimatch";
import type { PermissionList } from "@bakacoding/types";
import {
  FsToolError,
  assertAllowed,
  isProtectedPath,
  isUnsafeGlob,
  permissionFor,
  protectedError,
  relInside,
  resolveInWorkspace,
  type ResolvedPath,
} from "./guard.js";
import {
  defaultPermissionRegistry,
  requestWriteScope,
  type PermissionRegistry,
  type ScopeRequestOptions,
} from "./permissions.js";

/** 与 5 的 `ToolResult` 同形：失败带 FS_* 错误码，原样交还模型。 */
export type ToolResult =
  { ok: true; output: string } | { ok: false; code: string; message: string };

export const FILE_TOOL_NAMES = ["read", "write", "edit", "glob", "grep"] as const;
export type FileToolName = (typeof FILE_TOOL_NAMES)[number];
export type FileTools = Record<FileToolName, (input: unknown) => Promise<ToolResult>>;

export interface CreateToolsOptions {
  ticket_id: string;
  worktree_path: string;
  /** 初始权限清单，登记进 `registry`；之后 `applyPermissions` 可整份替换。 */
  permission_list: PermissionList;
  /** 权限登记表，默认进程内共享的 `defaultPermissionRegistry`（`applyPermissions` 作用于它）。 */
  registry?: PermissionRegistry;
  /**
   * 越界写申请：给了才在写被权限清单拒绝时发 `write_scope_requested` 并等批复；
   * 不给就直接返回 FS_PERMISSION_DENIED。受保护路径和工作区外路径从不申请。
   */
  scope_requests?: ScopeRequestOptions;
  /** grep 一次调用的总时长上限，默认 GREP_TIMEOUT_MS。 */
  grep_timeout_ms?: number;
}

export interface ToolDefinition {
  name: FileToolName;
  description: string;
  input_schema: Record<string, unknown>;
}

/** read 默认 / 最多返回的行数（同 harness READ_LIMIT）。 */
export const READ_LIMIT = 2000;
/** 单行最多返回的字符数，超出截断（同 harness READ_MAX_LINE_LENGTH）。 */
export const READ_MAX_LINE_LENGTH = 2000;
/** 一次 read 选中行的字节上限（同 harness READ_MAX_BYTES）。 */
export const READ_MAX_BYTES = 50 * 1024;
/** glob 最多返回的文件数。 */
export const GLOB_LIMIT = 100;
/** grep 最多返回的匹配行数。 */
export const GREP_LIMIT = 250;
/** grep 正则的最大长度（字符）。 */
export const GREP_PATTERN_MAX_LENGTH = 1000;
/** grep 一次调用的总时长上限：正则在独立线程里跑，超时直接终止线程，防灾难性回溯卡死进程。 */
export const GREP_TIMEOUT_MS = 10_000;
/** read / write / edit / grep 处理的单文件大小上限。 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** glob / grep 一次最多遍历的条目数，防止扫到巨型目录卡死。 */
export const WALK_LIMIT = 50_000;

/**
 * 五个文件工具的定义（名称、参数与 DeepSeek Harness dsh-v0.2.1-alpha.5 完整模式一致），
 * 由 5 放进公共前缀；内容是常量，逐字节稳定，并且整棵深冻结（改任何一层都会在严格模式下抛 TypeError）。
 */
export const FILE_TOOL_DEFINITIONS: readonly ToolDefinition[] = deepFreeze<ToolDefinition[]>([
  {
    name: "read",
    description:
      "Read a text file in the workspace. Returns numbered lines (`N: text`). Use offset/limit to page through large files. A file must be read before it can be modified with write or edit.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path relative to the workspace root." },
        offset: {
          type: "integer",
          minimum: 1,
          description: "1-based line number to start from. Defaults to 1.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: READ_LIMIT,
          description: `Maximum number of lines to return. Defaults to ${READ_LIMIT}.`,
        },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  {
    name: "write",
    description:
      "Write a whole file in the workspace, creating it (and missing parent directories) if needed. Overwriting an existing file requires reading it first; fails if the file changed since it was read.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path relative to the workspace root." },
        content: { type: "string", description: "The complete new file content." },
      },
      required: ["file_path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit",
    description:
      "Replace an exact literal string in a file that has been read. old_string must match exactly once unless replace_all is true; no fuzzy matching. Line endings are compared as LF and the file's original line-ending style is kept.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path relative to the workspace root." },
        old_string: { type: "string", description: "Exact text to replace." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: {
          type: "boolean",
          description: "Replace every occurrence. Defaults to false.",
        },
      },
      required: ["file_path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "glob",
    description: `Find files by glob pattern (e.g. "src/**/*.ts"). A pattern without "/" matches file names at any depth. Returns up to ${GLOB_LIMIT} paths relative to the workspace root, most recently modified first.`,
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, relative to path." },
        path: {
          type: "string",
          description: "Directory to search, relative to the workspace root. Defaults to the root.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "grep",
    description: `Search file contents with a regular expression (JavaScript syntax, matched per line). Returns up to ${GREP_LIMIT} matching lines grouped by file, with line numbers. Binary files are skipped.`,
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        path: {
          type: "string",
          description:
            "File or directory to search, relative to the workspace root. Defaults to the root.",
        },
        include: {
          type: "string",
          description: 'Only search files matching this glob (e.g. "*.ts").',
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
]);

/** 递归冻结（含 input_schema 里的每一层）：公共前缀的字节不能被任何调用方改掉。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

const NOT_OBSERVED = (p: string): string =>
  `cannot modify "${p}": file has not been read — read the file, then retry`;
const STALE_SUFFIX = " — re-read the file, then retry";
const staleWrite = (p: string): FsToolError =>
  new FsToolError(
    `cannot write "${p}": file changed since it was read${STALE_SUFFIX}`,
    "FS_STALE_VERSION",
  );
const staleEdit = (p: string): FsToolError =>
  new FsToolError(
    `cannot edit "${p}": file changed since it was read${STALE_SUFFIX}`,
    "FS_STALE_VERSION",
  );

type Input = Record<string, unknown>;

function asInput(input: unknown): Input {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new FsToolError("tool input must be a JSON object", "FS_INVALID_INPUT");
  }
  return input as Input;
}

function optPositiveInt(v: unknown, name: string, dflt: number): number {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new FsToolError(`${name} must be a positive integer`, "FS_INVALID_INPUT");
  }
  return v;
}

/** 版本号同 harness：`dev:ino:size:mtimeNs:ctimeNs`（bigint stat）。 */
async function versionOf(abs: string): Promise<string | null> {
  try {
    const s = await stat(abs, { bigint: true });
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function truncateLine(line: string): string {
  return line.length > READ_MAX_LINE_LENGTH
    ? `${line.substring(0, READ_MAX_LINE_LENGTH)}... (line truncated to ${READ_MAX_LINE_LENGTH} chars)`
    : line;
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** 原子写：同目录临时文件写完再 rename；已存在的文件保留权限位。失败时目标文件不动。 */
async function atomicWrite(abs: string, data: string, mode?: number): Promise<void> {
  const tmp = join(
    dirname(abs),
    `.${basename(abs)}.bakacoding-${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    const fh = await open(tmp, "wx", 0o644);
    try {
      await fh.writeFile(data, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (mode !== undefined) await chmod(tmp, mode & 0o7777);
    await rename(tmp, abs);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

async function readText(
  target: ResolvedPath,
): Promise<{ text: string; version: string; mode: number }> {
  const fh = await open(target.abs, "r");
  try {
    const s = await fh.stat({ bigint: true });
    if (!s.isFile()) {
      throw new FsToolError(
        s.isDirectory()
          ? `"${target.display}" is a directory — use glob to list files`
          : `"${target.display}" is not a regular file`,
        "FS_NOT_A_FILE",
      );
    }
    if (s.size > BigInt(MAX_FILE_BYTES)) {
      throw new FsToolError(
        `"${target.display}" is larger than ${MAX_FILE_BYTES} bytes`,
        "FS_FILE_TOO_LARGE",
      );
    }
    const buf = await fh.readFile();
    if (isBinary(buf)) throw new FsToolError(`"${target.display}" is a binary file`, "FS_NOT_TEXT");
    return {
      text: buf.toString("utf8"),
      version: `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`,
      mode: Number(s.mode),
    };
  } finally {
    await fh.close();
  }
}

interface WalkedFile {
  /** 相对工作区根的路径（经过的是真实目录，文件符号链接保留链接名）。 */
  rel: string;
  abs: string;
}

/**
 * 遍历目录：不跟随目录符号链接；文件符号链接只在目标仍在工作区内时收录；
 * 跳过受保护路径和权限清单拒绝的文件（链接路径和真实路径都判）。
 */
async function walk(
  root: string,
  start: ResolvedPath,
  list: PermissionList,
): Promise<{ files: WalkedFile[]; capped: boolean }> {
  const files: WalkedFile[] = [];
  let visited = 0;
  const stack: Array<{ abs: string; rel: string }> = [{ abs: start.abs, rel: start.realRel }];
  while (stack.length > 0) {
    const dir = stack.pop() as { abs: string; rel: string };
    let entries;
    try {
      entries = await readdir(dir.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    for (const e of entries) {
      if (++visited > WALK_LIMIT) return { files, capped: true };
      const rel = dir.rel === "" ? e.name : `${dir.rel}/${e.name}`;
      // 目录按写入规则判（.env.example 目录也拒），文件按只读规则判（.env.example 文件可列出、可搜索）
      if (isProtectedPath(rel, e.isDirectory() ? "rw" : "ro")) continue;
      const abs = join(dir.abs, e.name);
      if (e.isDirectory()) {
        stack.push({ abs, rel });
      } else if (e.isFile()) {
        if (permissionFor(list, rel) !== "deny") files.push({ rel, abs });
      } else if (e.isSymbolicLink()) {
        try {
          const target = await realpath(abs);
          const r = relInside(root, target);
          if (r === null || r === "" || isProtectedPath(r, "ro")) continue;
          if (!(await stat(target)).isFile()) continue;
          if (permissionFor(list, rel) === "deny" || permissionFor(list, r) === "deny") continue;
          files.push({ rel, abs: target });
        } catch {
          continue;
        }
      }
    }
  }
  return { files, capped: false };
}

/**
 * 独立线程里的正则匹配：线程按需启动、每次 grep 一个；从第一次匹配起计总时长，超时直接 terminate，
 * 灾难性回溯只会卡住这个线程，不会卡住主进程。代码以字符串内联（eval），不依赖构建产物路径。
 */
const GREP_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const re = new RegExp(workerData.pattern);
parentPort.on("message", (m) => {
  const hits = [];
  for (let i = 0; i < m.lines.length && hits.length < m.max; i++) if (re.test(m.lines[i])) hits.push(i);
  parentPort.postMessage(hits);
});
`;

class GrepMatcher {
  private worker: Worker | undefined;
  private deadline = 0;
  constructor(
    private readonly pattern: string,
    private readonly timeoutMs: number,
  ) {}

  private timeoutError(): FsToolError {
    return new FsToolError(
      `grep pattern took longer than ${this.timeoutMs} ms and was stopped — simplify the regular expression (avoid nested quantifiers such as (a+)+) or narrow path / include`,
      "FS_GREP_TIMEOUT",
    );
  }

  /** 返回匹配的行下标（最多 max 个，升序）。 */
  async match(lines: readonly string[], max: number): Promise<number[]> {
    if (lines.length === 0 || max <= 0) return [];
    if (!this.worker) {
      this.worker = new Worker(GREP_WORKER_SOURCE, {
        eval: true,
        workerData: { pattern: this.pattern },
      });
      this.deadline = Date.now() + this.timeoutMs;
    }
    const worker = this.worker;
    const left = this.deadline - Date.now();
    if (left <= 0) throw this.timeoutError();
    return await new Promise<number[]>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", onError);
      };
      const onMessage = (hits: number[]): void => {
        cleanup();
        resolve(hits);
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(new FsToolError(`grep failed: ${err.message}`, "FS_IO_ERROR"));
      };
      const timer = setTimeout(() => {
        cleanup();
        void worker.terminate();
        this.worker = undefined;
        reject(this.timeoutError());
      }, left);
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.postMessage({ lines, max });
    });
  }

  async close(): Promise<void> {
    const w = this.worker;
    this.worker = undefined;
    if (w) await w.terminate();
  }
}

function compileGlob(pattern: string): (rel: string) => boolean {
  const matchBase = !pattern.includes("/");
  return (rel) => minimatch(rel, pattern, { dot: true, matchBase });
}

/**
 * 模块 4 的五个受限文件工具（对齐 DeepSeek Harness 完整模式）。
 * - 每次 createTools 一套独立的「已读版本」记录：已存在的文件先读后写，读后被改报 FS_STALE_VERSION。
 * - 路径一律相对 worktree_path；绝对路径、`..` 越界、经符号链接逃出工作区都拒绝（FS_OUTSIDE_WORKSPACE）。
 * - `.git`、`.env` 类、私钥类文件永不放行（FS_PROTECTED_PATH），权限清单给 rw 也不行。
 * - 权限清单后条覆盖前条，未匹配即拒绝（FS_PERMISSION_DENIED）；glob / grep 结果里直接跳过被拒文件。
 * - 失败时文件不动；写入走同目录临时文件 + rename。
 * - 不提供 shell、网络、git。越界写：配了 scope_requests 就发「需要扩大写入范围」等批复，否则直接 FS_PERMISSION_DENIED。
 * - 权限清单登记在 registry 里，`applyPermissions(ticket_id, list)` 整份替换后立刻生效。
 * - grep 的正则在独立线程里跑，总时长超过 grep_timeout_ms 就终止线程并报 FS_GREP_TIMEOUT。
 */
export function createTools(opts: CreateToolsOptions): FileTools {
  const registry = opts.registry ?? defaultPermissionRegistry;
  registry.applyPermissions(opts.ticket_id, opts.permission_list);
  // 每次判定都取登记表里的当前清单：applyPermissions / 批准的范围立刻生效
  const perms = (): PermissionList => registry.get(opts.ticket_id) ?? [];

  /**
   * 写入判定：被权限清单拒绝（FS_PERMISSION_DENIED）且配了 scope_requests 时，
   * 发「需要扩大写入范围」并等批复；批准后把范围以 rw 追加到清单末尾再判一次，拒绝或超时返回 FS_PERMISSION_DENIED。
   */
  const ensureWritable = async (target: ResolvedPath): Promise<void> => {
    try {
      assertAllowed(perms(), target, "rw");
      return;
    } catch (err) {
      if (
        !(err instanceof FsToolError) ||
        err.code !== "FS_PERMISSION_DENIED" ||
        !opts.scope_requests
      )
        throw err;
    }
    // 目标路径已规范化，一般都安全；文件名本身带 `..` 等不合规时不发申请，直接拒绝
    const scope = [...new Set([target.display, target.realRel])].filter((g) => !isUnsafeGlob(g));
    if (scope.length === 0) {
      throw new FsToolError(
        `writing "${target.display}" needs a wider write scope, but the path cannot be expressed as a safe scope`,
        "FS_PERMISSION_DENIED",
      );
    }
    const decision = await requestWriteScope(
      opts.scope_requests,
      opts.ticket_id,
      scope,
      `write "${target.display}" is outside the current write scope`,
    );
    if (!decision.granted) {
      throw new FsToolError(
        `writing "${target.display}" needs a wider write scope and the request was denied: ${decision.reason}`,
        "FS_PERMISSION_DENIED",
      );
    }
    registry.grant(opts.ticket_id, decision.granted_scope);
    assertAllowed(perms(), target, "rw");
  };
  const observed = new Map<string, string>();
  let rootP: Promise<string> | undefined;
  const root = (): Promise<string> => (rootP ??= realpath(opts.worktree_path));

  const wrap =
    (fn: (input: Input, root: string) => Promise<string>) =>
    async (input: unknown): Promise<ToolResult> => {
      let r = "";
      try {
        r = await root();
        return { ok: true, output: await fn(asInput(input), r) };
      } catch (err) {
        if (err instanceof FsToolError) return { ok: false, code: err.code, message: err.message };
        const e = err as NodeJS.ErrnoException;
        // 不把宿主机上的工作区绝对路径透给模型。
        const msg = String(e?.message ?? err)
          .split(r || "\0")
          .join(".");
        return {
          ok: false,
          code: e?.code === "ENOENT" ? "FS_NOT_FOUND" : "FS_IO_ERROR",
          message: msg,
        };
      }
    };

  const read = wrap(async (input, r) => {
    const target = await resolveInWorkspace(r, input.file_path);
    assertAllowed(perms(), target, "ro");
    const offset = optPositiveInt(input.offset, "offset", 1);
    const limit = Math.min(optPositiveInt(input.limit, "limit", READ_LIMIT), READ_LIMIT);
    if (!target.exists) throw new FsToolError(`"${target.display}" not found`, "FS_NOT_FOUND");
    const { text, version } = await readText(target);
    const all = splitLines(text);
    if (offset > all.length && !(all.length === 0 && offset === 1)) {
      throw new FsToolError(
        `offset ${offset} is out of range for "${target.display}" (${all.length} lines)`,
        "FS_NOT_FOUND",
      );
    }
    const out: string[] = [];
    let bytes = 0;
    let cappedByBytes = false;
    for (let i = offset - 1; i < all.length && out.length < limit; i++) {
      const line = `${i + 1}: ${truncateLine(all[i] as string)}`;
      const size = Buffer.byteLength(line, "utf8") + 1;
      if (bytes + size > READ_MAX_BYTES && out.length > 0) {
        cappedByBytes = true;
        break;
      }
      bytes += size;
      out.push(line);
    }
    observed.set(target.abs, version);
    const endLine = offset + out.length - 1;
    let footer: string;
    if (cappedByBytes) {
      footer = `(Output capped. Showing lines ${offset}-${endLine}. Use offset=${endLine + 1} to continue.)`;
    } else if (endLine < all.length) {
      footer = `(Showing lines ${offset}-${endLine} of ${all.length}. Use offset=${endLine + 1} to continue.)`;
    } else {
      footer = `(End of file - total ${all.length} lines)`;
    }
    const body = out.length > 0 ? `${out.join("\n")}\n\n${footer}` : footer;
    return `<path>${target.display}</path>\n<type>file</type>\n<content>\n${body}\n</content>`;
  });

  const write = wrap(async (input, r) => {
    const target = await resolveInWorkspace(r, input.file_path);
    if (typeof input.content !== "string") {
      throw new FsToolError("content must be a string", "FS_INVALID_INPUT");
    }
    await ensureWritable(target);
    const content = input.content;
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      throw new FsToolError(`content is larger than ${MAX_FILE_BYTES} bytes`, "FS_FILE_TOO_LARGE");
    }
    const seen = observed.get(target.abs);
    let mode: number | undefined;
    if (target.exists) {
      const s = await stat(target.abs);
      if (!s.isFile()) {
        throw new FsToolError(`"${target.display}" is not a regular file`, "FS_NOT_A_FILE");
      }
      if (seen === undefined)
        throw new FsToolError(NOT_OBSERVED(target.display), "FS_NOT_OBSERVED");
      if ((await versionOf(target.abs)) !== seen) throw staleWrite(target.display);
      mode = s.mode;
    } else if (seen !== undefined) {
      throw new FsToolError(
        `cannot write "${target.display}": file no longer exists${STALE_SUFFIX}`,
        "FS_STALE_VERSION",
      );
    }
    await mkdir(dirname(target.abs), { recursive: true });
    // 父目录建好后再按真实路径确认一次没跑出工作区（防止中途被换成符号链接）。
    if (relInside(r, await realpath(dirname(target.abs))) === null) {
      throw new FsToolError(
        `"${target.display}" resolves to a location outside the workspace`,
        "FS_OUTSIDE_WORKSPACE",
      );
    }
    if (target.exists && (await versionOf(target.abs)) !== seen) throw staleWrite(target.display);
    await atomicWrite(target.abs, content, mode);
    observed.set(target.abs, (await versionOf(target.abs)) as string);
    const lines = splitLines(content).length;
    return `${target.exists ? "Overwrote" : "Created"} "${target.display}" (${lines} lines)`;
  });

  const edit = wrap(async (input, r) => {
    const target = await resolveInWorkspace(r, input.file_path);
    const { old_string, new_string } = input;
    const replaceAll = input.replace_all ?? false;
    if (typeof new_string !== "string") {
      throw new FsToolError("new_string must be a string", "FS_INVALID_INPUT");
    }
    if (typeof replaceAll !== "boolean") {
      throw new FsToolError("replace_all must be a boolean", "FS_INVALID_INPUT");
    }
    await ensureWritable(target);
    const seen = observed.get(target.abs);
    if (!target.exists) {
      if (seen !== undefined) throw staleEdit(target.display);
      throw new FsToolError(`cannot edit "${target.display}": not found`, "FS_NOT_FOUND");
    }
    if (seen === undefined) throw new FsToolError(NOT_OBSERVED(target.display), "FS_NOT_OBSERVED");
    const { text, version, mode } = await readText(target);
    if (version !== seen) throw staleEdit(target.display);
    if (typeof old_string !== "string" || old_string.length === 0) {
      throw new FsToolError("old_string must be a non-empty string", "FS_EDIT_NOT_FOUND");
    }
    const crlf = text.includes("\r\n");
    const lf = text.replace(/\r\n/g, "\n");
    const oldLf = old_string.replace(/\r\n/g, "\n");
    const newLf = new_string.replace(/\r\n/g, "\n");
    if (oldLf === newLf) {
      throw new FsToolError("old_string and new_string are identical", "FS_INVALID_INPUT");
    }
    const n = countOccurrences(lf, oldLf);
    if (n === 0) {
      throw new FsToolError(`old_string was not found in "${target.display}"`, "FS_EDIT_NOT_FOUND");
    }
    if (n > 1 && !replaceAll) {
      throw new FsToolError(
        `old_string matched ${n} times in "${target.display}"; provide a more specific old_string or set replace_all to true`,
        "FS_AMBIGUOUS_EDIT",
      );
    }
    let next: string;
    if (replaceAll) {
      next = lf.split(oldLf).join(newLf);
    } else {
      const i = lf.indexOf(oldLf);
      next = lf.slice(0, i) + newLf + lf.slice(i + oldLf.length);
    }
    if (crlf) next = next.replace(/\n/g, "\r\n");
    if ((await versionOf(target.abs)) !== seen) throw staleEdit(target.display);
    await atomicWrite(target.abs, next, mode);
    observed.set(target.abs, (await versionOf(target.abs)) as string);
    const count = replaceAll ? n : 1;
    return `Edited "${target.display}": replaced ${count} occurrence${count === 1 ? "" : "s"}`;
  });

  const resolveSearchRoot = async (r: string, p: unknown): Promise<ResolvedPath> => {
    const target = await resolveInWorkspace(r, p ?? ".", "path");
    if (isProtectedPath(target.display) || isProtectedPath(target.realRel)) {
      throw protectedError(target.display);
    }
    if (!target.exists) throw new FsToolError(`"${target.display}" not found`, "FS_NOT_FOUND");
    return target;
  };

  const glob = wrap(async (input, r) => {
    if (typeof input.pattern !== "string" || input.pattern.length === 0) {
      throw new FsToolError("pattern must be a non-empty string", "FS_INVALID_INPUT");
    }
    const dir = await resolveSearchRoot(r, input.path);
    if (!(await stat(dir.abs)).isDirectory()) {
      throw new FsToolError(`"${dir.display}" is not a directory`, "FS_NOT_A_DIRECTORY");
    }
    const match = compileGlob(input.pattern.replace(/^\.\//, ""));
    const { files, capped } = await walk(r, dir, perms());
    const prefix = dir.realRel === "" ? "" : `${dir.realRel}/`;
    const hits: Array<{ rel: string; mtime: number }> = [];
    for (const f of files) {
      if (!match(f.rel.slice(prefix.length))) continue;
      hits.push({ rel: f.rel, mtime: (await stat(f.abs)).mtimeMs });
    }
    hits.sort((a, b) => b.mtime - a.mtime || (a.rel < b.rel ? -1 : 1));
    if (hits.length === 0) {
      return capped
        ? `No files found (search stopped after ${WALK_LIMIT} entries)`
        : "No files found";
    }
    const notes: string[] = [];
    if (hits.length > GLOB_LIMIT) {
      notes.push(
        `(Showing first ${GLOB_LIMIT} of ${hits.length} files. Narrow the pattern or path to see more.)`,
      );
    }
    if (capped)
      notes.push(`(Search stopped after ${WALK_LIMIT} entries; results may be incomplete.)`);
    const shown = hits.slice(0, GLOB_LIMIT).map((h) => h.rel);
    return [shown.join("\n"), ...notes].join("\n\n");
  });

  const grep = wrap(async (input, r) => {
    if (typeof input.pattern !== "string" || input.pattern.length === 0) {
      throw new FsToolError("pattern must be a non-empty string", "FS_INVALID_INPUT");
    }
    if (input.pattern.length > GREP_PATTERN_MAX_LENGTH) {
      throw new FsToolError(
        `pattern is longer than ${GREP_PATTERN_MAX_LENGTH} characters`,
        "FS_INVALID_INPUT",
      );
    }
    try {
      // 只在这里检查语法；真正的匹配在独立线程里跑
      new RegExp(input.pattern);
    } catch (err) {
      throw new FsToolError(
        `invalid regular expression: ${(err as Error).message}`,
        "FS_INVALID_INPUT",
      );
    }
    if (
      input.include !== undefined &&
      input.include !== null &&
      (typeof input.include !== "string" || input.include === "")
    ) {
      throw new FsToolError("include must be a non-empty string", "FS_INVALID_INPUT");
    }
    const include = typeof input.include === "string" ? compileGlob(input.include) : () => true;
    const start = await resolveSearchRoot(r, input.path);
    let files: WalkedFile[];
    let capped = false;
    const isDir = (await stat(start.abs)).isDirectory();
    if (isDir) {
      ({ files, capped } = await walk(r, start, perms()));
      files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    } else {
      assertAllowed(perms(), start, "ro");
      files = [{ rel: start.display, abs: start.abs }];
    }
    const prefix = start.realRel === "" ? "" : `${start.realRel}/`;
    const groups: string[] = [];
    let total = 0;
    let more = false;
    const matcher = new GrepMatcher(input.pattern, opts.grep_timeout_ms ?? GREP_TIMEOUT_MS);
    try {
      for (const f of files) {
        const relToStart = isDir ? f.rel.slice(prefix.length) : posix.basename(f.rel);
        if (!include(relToStart)) continue;
        let buf: Buffer;
        try {
          if ((await stat(f.abs)).size > MAX_FILE_BYTES) continue;
          const fh = await open(f.abs, "r");
          try {
            buf = await fh.readFile();
          } finally {
            await fh.close();
          }
        } catch {
          continue;
        }
        if (isBinary(buf)) continue;
        const lines = splitLines(buf.toString("utf8"));
        const hits: string[] = [];
        // 多要一条，用来判断是否还有更多匹配
        for (const i of await matcher.match(lines, GREP_LIMIT - total + 1)) {
          if (total >= GREP_LIMIT) {
            more = true;
            break;
          }
          hits.push(`  ${i + 1}: ${truncateLine(lines[i] as string)}`);
          total++;
        }
        if (hits.length > 0) groups.push(`${f.rel}\n${hits.join("\n")}`);
        if (more) break;
      }
    } finally {
      await matcher.close();
    }
    if (groups.length === 0) {
      return capped
        ? `No matches found (search stopped after ${WALK_LIMIT} entries)`
        : "No matches found";
    }
    const notes: string[] = [];
    if (more) {
      notes.push(
        `(Showing first ${GREP_LIMIT} matches. Narrow the pattern, path or include to see more.)`,
      );
    }
    if (capped)
      notes.push(`(Search stopped after ${WALK_LIMIT} entries; results may be incomplete.)`);
    return [groups.join("\n\n"), ...notes].join("\n\n");
  });

  return { read, write, edit, glob, grep };
}
