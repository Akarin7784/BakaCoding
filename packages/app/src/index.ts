// 组合根（T-041a）：不是功能模块，接口见 docs/modules.md「组合根」一节。
export const MODULE_NAME = "@bakacoding/app" as const;

export { assemble, type App, type AppDeps } from "./assemble.js";
