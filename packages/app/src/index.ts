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
} from "@bakacoding/workspace";
// T-087：设置页保存模型配置（desktop 不直接依赖 3）
export {
  findSecretLikeValues,
  validate as validateConfig,
  writeConfig,
  WRITABLE_CONFIG_FILE,
  type WriteConfigOptions,
  type WriteConfigResult,
} from "@bakacoding/config-budget";
