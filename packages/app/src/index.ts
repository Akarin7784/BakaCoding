// 组合根（T-041a / T-063）：不是功能模块，接口见 docs/modules.md「组合根」一节。
export const MODULE_NAME = "@bakacoding/app" as const;

export { assemble, type App, type AppDeps } from "./assemble.js";
export { countActiveTickets, isTicketActive } from "./active-tickets.js";
export {
  createDefaultDeps,
  PrNotWiredError,
  type CreateDefaultDepsOpts,
  type DefaultDepsHandle,
} from "./create-default-deps.js";
// T-084：仓库没有提交 / 没有 main 时 createDefaultDeps 抛它；code 与模块 4 checkRepo() 一致
export { RepoNotReadyError, type RepoNotReadyCode } from "./repo-not-ready.js";
// UI-03b：provider:test 的结果类型（DefaultDepsHandle.testConnection 返回它；desktop 不直接依赖 1）
export type { TestConnectionFailure, TestConnectionResult } from "@bakacoding/model-gateway";
export {
  acquireWriterLock,
  WRITER_LOCK_FILENAME,
  type WriterLock,
  type WriterLockPayload,
} from "./writer-lock.js";
// T-078：桌面端在建数据库之前写 .git/info/exclude（desktop 不直接依赖 4）；T-082 加通用的 ensureExcludeLines
// T-086：准备页的仓库检查与修复组，界面只调用
export {
  ensureBakacodingIgnored,
  ensureExcludeLines,
  type ExcludeRule,
  checkRepo,
  initRepo,
  listInitialCommitFiles,
  initialCommit,
  createMainBranch,
  RepoFixError,
  MAIN_BRANCH,
  REPO_GIT_TIMEOUT_MS,
  type RepoCheck,
  type RepoCheckItem,
  type RepoCheckId,
  type RepoCheckCode,
  type RepoFixCode,
  type RepoOptions,
  type GitIdentity,
  type InitialCommitFiles,
  type ExcludedReason,
  // UI-06c：右面板 Git 区只读查询（T-155）
  branchStatus,
  BranchStatusError,
  DEFAULT_INTEGRATION_BRANCH,
  type BranchStatus,
  type BranchStatusCode,
  type BranchStatusOptions,
} from "@bakacoding/workspace";
// T-087：设置页保存模型配置（desktop 不直接依赖 3）
export {
  findSecretLikeValues,
  formatConfigIssue,
  validate as validateConfig,
  writeConfig,
  WRITABLE_CONFIG_FILE,
  type WriteConfigOptions,
  type WriteConfigResult,
} from "@bakacoding/config-budget";
