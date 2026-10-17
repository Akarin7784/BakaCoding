// T-040：写入范围与拆单结果的校验（主管模型输出一律按不可信输入处理）。
import { isUnsafeGlob } from "@bakacoding/workspace";
import type { TicketOrigin, TicketValidationError } from "./types.js";

/**
 * glob 特殊字符 `* ? [ ] { } ( ) ! + @`：含这些字符的条目不当作字面路径（不做「裸目录」判断），
 * 第一段含这些字符的写入范围按「可能写到整个仓库」处理。在 10 里自己定义，不从 4 引；
 * 必须与 4 的 SCOPE_WILDCARD（T-054）、8 的 SCOPE_REQUEST_WILDCARD（T-053）同一字符集，
 * 由 validate.charset.test.ts 守着。只在包内导出给测试用，不进 index.ts。
 */
export const GLOB_CHARS = /[*?[\]{}()!+@]/;

/**
 * 第一段不是字面量（含 `* ? [ ] { } ( ) ! + @`）的范围：`**`、`**\/*`、`*`、`{**,x}`、`?(**)`、`[!_]**` 等，
 * 第一段就能匹配任意顶层目录，等于可能写到整个仓库。split 单判无效；manual / test 单按整仓 `**` 处理。
 * v1 不给 `**\/package.json` 这类写法开白名单。
 */
function firstSegmentNotLiteral(glob: string): boolean {
  return GLOB_CHARS.test(glob.split("/")[0] ?? "");
}

/** 首尾空白（Unicode 空白，含全角空格、换行）：T-041b 起直接拒绝，不 trim。 */
const EDGE_WHITESPACE = /^\s|\s$/u;

export interface ValidateWriteScopeOptions {
  origin: TicketOrigin;
  /** 字面路径是否为基线上的目录；给了才判「裸目录」 */
  isDirectory?: (path: string) => boolean;
}

/**
 * 校验一张单的写入范围。
 * - split 单：必填非空；第一段不是字面量（整仓 `**`、`*`、`{**,x}` 等）无效；
 * - manual / test 单：不给，或任一条第一段不是字面量，都按 `["**"]`，`defaulted: true`（调用方发 ticket_warning）；
 * - 两者都不许：首尾带空白（T-041b，报 `write_scope_unsafe`；手动单也直接报错，不按 `**` 兜底）、以 `/` 结尾、
 *   `isUnsafeGlob` 为真、写成裸目录名（应写 `dir/**`）。
 */
export function validateWriteScope(
  scope: string[] | undefined,
  opts: ValidateWriteScopeOptions,
):
  | { ok: true; scope: string[]; defaulted: boolean }
  | { ok: false; errors: TicketValidationError[] } {
  const manual = opts.origin !== "split";
  if (scope === undefined || scope.length === 0) {
    if (manual) return { ok: true, scope: ["**"], defaulted: true };
    return {
      ok: false,
      errors: [{ code: "write_scope_missing", message: "write_scope 必填且不能为空" }],
    };
  }
  const errors: TicketValidationError[] = [];
  let whole = false;
  for (const entry of scope) {
    if (typeof entry !== "string" || entry.length === 0) {
      errors.push({ code: "write_scope_unsafe", entry: String(entry), message: "空的写入范围" });
    } else if (EDGE_WHITESPACE.test(entry)) {
      // T-041b：首尾带空白（含全是空白）直接拒绝、不 trim；要先于「第一段非字面量」判断，
      // 否则手动单的 " **" 会被当成整仓 ** 悄悄放行
      errors.push({
        code: "write_scope_unsafe",
        entry,
        message: "写入范围首尾不能有空白（空格、制表符、换行、全角空格等）；中间的空格可以保留",
      });
    } else if (entry.endsWith("/")) {
      errors.push({
        code: "write_scope_trailing_slash",
        entry,
        message: `不要写以斜杠结尾的范围，改写成 \`${entry}**\``,
      });
    } else if (isUnsafeGlob(entry)) {
      errors.push({
        code: "write_scope_unsafe",
        entry,
        message: "不安全的写入范围（含 ..、绝对路径、空段、! 或 # 开头等）",
      });
    } else if (firstSegmentNotLiteral(entry)) {
      if (manual) whole = true;
      else
        errors.push({
          code: "write_scope_whole_repo",
          entry,
          message:
            "写入范围的第一段必须是字面的目录名或文件名（不能含 * ? [ ] { } ( ) ! + @），否则可能覆盖整个仓库；写出具体目录或文件（如 `lib/**`）",
        });
    } else if (!GLOB_CHARS.test(entry) && opts.isDirectory?.(entry)) {
      errors.push({
        code: "write_scope_bare_directory",
        entry,
        message: `\`${entry}\` 是目录，改写成 \`${entry}/**\``,
      });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  if (whole) return { ok: true, scope: ["**"], defaulted: true };
  return { ok: true, scope: [...new Set(scope)], defaulted: false };
}

/** 由文件清单构造 isDirectory：某文件以 `<path>/` 开头即为目录。 */
export function directoryChecker(files: readonly string[] | undefined) {
  if (!files || files.length === 0) return undefined;
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return (p: string) => dirs.has(p);
}

/** depends_on 成环检测：返回环上的一个节点，无环返回 undefined。 */
export function findCycle(edges: ReadonlyMap<string, readonly string[]>): string | undefined {
  const state = new Map<string, 1 | 2>();
  const visit = (n: string): string | undefined => {
    const s = state.get(n);
    if (s === 2) return undefined;
    if (s === 1) return n;
    state.set(n, 1);
    for (const m of edges.get(n) ?? []) {
      if (!edges.has(m)) continue;
      const hit = visit(m);
      if (hit) return hit;
    }
    state.set(n, 2);
    return undefined;
  };
  for (const n of edges.keys()) {
    const hit = visit(n);
    if (hit) return hit;
  }
  return undefined;
}

/** 按依赖排序（依赖在前）；调用前须已确认无环。 */
export function topoOrder(edges: ReadonlyMap<string, readonly string[]>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (n: string) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const m of edges.get(n) ?? []) if (edges.has(m)) visit(m);
    out.push(n);
  };
  for (const n of edges.keys()) visit(n);
  return out;
}
