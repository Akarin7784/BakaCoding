/**
 * T-154：路径脱敏的纯函数版本，不依赖 node（不 import node:os 等），主进程和渲染进程共用。
 * - 主进程：`path-redaction.ts` 的 `redactPaths` 只补上 `os.homedir()` 默认值后转到这里，输出与 T-146 / T-147 一致。
 * - 渲染进程：`renderer/lib/redact.ts` 直接调 `redactPathsPure`（home 传空串，`fullWidthStop: true`）。
 *
 * T-146：诊断包里所有字符串（值和键名，含 trace_id 这类 id 字段）的绝对路径和 home 目录脱敏。
 * 在模块 3 的 redact(…, "full") 之后执行（它只认 /home/<u>、/Users/<u>、C:\Users\<u> 和 ~），
 * 这里补上任意绝对路径。路径遇到空白、引号、括号、逗号、分号等截止；T-147 起空白后面的词
 * 如果还含 / 或 \ 就续接进来（见 CONT），引号里紧挨引号的路径整段遮（见 quoted）。
 *
 * 不误伤：相对片段 `a/b`、`./x`、`../x`，日期 `2026/10/24`，分数 `1/2`，`//` 注释，
 * 以及 `https://…` 这类网络 URL（:// 后面不当本地路径处理，保持原有行为；其中 /home/<u> 仍由模块 3 遮）。
 * `/dev/null` 是 diff 头的固定写法，不遮。
 *
 * T-147 已接受的三条限制（测试见 path-redaction-core.test.ts「T-147 已接受的限制」，改了行为要同步改测试和这里）：
 * 1. 句尾漏词：续接要求后面的词里还有 / 或 \，所以路径最后一段带空格且后面没有分隔符时
 *    （如句尾的 `/Volumes/Data Disk`），空格后的最后一个词（`Disk`）不会被遮。
 * 2. 窗口仍是 3 个词（MAX_GAP_WORDS）：路径后隔 4 个及以上不含分隔符的词再出现的 `x/y` 不续接，
 *    这几个词和后面的片段都原样保留。
 * 3. 引号只看紧挨：只有紧挨着开引号起头的路径才整段遮到闭引号；引号里路径前面还有别的字
 *    （如 `"见 /srv/my Disk"`）时只按上面的空格规则处理，同样会漏最后一个词。
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
type RegexRule = Exclude<PathRule, "home_dir">;

const ASCII_STOP = String.raw`\s"'\x60<>()\[\]{},;|`;
/** 全角标点（UI-05c 369e7be 的修复）：打开后路径遇到这些字符就停，中文句子里路径后面紧跟「，」「。」时不吞后文。 */
export const FULLWIDTH_STOP = "，。；：、！？（）「」『』《》“”‘’";

// 各规则在不带引号时的前置断言（与停止字符无关）。
const LEAD: Record<RegexRule, string> = {
  // file:// URL 整条遮掉（file:/x 单斜杠形式也算）。
  file_url: String.raw`(?<![\p{L}\p{N}_])`,
  // UNC：\\server\share…，前面不是反斜杠。
  unc_path: String.raw`(?<!\\)`,
  // Windows 盘符：C:\… 或 C:/…，盘符前面不是字母数字（https:// 的 s 前面是 p，不会命中）。
  windows_path: String.raw`(?<![\p{L}\p{N}_])`,
  // ~/…
  tilde_path: String.raw`(?<![\p{L}\p{N}_~])`,
  // POSIX 绝对路径：/ 前面不是字母数字、_ . / \ ~ ]（`[REDACTED:home_path]/logs` 剩下的是 home 内相对部分，保持原样），/ 后面紧跟路径字符（排除 // 和「/ 空格」）。
  abs_path: String.raw`(?<![\p{L}\p{N}_.\/\\~\]])`,
};

/** T-147：续接窗口。见文件头限制 2。 */
export const MAX_GAP_WORDS = 3;

/** 引号里的路径整段遮（引号保留）：引号紧挨着路径起头，到同一种引号为止，不跨行，最长 4096 字符。见文件头限制 3。 */
const QMAX = 4096;
function quoted(head: string): string {
  return ['"', "'", "\x60"]
    .map((q) => String.raw`(?<=${q})${head}[^${q}\n]{0,${QMAX}}(?=${q})`)
    .join("|");
}

function buildRegexes(STOP: string): Record<RegexRule, RegExp> {
  const SEG = `[^${STOP}]*`;
  // 各规则的「路径起头」部分（不含前置断言）。
  const HEAD: Record<RegexRule, string> = {
    file_url: String.raw`file:\/{1,3}`,
    unc_path: String.raw`\\\\[^\\${STOP}]+\\`,
    windows_path: String.raw`[A-Za-z]:[\\/]`,
    tilde_path: String.raw`~[\\/]`,
    abs_path: String.raw`\/[\p{L}\p{N}._~@%+=-]`,
  };
  /**
   * T-147：带空格路径的续接。路径后面隔着空格/制表符，如果在 MAX_GAP_WORDS 个不含分隔符的词以内
   * 出现一个含 / 或 \ 的词（如 `/Volumes/Data Disk/x` 的 `Data Disk/x`），就把中间这些词连同那个词并入路径一起遮；
   * 可以连续续接多段。不续接：窗口内没有分隔符、以 // 开头的词、含 :// 的词（网络 URL）、截止符和换行之后的内容。
   * 量词都有上界或互斥，仍是线性的。
   */
  const WORD_NOSEP = `[^${STOP}\\\\/]+`;
  const CONT = String.raw`(?:(?:[ \t]+${WORD_NOSEP}){0,${MAX_GAP_WORDS}}[ \t]+(?!\/\/)(?![^${STOP}]*:\/\/)[^${STOP}\\/]*[\\/]${SEG})*`;
  return Object.fromEntries(
    (Object.keys(HEAD) as RegexRule[]).map((r) => [
      r,
      new RegExp(`${quoted(HEAD[r])}|${LEAD[r]}${HEAD[r]}${SEG}${CONT}`, "giu"),
    ]),
  ) as Record<RegexRule, RegExp>;
}

const RES_ASCII = buildRegexes(ASCII_STOP);
const RES_FULLWIDTH = buildRegexes(ASCII_STOP + FULLWIDTH_STOP);

const KEEP = new Set(["/dev/null"]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** home 目录的字面值（正反斜杠两种写法），太短（如 "/"）或为空时不用。 */
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

export interface PurePathRedactOptions {
  /** home 目录，由调用方传入（主进程是 os.homedir()，渲染进程拿不到就传空串，home_dir 规则跳过）。 */
  home: string;
  /** 只给反向检查用。 */
  rules?: readonly PathRule[];
  /** 全角标点也当截止符。默认 false（主进程诊断包保持 T-147 的输出）。 */
  fullWidthStop?: boolean;
}

/** 对一段文本做路径脱敏，纯函数。 */
export function redactPathsPure(text: string, opts: PurePathRedactOptions): PathRedactResult {
  const rules = new Set(opts.rules ?? PATH_RULES);
  const res = opts.fullWidthStop ? RES_FULLWIDTH : RES_ASCII;
  const report: Partial<Record<PathRule, number>> = {};
  const hit = (r: PathRule) => (report[r] = (report[r] ?? 0) + 1);
  let out = text;
  if (rules.has("home_dir")) {
    const vs = homeVariants(opts.home);
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
    out = out.replace(res[name], (m) => {
      if (KEEP.has(m)) return m;
      hit(name);
      return `[REDACTED:${name}]`;
    });
  }
  return { text: out, report };
}
