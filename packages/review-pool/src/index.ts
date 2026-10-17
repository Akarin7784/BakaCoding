// 模块 7：评审池，接口见 docs/modules.md「7.」一节。
export const MODULE_ID = 7 as const;
export const MODULE_NAME = "@bakacoding/review-pool" as const;

export * from "./types.js";
export * from "./pool.js";
export * from "./prompt.js";
export { InMemoryAssignmentStore } from "./memory.js";
export * from "./rounds.js";
