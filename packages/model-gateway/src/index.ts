// 模块 1：模型接入层（T-004），接口见 docs/modules.md「1.」一节。
export const MODULE_ID = 1 as const;
export const MODULE_NAME = "@bakacoding/model-gateway" as const;
export * from "./types.js";
export * from "./errors.js";
export * from "./capabilities.js";
export * from "./rate-limit.js";
export * from "./gateway.js";
export { anthropicAdapter, openaiAdapter, classifyError, messagesApiRoot } from "./wire.js";
