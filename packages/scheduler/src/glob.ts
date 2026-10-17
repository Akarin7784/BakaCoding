/** 极简 glob：`**` 跨目录、`*` 不跨 `/`、`?` 单个字符；其余字面匹配。 */
export function globToRegExp(glob: string): RegExp {
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
  return new RegExp(`^${re}$`);
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
 * 两个写入范围 glob 是否可能匹配同一个路径（T-039 写入范围锁用）。按段比较，`**` 可匹配零段或多段；
 * 同一段两边都带 `*` / `?` 时保守地算能匹配（宁可少并发，也不放两张写同一文件的单同时编码）。
 */
export function globsOverlap(a: string, b: string): boolean {
  return overlapFrom(normalizeGlob(a), 0, normalizeGlob(b), 0);
}

/**
 * glob 的一个代表路径：每段里的 `**` / `*` / `?` 换成 `x`。用来判断一条写入范围是否「落在」某个区域里
 * （如 `config/**` → `config/x` 落在独占区域 `config/**`；`src/**` → `src/x` 不落在 `** /package.json`）。
 */
export function sampleOf(glob: string): string {
  return normalizeGlob(glob)
    .map((seg) => (isGlobstar(seg) ? "x" : seg.replace(/[*?]/g, "x")))
    .join("/");
}

/** 两组 glob 是否有任意一对可能重叠。 */
export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => globsOverlap(x, y)));
}
