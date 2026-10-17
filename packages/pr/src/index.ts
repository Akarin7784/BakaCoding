// 模块 6：PR 抽象，接口见 docs/modules.md「6.」一节。
export const MODULE_ID = 6 as const;
export const MODULE_NAME = "@bakacoding/pr" as const;

export * from "./provider.js";
export * from "./store.js";
export * from "./local.js";
export { createPrProvider, type CreatePrProviderOptions } from "./factory.js";
export { GitError } from "./git.js";
