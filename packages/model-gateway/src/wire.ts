import type { Effort } from "@bakacoding/types";
import type { Capabilities } from "./capabilities.js";
import { ModelGatewayError, type ModelErrorCode } from "./errors.js";
import type { ChatMessage, ReasoningBlock, Tokens, ToolCall, ToolDefinition } from "./types.js";

export interface WireInput {
  base_url: string;
  api_key: string;
  model: string;
  effort: Effort;
  max_tokens: number;
  system: string;
  tools: readonly ToolDefinition[];
  messages: readonly ChatMessage[];
}

export interface HttpRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface Parsed {
  content: string;
  tool_calls: ToolCall[];
  reasoning: ReasoningBlock[];
  tokens: Tokens | null;
}

export interface ProtocolAdapter {
  build(input: WireInput, caps: Capabilities): HttpRequest;
  parse(json: unknown): Parsed;
}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const nonNeg = (v: unknown): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
const bad = (m: string): never => {
  throw new ModelGatewayError(`服务商返回格式不对：${m}`, "BAD_RESPONSE");
};

function toolInputObject(input: unknown): Record<string, unknown> {
  // Messages 的 tool_use.input 必须是对象；历史里不是对象的按空对象发（同 harness serialize.ts）
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/** 检查历史里的工具调用和结果一一对应、结果紧跟在调用之后（同 harness serialize.ts 的检查）。 */
export function checkToolPairing(messages: readonly ChatMessage[]): void {
  let pending = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant") {
      if (pending.size) throw invalid("工具调用后面必须紧跟对应的工具结果");
      pending = new Set(m.tool_calls.map((c) => c.id));
      if (pending.size !== m.tool_calls.length) throw invalid("同一轮里工具调用 id 重复");
    } else if (m.role === "tool") {
      if (!pending.delete(m.tool_call_id))
        throw invalid(`工具结果 ${m.tool_call_id} 没有对应的调用`);
    } else if (m.role === "user" && pending.size) {
      throw invalid("工具调用后面必须紧跟对应的工具结果");
    }
  }
  if (pending.size) throw invalid("历史以未返回结果的工具调用结尾");
}
const invalid = (m: string) => new ModelGatewayError(m, "INVALID_REQUEST");

// ---------------- Anthropic Messages（DeepSeek 默认） ----------------

type Block = Record<string, unknown> & { type: string };
interface AMessage {
  role: "user" | "assistant" | "system";
  content: Block[];
}

export function messagesApiRoot(baseURL: string): string {
  // 同 harness messages-api.ts：base 已以 /v1 结尾就不再追加
  const base = baseURL.replace(/\/+$/u, "");
  return new URL(base).pathname.endsWith("/v1") ? base : `${base}/v1`;
}

export const anthropicAdapter: ProtocolAdapter = {
  build(input, caps) {
    const messages: AMessage[] = [];
    const push = (role: AMessage["role"], content: Block[]) => {
      if (content.length === 0 && role !== "user") return;
      const prev = messages.at(-1);
      if (prev && prev.role === role && role !== "system") prev.content.push(...content);
      else messages.push({ role, content });
    };
    for (const m of input.messages) {
      switch (m.role) {
        case "user":
          if (m.content) push("user", [{ type: "text", text: m.content }]);
          break;
        case "assistant":
          push("assistant", [
            ...(m.reasoning ?? []).map((r): Block => ({
              type: "thinking",
              thinking: r.text,
              ...(r.signature === undefined ? {} : { signature: r.signature }),
            })),
            ...(m.content ? [{ type: "text", text: m.content }] : []),
            ...m.tool_calls.map((c): Block => ({
              type: "tool_use",
              id: c.id,
              name: c.name,
              input: toolInputObject(c.input),
            })),
          ]);
          break;
        case "tool":
          push("user", [
            {
              type: "tool_result",
              tool_use_id: m.tool_call_id,
              content: m.content ? [{ type: "text", text: m.content }] : [],
              is_error: m.is_error,
            },
          ]);
          break;
        case "system":
          // 历史中的系统更新：放在前一个 user / 工具结果之后（同 harness serialize.ts）
          if (messages.at(-1)?.role !== "user")
            throw invalid("历史中的 system 消息前面必须是 user 或工具结果");
          if (m.content) push("system", [{ type: "text", text: m.content }]);
          break;
      }
    }
    // 工具结果排在同一条 user 消息的最前面（同 harness）
    for (const m of messages)
      if (m.role === "user")
        m.content = [
          ...m.content.filter((b) => b.type === "tool_result"),
          ...m.content.filter((b) => b.type !== "tool_result"),
        ];
    const body: Record<string, unknown> = {
      model: input.model,
      stream: false,
      max_tokens: input.max_tokens,
      messages,
      thinking: { type: input.effort === "off" ? "disabled" : "enabled" },
      ...(input.effort === "off"
        ? {}
        : { output_config: { effort: caps.effort_values[input.effort] ?? input.effort } }),
      ...(input.system ? { system: input.system } : {}),
      ...(input.tools.length
        ? {
            tools: input.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.input_schema,
            })),
          }
        : {}),
    };
    return {
      url: `${messagesApiRoot(input.base_url)}/messages`,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-api-key": input.api_key,
        "anthropic-version": "2023-06-01",
      },
      body,
    };
  },

  parse(json) {
    const r = obj(json);
    if (!Array.isArray(r.content)) bad("缺少 content 数组");
    let content = "";
    const tool_calls: ToolCall[] = [];
    const reasoning: ReasoningBlock[] = [];
    for (const raw of r.content as unknown[]) {
      const b = obj(raw);
      if (b.type === "text" && typeof b.text === "string") content += b.text;
      else if (b.type === "thinking" && typeof b.thinking === "string")
        reasoning.push({
          text: b.thinking,
          ...(typeof b.signature === "string" ? { signature: b.signature } : {}),
        });
      else if (b.type === "tool_use") {
        if (typeof b.id !== "string" || typeof b.name !== "string") bad("tool_use 缺 id 或 name");
        tool_calls.push({ id: b.id as string, name: b.name as string, input: b.input ?? {} });
      }
    }
    const u = r.usage === undefined ? null : obj(r.usage);
    // Anthropic 语义：input_tokens 不含缓存读写部分；这里的 input 是全部输入（含命中）
    const hit = u ? nonNeg(u.cache_read_input_tokens) : 0;
    const tokens = u
      ? {
          input: nonNeg(u.input_tokens) + hit + nonNeg(u.cache_creation_input_tokens),
          output: nonNeg(u.output_tokens),
          cache_hit_input: hit,
        }
      : null;
    return { content, tool_calls, reasoning, tokens };
  },
};

// ---------------- OpenAI Chat Completions（备选） ----------------

export const openaiAdapter: ProtocolAdapter = {
  build(input, caps) {
    const messages: Record<string, unknown>[] = [];
    if (input.system) messages.push({ role: "system", content: input.system });
    for (const m of input.messages) {
      if (m.role === "assistant")
        messages.push({
          role: "assistant",
          content: m.content || null,
          ...(m.tool_calls.length
            ? {
                tool_calls: m.tool_calls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: JSON.stringify(toolInputObject(c.input)) },
                })),
              }
            : {}),
        });
      else if (m.role === "tool")
        messages.push({ role: "tool", tool_call_id: m.tool_call_id, content: m.content });
      else messages.push({ role: m.role, content: m.content });
    }
    const effortValue = input.effort === "off" ? undefined : caps.effort_values[input.effort];
    return {
      url: `${input.base_url.replace(/\/+$/u, "")}/chat/completions`,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${input.api_key}`,
      },
      body: {
        model: input.model,
        stream: false,
        max_tokens: input.max_tokens,
        messages,
        ...(effortValue ? { reasoning_effort: effortValue } : {}),
        ...(input.tools.length
          ? {
              tools: input.tools.map((t) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.input_schema },
              })),
            }
          : {}),
      },
    };
  },

  parse(json) {
    const r = obj(json);
    const choice = Array.isArray(r.choices) ? obj(r.choices[0]) : bad("缺少 choices");
    const msg = obj(choice.message);
    const tool_calls: ToolCall[] = [];
    for (const raw of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
      const c = obj(raw);
      const f = obj(c.function);
      if (typeof c.id !== "string" || typeof f.name !== "string") bad("tool_calls 缺 id 或 name");
      let input: unknown = {};
      if (typeof f.arguments === "string" && f.arguments) {
        try {
          input = JSON.parse(f.arguments);
        } catch {
          input = { _raw_arguments: f.arguments };
        }
      }
      tool_calls.push({ id: c.id as string, name: f.name as string, input });
    }
    const reasoning: ReasoningBlock[] =
      typeof msg.reasoning_content === "string" && msg.reasoning_content
        ? [{ text: msg.reasoning_content }]
        : [];
    const u = r.usage === undefined ? null : obj(r.usage);
    // prompt_tokens 已含缓存命中；命中数取 prompt_tokens_details.cached_tokens 或 DeepSeek 的 prompt_cache_hit_tokens
    const tokens = u
      ? (() => {
          const input = nonNeg(u.prompt_tokens);
          const hit = Math.min(
            input,
            nonNeg(obj(u.prompt_tokens_details).cached_tokens) || nonNeg(u.prompt_cache_hit_tokens),
          );
          return { input, output: nonNeg(u.completion_tokens), cache_hit_input: hit };
        })()
      : null;
    return {
      content: typeof msg.content === "string" ? msg.content : "",
      tool_calls,
      reasoning,
      tokens,
    };
  },
};

/** 按 HTTP 状态和错误体分类（同 harness transport.ts providerError）。 */
export function classifyError(
  status: number,
  raw: unknown,
  headers: Headers,
): { code: ModelErrorCode; message: string; retryAfterMs?: number } {
  const err = obj(obj(raw).error);
  const type = typeof err.type === "string" ? err.type : "";
  const message =
    typeof err.message === "string"
      ? err.message.slice(0, 500)
      : `服务商请求失败（HTTP ${status}）`;
  const detail = `${type} ${typeof err.code === "string" ? err.code : ""} ${message}`.toLowerCase();
  let code: ModelErrorCode;
  if (
    status === 401 ||
    status === 403 ||
    ["authentication_error", "permission_error"].includes(type)
  )
    code = "AUTH";
  else if (status === 402 || /insufficient|quota|balance/u.test(detail)) code = "QUOTA";
  else if (status === 429 || type === "rate_limit_error") code = "RATE_LIMIT";
  else if (/context (length|window)|too many tokens|maximum context/u.test(detail))
    code = "CONTEXT_WINDOW_EXCEEDED";
  else if (status === 400 || status === 413 || type === "invalid_request_error")
    code = "INVALID_REQUEST";
  else code = "SERVER";
  const ra = headers.get("retry-after");
  const delay =
    ra == null
      ? NaN
      : /^\d+(?:\.\d+)?$/u.test(ra)
        ? Number(ra) * 1000
        : Date.parse(ra) - Date.now();
  return { code, message, ...(Number.isFinite(delay) && delay > 0 ? { retryAfterMs: delay } : {}) };
}
