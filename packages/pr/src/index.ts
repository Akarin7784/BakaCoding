// 模块 6：PR 抽象，接口见 docs/modules.md「6.」一节。
export const MODULE_ID = 6 as const;
export const MODULE_NAME = "@bakacoding/pr" as const;

export * from "./provider.js";
export * from "./store.js";
export {
  LocalPrProvider,
  PrNotFoundError,
  CommitPatchError,
  NoChangesError,
  WorktreeMismatchError,
  PrAlreadyMergedError,
  type LocalPrProviderOptions,
  type GitWriteLock,
} from "./local.js";
export * from "./github.js";
export { createPrProvider, type CreatePrProviderOptions } from "./factory.js";
export { GitError, GitTimeoutError, REMOTE_GIT_TIMEOUT_MS } from "./git.js";
