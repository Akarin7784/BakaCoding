// UI-07c：设置 › 预算的纯逻辑（文案、金额 / 比例换算、低于今日已花费的判断），组件和测试共用。
import { EXTERNAL_CONFIG_READONLY_HINT } from "../../shared/config-text";
export { parseBudgetUsd } from "./repoPrep";

export const BUDGET_COPY = {
  dailyLabel: "每日预算（美元，必填）",
  dailyHint: "按 UTC 自然日汇总。写进 config/models.json 的 budget.daily_micro_usd。",
  dailyInvalid: "请填一个大于 0 的金额，最多 6 位小数",
  ratioLabel: "每单上限比例",
  ratioHint: "每单上限 = 每日预算 × 比例，比例要大于 0、不超过 1。",
  ratioInvalid: "比例必须大于 0、不超过 1",
  offpeakLabel: "闲时优先",
  offpeakHint: "开启后，非紧急的单优先排到闲时（单价更低）再跑。",
  spentToday: "今天已花费",
  todayUnavailable: "后端只读，暂时取不到今天已花费。",
  belowToday: (spent: string) =>
    `每日预算低于今天已花费（${spent}）：可以保存，但保存并重载后今天就算超出预算。`,
  // UI-07d：07b / 07c 统一只读提示
  readonlyHint: EXTERNAL_CONFIG_READONLY_HINT,
} as const;

/** 微美元 → 「$1.5」这样的美元文本（去掉多余的 0，最多 6 位小数） */
export function microToUsd(micro: number): string {
  const m = Math.max(0, Math.round(micro));
  const frac = String(m % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${Math.floor(m / 1_000_000)}${frac ? `.${frac}` : ""}`;
}

/** 比例文本 → 数；空、不是有限数、≤0、>1 都是 null（拒绝 0、负数、>1、NaN） */
export function parseRatio(text: string): number | null {
  const t = text.trim();
  if (!/^\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : null;
}

/** 新的每日预算比今天已花费少：只警告，不拦保存 */
export function belowToday(daily: number | null, spent: number | null | undefined): boolean {
  return daily !== null && typeof spent === "number" && daily < spent;
}
