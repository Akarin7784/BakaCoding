// UI-03a：项目准备页（docs/ui-design.md §4.1）的文案与纯逻辑。逐项检查 git / commit / main / ignored，
// 前一项不过后面灰掉；一键修复的入口由 repoFixRoute 路由到对应项。
import type { DesktopRepoCheck, DesktopRepoCheckItem } from "../../shared/api.js";
import type { RepoFixRoute } from "./readonly";

export type RepoItemId = DesktopRepoCheckItem["id"];

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
  note?: string;
}

/** 前一项不通过时后面一律 blocked（灰掉，不给按钮）。 */
export function prepItems(check: DesktopRepoCheck): PrepItemView[] {
  let blocked = false;
  return check.items.map((i) => {
    const copy = ITEM_COPY[i.id];
    const state: ItemState = blocked ? "blocked" : i.ok ? "ok" : "fail";
    if (!i.ok) blocked = true;
    return {
      id: i.id,
      state,
      title: copy.title,
      ...(state === "fail" && { detail: i.detail || copy.fail }),
      ...(state === "fail" && copy.action && { action: copy.action }),
      ...(state === "fail" && copy.note && { note: copy.note }),
    };
  });
}

/** 第一项不通过的检查（主按钮给它）；全部通过为 null。 */
export function firstFailing(check: DesktopRepoCheck): RepoItemId | null {
  return check.items.find((i) => !i.ok)?.id ?? null;
}

export const ROUTE_ITEM: Record<RepoFixRoute, RepoItemId> = {
  init_repo: "git",
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
 * 4 的 initialCommit 只接受成对的 identity（name + email 一起写进本仓库 .git/config）。只缺一项时没法只写那一项
 * （要么改 4 的接口，要么桌面自己调 git，都要另行批准），所以只缺一项时不出表单，提示用命令行补上那一项。
 */
export function identityFormFields(missing: readonly IdentityField[]): IdentityField[] {
  return missing.length === 2 ? [...missing] : [];
}

/** 只缺一项时给用户的命令（只写本仓库）。 */
export function identityCommand(field: IdentityField): string {
  return field === "name"
    ? 'git config user.name "你的名字"'
    : "git config user.email you@example.com";
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
