// 模块 10：主管，接口见 docs/modules.md「10.」一节。
export const MODULE_ID = 10 as const;
export const MODULE_NAME = "@bakacoding/supervisor" as const;

export {
  SPLIT_MAX_ATTEMPTS,
  INTEGRATION_DIFF_MAX_CODEPOINTS,
  MainMergeError,
  type BackpressurePausedInput,
  type ChatReply,
  type EscalationAction,
  type HighRiskDecisionResult,
  type HighRiskHeldInput,
  type PendingHighRisk,
  type ManualTicketInput,
  type SplitRequest,
  type SplitResult,
  type Supervisor,
  type SupervisorDeps,
  type SupervisorTicket,
  type TakeOverReport,
  type TicketOrigin,
  type TicketValidationError,
  type UserMessage,
  type IntegrationReview,
  type IntegrationBlockReason,
  type MainMergeResult,
  type MainMergeErrorCode,
} from "./types.js";
export { createSupervisor } from "./supervisor.js";
export { validateWriteScope } from "./validate.js";
