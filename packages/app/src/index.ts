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
