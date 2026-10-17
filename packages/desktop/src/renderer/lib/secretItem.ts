// UI-03b：密钥项与测试连接的界面文案和纯函数（docs/ui-design.md §4.6「密钥」、§4.1 模型配置向导）。
import type {
  DesktopProviderTestResult,
  DesktopSecretName,
  DesktopSecretStatus,
} from "../../shared/api";

export const SECRET_LABEL: Record<DesktopSecretName, string> = {
  DEEPSEEK_API_KEY: "DeepSeek 密钥",
  GITHUB_TOKEN: "GitHub 令牌",
};

export const SECRET_COPY = {
  notSet: "未设置",
  set: "已设置",
  fromSystem: "已设置（来自系统环境变量）",
  systemHint: "这个密钥来自系统环境变量，BakaCoding 不能清除；要改请在系统设置里改。",
  saveHint: "保存在当前用户的环境变量里。已打开的其他程序（如 PowerShell）要重开才能读到新值。",
  placeholder: "粘贴密钥",
  save: "保存",
  saving: "保存中…",
  clear: "清除",
  clearing: "清除中…",
  saved: "密钥已保存",
  cleared: "密钥已清除",
  saveFailed: "保存密钥失败",
  clearFailed: "清除密钥失败",
  statusFailed: "读不到密钥状态",
  ipcFailed: "和主进程通信失败，请重试",
} as const;

/**
 * 状态文字：bakacoding 来源有末 4 位时显示末 4 位；bakacoding 来源没有末 4 位（值太短，3 不记）只写「已设置」；
 * 系统来源只说来自系统环境变量（3 本来就不给末 4 位）。
 */
export function secretStatusText(s: DesktopSecretStatus | null): string {
  if (!s) return "读取中…";
  if (!s.set) return SECRET_COPY.notSet;
  if (s.source === "system") return SECRET_COPY.fromSystem;
  if (s.source === "bakacoding" && s.last4) return `${SECRET_COPY.set}（末 4 位 ${s.last4}）`;
  return SECRET_COPY.set;
}

/** 只有 BakaCoding 自己保存的才给「清除」；系统环境变量来源不给 */
export function canClearSecret(s: DesktopSecretStatus | null): boolean {
  return !!s && s.set && s.source === "bakacoding";
}

/** 微美元显示成美元（测试连接花费很小，保留 6 位小数） */
export function formatMicroUsd(micro: number): string {
  const v = Number.isFinite(micro) && micro > 0 ? micro : 0;
  return `$${(v / 1_000_000).toFixed(6)}`;
}

export const WIZARD_COPY = {
  title: "模型设置向导",
  description: "填好 DeepSeek 密钥，再测试一下能不能连上。",
  open: "模型设置向导",
  steps: ["密钥", "测试连接"] as const,
  provider: "服务商：DeepSeek",
  test: "测试连接",
  testing: "测试中…",
  testHint: "只发一个极小的请求（最多 1 个输出 token），花费计入台账，记在主管名下。",
  ok: "连接正常",
  failed: "连接失败",
  notSent: "没有发出请求",
  back: "上一步",
  next: "下一步",
  done: "完成",
  prepEntry: "设置模型",
  prepHint: "仓库准备好了。还要填好模型密钥并测试一下连接。",
} as const;

/** 测试连接结果的一句话（失败时 reason 是主进程按码给的固定中文文案，原样用） */
export function providerTestText(r: DesktopProviderTestResult): string {
  if (r.ok)
    return `${WIZARD_COPY.ok}：用时 ${Math.round(r.latency_ms)} ms，花费 ${formatMicroUsd(r.cost_micro_usd)}`;
  const status = r.code === "http_error" && r.status !== undefined ? `（HTTP ${r.status}）` : "";
  return `${r.reason}${status}`;
}

/** 这几种失败根本没发请求（预算用完、没密钥、参数不对、后端没连上） */
export function providerTestNotSent(r: DesktopProviderTestResult): boolean {
  return (
    !r.ok &&
    (r.code === "budget_exhausted" ||
      r.code === "no_secret" ||
      r.code === "invalid_target" ||
      r.code === "unavailable" ||
      r.code === "config_error")
  );
}
