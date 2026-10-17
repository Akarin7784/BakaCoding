import { isDependencyFile } from "@bakacoding/sub-agent";
import { isUnsafeGlob } from "@bakacoding/workspace";

/** 花括号展开后最多保留的模式数；超过就保守地按 `**`（匹配一切）处理。 */
export const MAX_BRACE_EXPANSIONS = 256;

/** 在 s[open] 是 `{` 时找配对的 `}`（支持嵌套）；没有返回 -1。 */
function closeOf(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/** 按顶层逗号切分花括号内部（嵌套的 `{...}` 里的逗号不算）。 */
function splitTop(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/** `{1..3}` / `{01..10..3}` / `{a..e}` 这类序列（与 minimatch 用的 brace-expansion 一致）；不是序列返回 undefined。 */
function sequence(body: string): string[] | undefined {
  const num = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(body);
  if (num) {
    const [a, b] = [Number(num[1]), Number(num[2])];
    const step = Math.max(1, Math.abs(Number(num[3] ?? 1)));
    const pad = /^-?0\d/.test(num[1]!) || /^-?0\d/.test(num[2]!);
    const width = Math.max(num[1]!.replace("-", "").length, num[2]!.replace("-", "").length);
    const out: string[] = [];
    for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? step : -step) {
      const digits = String(Math.abs(v));
      out.push((v < 0 ? "-" : "") + (pad ? digits.padStart(width, "0") : digits));
      if (out.length > MAX_BRACE_EXPANSIONS) break;
    }
    return out;
  }
  const alpha = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/.exec(body);
  if (alpha) {
    const [a, b] = [alpha[1]!.charCodeAt(0), alpha[2]!.charCodeAt(0)];
    const step = Math.max(1, Math.abs(Number(alpha[3] ?? 1)));
    const out: string[] = [];
    for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? step : -step)
      out.push(String.fromCharCode(v));
    return out;
  }
  return undefined;
}

function expandInto(glob: string, out: string[]): boolean {
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] !== "{") continue;
    const j = closeOf(glob, i);
    if (j < 0) break; // 没配对的 `{` 按字面量
    const body = glob.slice(i + 1, j);
    const parts = splitTop(body);
    const alts = parts.length > 1 ? parts : sequence(body);
    if (!alts) continue; // `{a}` / `{}`：没有逗号也不是序列，按字面量（同 minimatch），接着找后面的
    const pre = glob.slice(0, i);
    const post = glob.slice(j + 1);
    for (const alt of alts) {
      // 前缀里已确认没有可展开的花括号；alt 和 post 里的再递归展开
      if (!expandInto(pre + alt + post, out)) return false;
      if (out.length > MAX_BRACE_EXPANSIONS) return false;
    }
    return true;
  }
  out.push(glob);
  return out.length <= MAX_BRACE_EXPANSIONS;
}

/**
 * 展开 glob 里的花括号（T-048，与模块 4 用的 minimatch 语义一致）：`src/{a,b}.ts` → `src/a.ts`、`src/b.ts`，
 * 支持嵌套和 `{1..3}` / `{a..c}` 序列；`{a}`、`{}` 和没配对的 `{` 按字面量。
 * 展开结果超过 `MAX_BRACE_EXPANSIONS` 条时保守地返回 `["**"]`（写入范围锁宁可多互斥）。
 */
export function expandBraces(glob: string): string[] {
  if (!glob.includes("{")) return [glob];
  const out: string[] = [];
  if (!expandInto(glob, out)) return ["**"];
  return [...new Set(out)];
}

function braceFreeToRegExp(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return re;
}

/** 极简 glob：`**` 跨目录、`*` 不跨 `/`、`?` 单个字符、`{a,b}` 花括号展开；其余字面匹配。 */
export function globToRegExp(glob: string): RegExp {
  const alts = expandBraces(glob).map(braceFreeToRegExp);
  return new RegExp(alts.length === 1 ? `^${alts[0]}$` : `^(?:${alts.join("|")})$`);
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

const hasWildcard = (s: string): boolean => /[*?]/.test(s);

/** 一段（不含 `/`）的 glob 能否和另一段同时匹配同一个名字；两边都带通配时保守地认为能。 */
function segmentsOverlap(a: string, b: string): boolean {
  const wa = hasWildcard(a);
  const wb = hasWildcard(b);
  if (!wa && !wb) return a === b;
  if (!wa) return globToRegExp(b).test(a);
  if (!wb) return globToRegExp(a).test(b);
  return true;
}

function normalizeGlob(g: string): string[] {
  return g
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .split("/")
    .filter((s) => s !== "" && s !== ".");
}

const isGlobstar = (seg: string): boolean => seg.includes("**");

function overlapFrom(a: string[], i: number, b: string[], j: number): boolean {
  const ea = i >= a.length;
  const eb = j >= b.length;
  if (ea && eb) return true;
  if (!ea && isGlobstar(a[i]!)) {
    if (!eb && isGlobstar(b[j]!)) return true;
    // a 的 `**` 匹配零段，或吃掉 b 的一段
    return overlapFrom(a, i + 1, b, j) || (!eb && overlapFrom(a, i, b, j + 1));
  }
  if (!eb && isGlobstar(b[j]!))
    return overlapFrom(a, i, b, j + 1) || (!ea && overlapFrom(a, i + 1, b, j));
  if (ea || eb) return false;
  return segmentsOverlap(a[i]!, b[j]!) && overlapFrom(a, i + 1, b, j + 1);
}

/**
 * 写入范围 glob 是否不安全（#47）：转用模块 4 的 `isUnsafeGlob`（T-051，全项目只此一份规则），保留同名导出。
 * 这样的范围在写入范围锁里按「与所有范围重叠」处理，在独占区域判断里按落在独占区域处理。
 * @deprecated 以模块 4（`@bakacoding/workspace`）的 `isUnsafeGlob` 为准；这里只是转调，保留名字兼容已有调用方。
 */
export const isUnsafeScope: (glob: string) => boolean = isUnsafeGlob;

/**
 * 两个写入范围 glob 是否可能匹配同一个路径（T-039 写入范围锁用）。按段比较，`**` 可匹配零段或多段；
 * 同一段两边都带 `*` / `?` 时保守地算能匹配（宁可少并发，也不放两张写同一文件的单同时编码）。
 * 花括号先展开（T-048）：`src/{a,b}.ts` 与 `src/a.ts` 重叠。任一边不安全（`isUnsafeScope`，如 `src/../**`）就算重叠。
 */
export function globsOverlap(a: string, b: string): boolean {
  if (isUnsafeScope(a) || isUnsafeScope(b)) return true;
  const as = expandBraces(a).map(normalizeGlob);
  const bs = expandBraces(b).map(normalizeGlob);
  return as.some((x) => bs.some((y) => overlapFrom(x, 0, y, 0)));
}

/**
 * glob 的一个代表路径：每段里的 `**` / `*` / `?` 换成 `x`。用来判断一条写入范围是否「落在」某个区域里
 * （如 `config/**` → `config/x` 落在独占区域 `config/**`；`src/**` → `src/x` 不落在 `** /package.json`）。
 */
export function sampleOf(glob: string): string {
  return samplesOf(glob)[0]!;
}

/** 花括号展开后每个模式各取一条代表路径（T-048）。 */
export function samplesOf(glob: string): string[] {
  return expandBraces(glob).map((g) =>
    normalizeGlob(g)
      .map((seg) => (isGlobstar(seg) ? "x" : seg.replace(/[*?]/g, "x")))
      .join("/"),
  );
}

const isBareWildcard = (seg: string): boolean => /^\*+$/.test(seg);

/**
 * 写入范围 glob 是否落在独占区域（T-039 的代表路径规则，T-048 补两处）：
 * 1. 花括号展开后任一模式的代表路径匹配某个区域（`src/{a,package}.json` 也算）。
 * 2. 只看一条代表路径会漏掉「末段带通配、但能写到某个具体文件名」的范围，如 `src/**\/*.json` 能写
 *    `src/x/package.json`：区域末段是字面量文件名（`package.json`、`go.mod` 等）、范围的末段模式匹配这个文件名、
 *    整条 glob 又和区域重叠时，也算落在区域里。末段是 `*` / `**` 的目录范围（`src/**`、`src/*`）不按这条算，
 *    否则所有目录范围都会变独占；区域末段本身带通配（`*.d.ts`、`*.lock`）的仍只按代表路径判断。
 * 3. T-064：代表路径经 8 的 `isDependencyFile` 判定为依赖文件时也算独占（T-065 合入后文件名不区分大小写）；
 *    末段通配对「依赖文件名」区域的匹配同样不区分大小写。`globsOverlap` 本身不变。
 */
export function inExclusiveZone(glob: string, zones: readonly string[]): boolean {
  if (isUnsafeScope(glob)) return true;
  if (samplesOf(glob).some((p) => matchesAny(p, zones))) return true;
  // T-064 N6：写入范围的代表路径是依赖清单 / 锁文件（按 8 的 isDependencyFile；T-065 后不区分大小写）→ 独占
  if (samplesOf(glob).some((p) => isDependencyFile(p))) return true;
  const zoneTails = zones.flatMap((z) =>
    expandBraces(z).map((zz) => ({ zone: zz, tail: normalizeGlob(zz).at(-1) ?? "" })),
  );
  return expandBraces(glob).some((g) => {
    const tail = normalizeGlob(g).at(-1) ?? "";
    if (!hasWildcard(tail) || isBareWildcard(tail)) return false;
    return zoneTails.some(({ zone, tail: zt }) => {
      if (zt === "" || hasWildcard(zt)) return false;
      // 依赖文件名区域：末段不区分大小写（T-064 N6）；其余区域仍区分
      const depZone = isDependencyFile(zt);
      const ok = depZone
        ? globToRegExp(tail.toLowerCase()).test(zt.toLowerCase())
        : globToRegExp(tail).test(zt);
      return ok && globsOverlap(g, zone);
    });
  });
}

/** 两组 glob 是否有任意一对可能重叠。 */
export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => globsOverlap(x, y)));
}
