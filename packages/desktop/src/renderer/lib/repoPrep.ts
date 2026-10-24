// UI-03a：项目准备页（docs/ui-design.md §4.1）的文案与纯逻辑。逐项检查 git / commit / main / ignored，
// 前一项不过后面灰掉；一键修复的入口由 repoFixRoute 路由到对应项。
import type {
  DesktopConfigCheck,
  DesktopConfigFileState,
  DesktopRepoCheck,
  DesktopRepoCheckItem,
} from "../../shared/api.js";
import { CONFIG_FIX_TEXT, NESTED_REPO_REASON } from "../../shared/config-text.js";
import type { RepoFixRoute } from "./readonly";

/** 4 的检查项，加上 T-113 的「模型配置」（git 之后、commit 之前） */
export type RepoItemId = DesktopRepoCheckItem["id"] | "config";

export const PREP_COPY = {
  title: "项目准备",
  intro: "逐项检查这个文件夹。没通过的项可以一键修好，改动前都会先让你确认。",
  recheck: "重新检查",
  checking: "检查中…",
  back: "返回",
  allOk: "检查都通过了",
  allOkHint: "如果后端还没连上，点「重新连接」。",
  reconnect: "重新连接",
  blocked: "先完成上一项",
  cancel: "取消",
  bannerEntry: "准备仓库",
  unstagedNote: "你之前暂存的文件会变回未暂存，内容不会丢",
  identityHint: "只写入本仓库的 .git/config，不改全局设置。",
  checkFailed: "检查仓库失败",
  /** 确认框里的目标文件夹（UI-03a 评审 B1：只显示最后一级文件夹名） */
  targetFolder: "目标文件夹",
  /** 来源是当前工作目录时横幅的提示和按钮（不给「准备仓库」） */
  importFirst: "还没选项目文件夹，请先导入项目",
  importAction: "导入项目",
} as const;

/** 文件夹名显示上限（字符）；更长的截断，结尾用省略号 */
export const FOLDER_NAME_MAX = 32;

/** 只取最后一级文件夹名（主进程已经只给 basename，这里再防一层）并截断。 */
export function shortFolder(name: string, max = FOLDER_NAME_MAX): string {
  const base =
    name
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || name;
  const chars = [...base];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : base;
}

export interface RepoItemCopy {
  title: string;
  /** 不通过时的说明（4 给了 detail 就用 detail） */
  fail: string;
  /** 一键修复按钮；ignored 没有按钮（连上后端时自动写） */
  action?: string;
  /** 没有按钮时的说明 */
  note?: string;
}

export const ITEM_COPY: Record<RepoItemId, RepoItemCopy> = {
  git: { title: "是 Git 仓库", fail: "这个文件夹还不是 Git 仓库", action: "初始化 Git" },
  config: { title: "模型配置", fail: "缺少或不合法的模型配置", action: "生成配置" },
  commit: { title: "至少有一次提交", fail: "仓库还没有任何提交", action: "创建首次提交" },
  main: { title: "有 main 分支", fail: "没找到 main 分支", action: "从当前分支新建 main" },
  ignored: {
    title: ".bakacoding/ 已忽略",
    fail: ".bakacoding/ 还没加入忽略",
    note: "连上后端时会自动写进 .git/info/exclude，不改你的 .gitignore。",
  },
};

export const EXCLUDED_REASON: Record<"protected" | "bakacoding", string> = {
  protected: "密钥或环境变量文件，默认不提交",
  bakacoding: "BakaCoding 运行数据",
};

export type ItemState = "ok" | "fail" | "blocked";

export interface PrepItemView {
  id: RepoItemId;
  state: ItemState;
  title: string;
  detail?: string;
  action?: string;
  /** 按钮显示但不能点（T-113：嵌套仓库的「初始化 Git」） */
  disabled?: true;
  note?: string;
}

const fileText = (name: string, st: Exclude<DesktopConfigFileState, "ok">) =>
  st === "missing" ? `缺少 ${name}` : `${name} 内容不合法`;

/** 「模型配置」项的说明：缺哪个、哪个不合法（固定文案拼文件名，不含路径和配置值） */
export function configDetail(c: DesktopConfigCheck): string {
  const parts: string[] = [];
  if (c.models !== "ok") parts.push(fileText("config/models.json", c.models));
  if (c.pricing !== "ok") parts.push(fileText("config/pricing.json", c.pricing));
  return parts.join("；");
}

/** 「生成配置」要做的事（T-113）：要新建 / 要覆盖的文件，和要不要填预算（写 models.json 才要） */
export interface ConfigPlan {
  create: string[];
  overwrite: string[];
  needBudget: boolean;
}

export function configPlan(c: DesktopConfigCheck): ConfigPlan {
  const create: string[] = [];
  const overwrite: string[] = [];
  const models = !c.models_external && c.models !== "ok";
  if (models) (c.models === "missing" ? create : overwrite).push("config/models.json");
  if (c.pricing !== "ok")
    (c.pricing === "missing" ? create : overwrite).push("config/pricing.json");
  return { create, overwrite, needBudget: models };
}

interface RowInput {
  id: RepoItemId;
  ok: boolean;
  code?: string;
  detail?: string;
}

/** 4 的检查项，git 之后插入「模型配置」（repo:check 带了 config 才插） */
function rows(check: DesktopRepoCheck, config?: DesktopConfigCheck): RowInput[] {
  const out: RowInput[] = [];
  for (const i of check.items) {
    out.push(i);
    if (i.id === "git" && config) {
      const ok = config.models === "ok" && config.pricing === "ok";
      out.push({ id: "config", ok, ...(!ok && { detail: configDetail(config) }) });
    }
  }
  return out;
}

/**
 * 前一项不通过时后面一律 blocked（灰掉，不给按钮）。
 * T-113：嵌套仓库的 git 项给固定提示，「初始化 Git」禁用（主进程也拒绝）；models.json 是另外指定的文件、准备页又只剩它不对时，
 * 「模型配置」项不给按钮，说明去改那个文件。
 */
export function prepItems(check: DesktopRepoCheck, config?: DesktopConfigCheck): PrepItemView[] {
  let blocked = false;
  return rows(check, config).map((i) => {
    const copy = ITEM_COPY[i.id];
    const state: ItemState = blocked ? "blocked" : i.ok ? "ok" : "fail";
    if (!i.ok) blocked = true;
    const view: PrepItemView = {
      id: i.id,
      state,
      title: copy.title,
      ...(state === "fail" && { detail: i.detail || copy.fail }),
      ...(state === "fail" && copy.action && { action: copy.action }),
      ...(state === "fail" && copy.note && { note: copy.note }),
    };
    if (state === "fail" && i.id === "git" && i.code === "nested_repo") {
      view.detail = NESTED_REPO_REASON;
      view.disabled = true;
    }
    if (state === "fail" && i.id === "config" && config) {
      const plan = configPlan(config);
      if (plan.create.length + plan.overwrite.length === 0) {
        delete view.action;
        view.note = CONFIG_FIX_TEXT.external_config;
      }
    }
    return view;
  });
}

/** 第一项不通过的检查（主按钮给它）；全部通过为 null。 */
export function firstFailing(
  check: DesktopRepoCheck,
  config?: DesktopConfigCheck,
): RepoItemId | null {
  return rows(check, config).find((i) => !i.ok)?.id ?? null;
}

/** 生成配置相关文案（T-113） */
export const CONFIG_COPY = {
  title: "生成配置",
  intro: "用安装包里的模板生成缺的配置。模型名和价格都照模板，只有每日预算要你填。",
  create: "将新建",
  overwrite: "将覆盖（先备份）",
  backupNote: "原文件会先另存为同目录下的 <文件名>.bak-<时间>，再覆盖。",
  budgetLabel: "每日预算（美元，必填）",
  budgetHint:
    "没有默认值。写进 config/models.json 的 budget.daily_micro_usd（1 美元 = 1,000,000 微美元）。",
  budgetInvalid: "请填一个大于 0 的金额，最多 6 位小数",
  confirm: "我确认覆盖上面这些文件（会先备份）",
  notCommitted:
    "生成的 config/models.json、config/pricing.json 没有提交进仓库（已写进 .git/info/exclude）。",
  ok: "已生成配置",
  failPrefix: "生成配置失败",
  errorsTitle: "现在的问题",
  busy: "生成中…",
} as const;

/** 预算上限（美元），同主进程的 MAX_DAILY_MICRO_USD */
export const MAX_DAILY_USD = 1_000_000;

/** 用户填的美元金额 → 微美元整数；空、不是数、≤0、超过 6 位小数或超过上限 → null。不预填、不给默认值。 */
export function parseBudgetUsd(text: string): number | null {
  const t = text.trim();
  const m = /^(\d{1,7})(?:\.(\d{1,6}))?$/.exec(t);
  if (!m) return null;
  const micro = Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0") || "0");
  if (micro < 1 || micro > MAX_DAILY_USD * 1_000_000) return null;
  return micro;
}

export const ROUTE_ITEM: Record<RepoFixRoute, RepoItemId> = {
  init_repo: "git",
  init_config: "config",
  initial_commit: "commit",
  create_main: "main",
};

export type IdentityField = "name" | "email";

/** 身份表单只显示缺的字段（checkRepo.identity）。 */
export function missingIdentity(identity: DesktopRepoCheck["identity"]): IdentityField[] {
  const out: IdentityField[] = [];
  if (!identity.name) out.push("name");
  if (!identity.email) out.push("email");
  return out;
}

export const IDENTITY_LABEL: Record<IdentityField, string> = {
  name: "Git 用户名",
  email: "Git 邮箱",
};

/**
 * 身份表单显示的字段（UI-03b，接 T-108）：缺哪项就只显示哪项，4 只写给了的那几项、只写本仓库 .git/config。
 */
export function identityFormFields(missing: readonly IdentityField[]): IdentityField[] {
  return [...missing];
}

/**
 * 身份相关失败的固定文案（UI-03b）：不管主进程 reason 是什么都显示这两句；
 * 不再提示去命令行跑 git config，缺的那项直接在确认框里填。
 */
export const IDENTITY_FAILURE_TEXT = {
  no_identity: "还缺 Git 用户名或邮箱，请在确认框里填上缺的那一项",
  invalid_identity: "Git 用户名或邮箱格式不对，请检查后再试",
} as const;

/** 修复失败时显示的原因：身份两种用固定文案，其余用主进程的固定文案 */
export function fixFailureReason(r: { code: string; reason: string }): string {
  return r.code === "no_identity" || r.code === "invalid_identity"
    ? IDENTITY_FAILURE_TEXT[r.code]
    : r.reason;
}

/** 只把缺的字段交给主进程；不缺就不传 identity。 */
export function identityArg(
  missing: readonly IdentityField[],
  v: { name: string; email: string },
): { identity?: { name?: string; email?: string } } {
  if (missing.length === 0) return {};
  return {
    identity: {
      ...(missing.includes("name") && { name: v.name.trim() }),
      ...(missing.includes("email") && { email: v.email.trim() }),
    },
  };
}

/** 表单值是否填好（只看显示出来的字段）；邮箱只做最粗的格式检查，细的由主进程 / 4 校验。 */
export function identityValid(
  fields: readonly IdentityField[],
  v: { name: string; email: string },
): boolean {
  if (fields.includes("name") && v.name.trim() === "") return false;
  if (fields.includes("email") && !/^[^\s@]+@[^\s@]+$/.test(v.email.trim())) return false;
  return true;
}
