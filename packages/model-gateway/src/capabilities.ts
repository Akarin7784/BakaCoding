import type { Effort } from "@bakacoding/types";

export type Protocol = "anthropic-messages" | "openai-chat";

/** 服务商能力表：档位映射以这里为准（配置不设 effort_map）。 */
export interface Capabilities {
  protocol: Protocol;
  /** 档位写到请求体哪个字段 */
  effort_field: "output_config.effort" | "reasoning_effort";
  /** 支持的档位，从低到高 */
  efforts: readonly Effort[];
  /** 发给服务商的档位值 */
  effort_values: Partial<Record<Effort, string>>;
  /** 兼容接口会忽略的字段，本模块不依赖它们 */
  ignored_fields: readonly string[];
  /** 工具调用不能并行时由本地保证串行（DeepSeek 忽略 disable_parallel_tool_use） */
  serial_tools_local: boolean;
  /**
   * 输出上限：模型配置没填 max_tokens 时，Anthropic 协议请求里传这个值（max_tokens 必填），
   * OpenAI 协议不传（用服务端默认值）；两种协议的预算预占都按它估。
   */
  default_max_tokens: number;
  /** 请求体带 thinking: { type: enabled | disabled } 开关 */
  thinking_toggle: boolean;
  /** OpenAI 协议下 assistant 消息把思考内容写回 reasoning_content（DeepSeek 带 tools 时必须回传） */
  reasoning_passback: boolean;
  source: string;
}

/**
 * DeepSeek Anthropic 兼容接口。档位写法搬自 harness serialize.ts（thinking + output_config.effort，
 * off 时 thinking disabled）；忽略字段见 https://api-docs.deepseek.com/guides/anthropic_api ；
 * max_tokens 默认值同 harness defaults.ts DEFAULT_MAX_TOKENS。
 */
export const DEEPSEEK_ANTHROPIC: Capabilities = {
  protocol: "anthropic-messages",
  effort_field: "output_config.effort",
  efforts: ["off", "low", "high", "max"],
  effort_values: { low: "low", high: "high", max: "max" },
  ignored_fields: ["budget_tokens", "cache_control", "disable_parallel_tool_use"],
  serial_tools_local: true,
  default_max_tokens: 256_000,
  thinking_toggle: true,
  reasoning_passback: true,
  source:
    "https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-alpha.5/packages/llm/llm-deepseek/src/serialize.ts",
};

/**
 * DeepSeek OpenAI 兼容接口（备选）：thinking 开关 + reasoning_effort（low / high / max）。
 * 带 tools 的请求必须把之前所有轮次的 reasoning_content 原样回传，否则返回 400；
 * 不带 tools 时回传会被忽略。依据 https://api-docs.deepseek.com/guides/thinking_mode 。
 */
export const DEEPSEEK_OPENAI: Capabilities = {
  protocol: "openai-chat",
  effort_field: "reasoning_effort",
  efforts: ["off", "low", "high", "max"],
  effort_values: { low: "low", high: "high", max: "max" },
  ignored_fields: ["temperature", "presence_penalty", "frequency_penalty"],
  serial_tools_local: true,
  default_max_tokens: 256_000,
  thinking_toggle: true,
  reasoning_passback: true,
  source: "https://api-docs.deepseek.com/guides/thinking_mode",
};

/** 通用 OpenAI 兼容接口：reasoning_effort 只有 low / high 两档可对应，max 降到 high。 */
export const OPENAI_CHAT: Capabilities = {
  protocol: "openai-chat",
  effort_field: "reasoning_effort",
  efforts: ["off", "low", "high"],
  effort_values: { low: "low", high: "high" },
  ignored_fields: [],
  serial_tools_local: true,
  default_max_tokens: 32_000,
  thinking_toggle: false,
  reasoning_passback: false,
  source: "https://platform.openai.com/docs/api-reference/chat/create",
};

/** 按服务商 id 和协议定的能力表；没列的按配置里的 protocol 取通用表。 */
export const PROVIDER_CAPABILITIES: Readonly<Record<string, readonly Capabilities[]>> = {
  deepseek: [DEEPSEEK_ANTHROPIC, DEEPSEEK_OPENAI],
};

export function capabilitiesFor(provider: string, protocol: Protocol): Capabilities {
  const known = PROVIDER_CAPABILITIES[provider]?.find((c) => c.protocol === protocol);
  if (known) return known;
  return protocol === "anthropic-messages"
    ? { ...DEEPSEEK_ANTHROPIC, source: "Anthropic Messages 通用能力表" }
    : OPENAI_CHAT;
}

const ORDER: readonly Effort[] = ["off", "low", "high", "max"];

/**
 * 不支持的档位降到不高于它的最高可用档（都没有就取最低档），返回警告，不报错。
 * 模型关了思考（thinking_enabled=false）时只能用 off。
 */
export function mapEffort(
  caps: Capabilities,
  requested: Effort,
  thinkingEnabled = true,
): { effort: Effort; warning?: string } {
  const supported = thinkingEnabled ? caps.efforts : caps.efforts.filter((e) => e === "off");
  if (supported.includes(requested)) return { effort: requested };
  const rank = ORDER.indexOf(requested);
  const lower = supported.filter((e) => ORDER.indexOf(e) <= rank);
  const effort = lower.length ? lower[lower.length - 1]! : supported[0]!;
  const why = thinkingEnabled ? "服务商不支持" : "该模型未开思考";
  return { effort, warning: `档位 ${requested} ${why}，已降到 ${effort}` };
}
