// T-084：仓库没准备好（没有提交 / 没有 main）时启动报明确原因，代替裸 Error。

/**
 * 仓库没准备好的原因码。和模块 4 `checkRepo()`（T-086）里对应两项用同一个字符串，
 * 界面按 code 对上准备页的检查项。
 */
export type RepoNotReadyCode = "no_commits" | "no_main";

/** `current` 缺省（分离 HEAD）时消息里显示的名字 */
const DETACHED_HEAD = "分离 HEAD";

/** 消息里展示的分支名上限（字符），同模块 4 `checkRepo()` 的 detail（#97）。`current` 字段仍给完整分支名。 */
export const BRANCH_MESSAGE_MAX = 100;
const shortBranch = (b: string) =>
  b.length > BRANCH_MESSAGE_MAX ? `${b.slice(0, BRANCH_MESSAGE_MAX - 1)}…` : b;

/**
 * 组合根启动时仓库没准备好。`message` 是给用户看的中文原因，**不含仓库路径**；
 * `no_main` 时 `current` 是当前检出的分支名，分离 HEAD 时为 undefined。
 */
export class RepoNotReadyError extends Error {
  readonly code: RepoNotReadyCode;
  readonly current?: string;

  constructor(code: "no_commits");
  constructor(code: "no_main", current?: string, baseBranch?: string);
  constructor(code: RepoNotReadyCode, current?: string, baseBranch = "main") {
    super(
      code === "no_commits"
        ? "仓库没有任何提交，请先提交一次再启动"
        : `仓库里没有 ${baseBranch} 分支（当前是 ${current === undefined ? DETACHED_HEAD : shortBranch(current)}），这一版只支持 ${baseBranch}`,
    );
    this.name = "RepoNotReadyError";
    this.code = code;
    if (code === "no_main" && current !== undefined) this.current = current;
  }
}
