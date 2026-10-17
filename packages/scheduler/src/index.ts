// 模块 9：调度器与合并队列，接口见 docs/modules.md「9.」一节。
export const MODULE_ID = 9 as const;
export const MODULE_NAME = "@bakacoding/scheduler" as const;

export * from "./types.js";
export {
  BackpressureController,
  type BacklogInput,
  type BackpressureDecision,
} from "./backpressure.js";
export {
  createScheduler,
  RATE_LIMIT_ESCALATE_AFTER,
  DEFAULT_TARGET_DIRTY_RETRY_MS,
  DEFAULT_DISPATCH_POLL_MS,
  DEFAULT_EXCLUSIVE_ZONES,
  WHOLE_REPO_SCOPE,
} from "./scheduler.js";
export {
  globToRegExp,
  matchesAny,
  globsOverlap,
  scopesOverlap,
  sampleOf,
  samplesOf,
  expandBraces,
  inExclusiveZone,
  MAX_BRACE_EXPANSIONS,
} from "./glob.js";
