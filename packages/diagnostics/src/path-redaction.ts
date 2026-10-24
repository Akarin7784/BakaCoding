import { homedir } from "node:os";

/**
 * T-146：诊断包里所有字符串（值和键名，含 trace_id 这类 id 字段）的绝对路径和 home 目录脱敏。
 * 在模块 3 的 redact(…, "full") 之后执行（它只认 /home/<u>、/Users/<u>、C:\Users\<u> 和 ~），
 * 这里补上任意绝对路径。规则都是线性的；路径遇到空白、引号、括号、逗号、分号等就截止，
 * 因此带空格的路径只遮到第一个空格前（空格后的片段不再以 / 开头，不算路径）。
 *
 * 不误伤：相对片段 `a/b`、`./x`、`../x`，日期 `2026/10/24`，分数 `1/2`，`//` 注释，
 * 以及 `https://…` 这类网络 URL（:// 后面不当本地路径处理，保持原有行为；其中 /home/<u> 仍由模块 3 遮）。
 * `/dev/null` 是 diff 头的固定写法，不遮。
 */

export const PATH_RULES = [
  "home_dir",
  "file_url",
  "unc_path",
  "windows_path",
  "tilde_path",
  "abs_path",
] as const;
export type PathRule = (typeof PATH_RULES)[number];

const STOP = String.raw`\s"'\x60<>()\[\]{},;|`;
const SEG = `[^${STOP}]*`;

const RES: Record<Exclude<PathRule, "home_dir">, RegExp> = {
  // file:// URL 整条遮掉（file:/x 单斜杠形式也算）。
  file_url: new RegExp(String.raw`(?<![\p{L}\p{N}_])file:\/{1,3}${SEG}`, "giu"),
  // UNC：\\server\share…，前面不是反斜杠。
  unc_path: new RegExp(String.raw`(?<!\\)\\\\[^\\${STOP}]+\\${SEG}`, "gu"),
  // Windows 盘符：C:\… 或 C:/…，盘符前面不是字母数字（https:// 的 s 前面是 p，不会命中）。
  windows_path: new RegExp(String.raw`(?<![\p{L}\p{N}_])[A-Za-z]:[\\/]${SEG}`, "gu"),
  // ~/…
  tilde_path: new RegExp(String.raw`(?<![\p{L}\p{N}_~])~[\\/]${SEG}`, "gu"),
  // POSIX 绝对路径：/ 前面不是字母数字、_ . / \ ~ ]（`[REDACTED:home_path]/logs` 剩下的是 home 内相对部分，保持原样），/ 后面紧跟路径字符（排除 // 和「/ 空格」）。
  abs_path: new RegExp(String.raw`(?<![\p{L}\p{N}_.\/\\~\]])\/[\p{L}\p{N}._~@%+=-]${SEG}`, "gu"),
};

const KEEP = new Set(["/dev/null"]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** home 目录的字面值（正反斜杠两种写法），太短（如 "/"）时不用。 */
function homeVariants(home: string): string[] {
  if (home.replace(/[\\/]+$/, "").length < 2) return [];
  const h = home.replace(/[\\/]+$/, "");
  return [...new Set([h, h.replace(/\\/g, "/"), h.replace(/\//g, "\\")])].sort(
    (a, b) => b.length - a.length,
  );
}

export interface PathRedactResult {
  text: string;
  report: Partial<Record<PathRule, number>>;
}

/** 对一段文本做路径脱敏；`home` 默认取运行时 os.homedir()，测试可注入。`rules` 只给反向检查用。 */
export function redactPaths(
  text: string,
  opts: { home?: string; rules?: readonly PathRule[] } = {},
): PathRedactResult {
  const rules = new Set(opts.rules ?? PATH_RULES);
  const report: Partial<Record<PathRule, number>> = {};
  const hit = (r: PathRule) => (report[r] = (report[r] ?? 0) + 1);
  let out = text;
  if (rules.has("home_dir")) {
    const vs = homeVariants(opts.home ?? safeHomedir());
    if (vs.length > 0) {
      const re = new RegExp(vs.map(escapeRe).join("|"), "g");
      out = out.replace(re, () => {
        hit("home_dir");
        return "[REDACTED:home_dir]";
      });
    }
  }
  for (const name of PATH_RULES) {
    if (name === "home_dir" || !rules.has(name)) continue;
    out = out.replace(RES[name], (m) => {
      if (KEEP.has(m)) return m;
      hit(name);
      return `[REDACTED:${name}]`;
    });
  }
  return { text: out, report };
}

function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return "";
  }
}
