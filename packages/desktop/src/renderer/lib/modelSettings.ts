// UI-07b：设置 › 模型的纯逻辑（文案、保存结果说明），组件和测试共用。
import { EXTERNAL_CONFIG_READONLY_HINT } from "../../shared/config-text";
import type {
  DesktopConfigSource,
  DesktopModelForm,
  DesktopModelSaveFile,
  DesktopModelSaveResult,
} from "../../shared/api";

export const MODEL_FILE_LABEL: Record<DesktopModelSaveFile, string> = {
  models: "config/models.json",
  pricing: "config/pricing.json",
};

export const MODEL_COPY = {
  sourceRepo: "配置来源：仓库里的 config/models.json",
  sourceArg: "配置来源：启动参数 --config 指定的文件（只读）",
  sourceEnv: "配置来源：环境变量 BAKACODING_CONFIG 指定的文件（只读）",
  // UI-07d：07b / 07c 统一只读提示
  readonlyHint: EXTERNAL_CONFIG_READONLY_HINT,
  save: "保存并重载",
  saveQueued: "保存，等当前单跑完后重载",
  confirmQueued: (n: number) =>
    `有 ${n} 张单（或主管对话）在跑：文件现在写，重载等它们跑完再自动执行。`,
  confirm: "确认保存",
  cancel: "取消",
  saving: "保存中…",
  supervisorEffort: "思考档位固定 max",
  addReviewer: "添加评审",
  noReviewers: "评审池为空：主管兼任评审。",
  priceUnit: "单位：微美元 / 百万 token",
  test: "测试连接",
  testing: "测试中…",
} as const;

export function sourceText(s: DesktopConfigSource): string {
  return s === "repo"
    ? MODEL_COPY.sourceRepo
    : s === "--config"
      ? MODEL_COPY.sourceArg
      : MODEL_COPY.sourceEnv;
}

/** 表单里用到的模型（去重、按出现顺序）：单价表只列这些 */
export function usedModels(form: DesktopModelForm): string[] {
  const all = [form.supervisor.model, form.coder.model, ...form.reviewers.map((r) => r.model)];
  return [...new Set(all.filter(Boolean))];
}

/** 新评审 id：reviewer-N，跳过已用的 */
export function nextReviewerId(form: DesktopModelForm): string {
  const used = new Set(form.reviewers.map((r) => r.id));
  let i = form.reviewers.length + 1;
  while (used.has(`reviewer-${i}`)) i++;
  return `reviewer-${i}`;
}

export interface SaveNotice {
  tone: "ok" | "warn" | "error";
  text: string;
  detail?: string;
}

/** 保存结果的一句话；部分失败时照 written 说清写了哪个、没写哪个 */
export function saveNotice(r: DesktopModelSaveResult): SaveNotice {
  if (r.ok) {
    if (r.reload.state === "reloaded") return { tone: "ok", text: "已保存，后端已按新配置重载" };
    if (r.reload.state === "queued")
      return {
        tone: "ok",
        text: `已保存；${r.reload.waitingTickets} 张单${r.reload.waitingChat ? "和主管对话" : ""}跑完后自动重载`,
      };
    return { tone: "warn", text: "已保存，但重载失败", detail: r.reload.reason };
  }
  const all: DesktopModelSaveFile[] = ["models", "pricing"];
  const missing = all.filter((f) => !r.written.includes(f));
  const detail =
    r.written.length > 0
      ? `已写入：${r.written.map((f) => MODEL_FILE_LABEL[f]).join("、")}；未写入：${missing.map((f) => MODEL_FILE_LABEL[f]).join("、")}`
      : undefined;
  return {
    tone: r.written.length > 0 ? "warn" : "error",
    text: r.reason,
    ...(detail && { detail }),
  };
}
