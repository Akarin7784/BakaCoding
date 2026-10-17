import type { CallCtx, Effort, EventOf, Role } from "@bakacoding/types";

export type Tokens = EventOf<"call_completed">["payload"]["tokens"];

/** 工具定义：与 4 的 FILE_TOOL_DEFINITIONS、5 的 ToolDefinition 同结构。 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** 模型的思考内容。服务商要求原样回传时，把它放回对应 assistant 消息的 `reasoning`。 */
export interface ReasoningBlock {
  text: string;
  signature?: string;
}

/** 多轮消息：与 5 的 ChatMessage 同结构（assistant 另可带 reasoning）。 */
export type ChatMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      tool_calls: readonly ToolCall[];
      reasoning?: readonly ReasoningBlock[];
    }
  | { role: "tool"; tool_call_id: string; name: string; content: string; is_error: boolean }
  /** 中途追加的系统提示，放在历史里，不动开头的 system */
  | { role: "system"; content: string };

export interface ChatRequest {
  role: Role;
  provider: string;
  model: string;
  effort: Effort;
  system: string;
  tools: readonly ToolDefinition[];
  messages: readonly ChatMessage[];
  ctx: CallCtx;
  /** 取消：中止 HTTP 请求并抛 AbortError，仍发 call_completed */
  signal?: AbortSignal;
}

export interface CallStats {
  tokens: Tokens;
  /** 本次有缓存命中（cache_hit_input > 0） */
  cache_hit: boolean;
  latency_ms: number;
  /** 整数微美元 */
  cost: number;
  /** 因 429 重试的次数 */
  rate_limited_retry: number;
}

export interface ChatResult extends CallStats {
  content: string;
  /** 为空表示模型没有要调用的工具 */
  tool_calls: ToolCall[];
  reasoning: ReasoningBlock[];
  /** 实际发给服务商的档位（降档后） */
  effort: Effort;
}

export interface CallResult extends CallStats {
  output: string;
}

export interface RateLimitTarget {
  provider: string;
  model?: string;
}

export interface RateLimitEntry {
  provider: string;
  model: string;
  /** 现在是否在 429 退避期内 */
  limited: boolean;
  /** 退避结束时间（ISO UTC），不在退避期为 null */
  until: string | null;
  /** 累计遇到的 429 次数 */
  rate_limited_total: number;
}

export interface RateLimitState {
  /** 账号级令牌桶（同一服务商所有模型合用） */
  buckets: { provider: string; capacity: number; available: number; waiting: number }[];
  models: RateLimitEntry[];
}
