import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import { createTools as createWorkspaceTools } from "@bakacoding/workspace";
import {
  buildSystemPrefix,
  buildTicketMessage,
  FILE_TOOL_DEFINITIONS,
  FINISH_RETRY_PROMPT,
  parseFinish,
} from "./prefix.js";
import {
  FILE_TOOL_NAMES,
  type ChatMessage,
  type CoderPoolDeps,
  type FileToolName,
  type RunTicketInput,
  type RunTicketResult,
  type ToolDefinition,
  type ToolResult,
} from "./types.js";

export const DEFAULT_MAX_FEEDBACK_CHARS = 20_000;
export const UNKNOWN_TOOL_CODE = "UNKNOWN_TOOL";
export const TOOL_EXCEPTION_CODE = "TOOL_ERROR";

export function defaultIsBudgetExceeded(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "BUDGET_EXCEEDED"
  );
}

export interface CoderPool {
  runTicket(input: RunTicketInput): Promise<RunTicketResult>;
  /** 某项目的公共前缀（系统提示 + 工具定义），供检查缓存稳定性。 */
  prefix(project_id: string): Promise<{ system: string; tools: readonly ToolDefinition[] }>;
}

function isFileTool(name: string): name is FileToolName {
  return (FILE_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * write / edit 的目标文件（模块 4 的参数名 `file_path`），按模块 4 的规则规范成相对 worktree 的路径：
 * 反斜杠转 `/`、`posix.normalize`（去掉 `./`、合并 `a/../`）、去掉末尾 `/`。只在工具成功后调用，
 * 成功说明路径已过模块 4 的越界检查。
 */
function changedPath(input: unknown): string | undefined {
  const p = (input as { file_path?: unknown } | null)?.file_path;
  if (typeof p !== "string" || p.length === 0) return undefined;
  const rel = posix.normalize(p.replace(/\\/g, "/")).replace(/\/+$/, "");
  return rel === "" || rel === "." ? undefined : rel;
}

/** 中止时抛的错误：优先 signal.reason，没有就抛名为 AbortError 的错误（与模块 7 一致）。 */
function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const e = new Error("编码已取消");
  e.name = "AbortError";
  return e;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function renderResult(r: ToolResult): string {
  return r.ok ? r.output : `${r.code}: ${r.message}`;
}

export function createCoderPool(deps: CoderPoolDeps): CoderPool {
  const isBudgetExceeded = deps.isBudgetExceeded ?? defaultIsBudgetExceeded;
  const maxFeedback = deps.maxFeedbackChars ?? DEFAULT_MAX_FEEDBACK_CHARS;
  // 本池的不可信区块标签 nonce：创建时随机生成，池内不变；只出现在需求单之后，不进公共前缀
  const nonce = randomBytes(8).toString("hex");
  // 按项目缓存公共前缀，键是模板 + 架构约束的内容哈希：内容没变就复用同一个字符串
  // （逐字节相同，保住前缀缓存）；模板或约束变了就重拼
  const prefixes = new Map<string, { hash: string; system: string }>();

  async function systemPrefix(project_id: string): Promise<string> {
    const template = await deps.promptTemplate("coder");
    const constraints = [...(await deps.architectureConstraints(project_id))];
    const hash = createHash("sha256")
      .update(JSON.stringify([template, constraints]))
      .digest("hex");
    const cached = prefixes.get(project_id);
    if (cached && cached.hash === hash) return cached.system;
    const system = buildSystemPrefix(template, constraints);
    prefixes.set(project_id, { hash, system });
    return system;
  }

  async function runTicket(input: RunTicketInput): Promise<RunTicketResult> {
    // 进入前已取消：直接抛，不建工具、不调模型
    throwIfAborted(input.signal);
    const config = deps.getConfig();
    const { provider, model } = config.roles.coder;
    const maxTurns = config.pipeline.max_turns;
    const system = await systemPrefix(input.ticket.project_id);
    // 每单一个代理：会话状态只活在这次调用里，跑完即丢
    const tools = await (deps.createTools ?? createWorkspaceTools)({
      ticket_id: input.ticket.ticket_id,
      worktree_path: input.worktree_path,
      permission_list: input.permission_list,
    });
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: buildTicketMessage(input.prompt, input.feedback, maxFeedback, nonce),
      },
    ];
    const changed: string[] = [];
    const ctx = { ...input.ctx, role: "coder" as const };
    let lastText = "";
    /** 上一轮结束回复解析不了、已追加格式提示时的那条原文 */
    let unparsed: string | undefined;

    const { signal } = input;

    for (let turn = 0; turn < maxTurns; turn++) {
      // 每次调模型前检查取消（也就是工具轮之间）
      throwIfAborted(signal);
      let res;
      try {
        res = await deps.chat({
          role: "coder",
          provider,
          model,
          effort: input.effort,
          system,
          tools: FILE_TOOL_DEFINITIONS,
          messages: [...messages],
          ctx,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        // 调用中途取消：1 抛 AbortError；统一改抛 signal.reason
        throwIfAborted(signal);
        if (isBudgetExceeded(error))
          return {
            status: "budget_exceeded",
            summary: lastText || "预算耗尽，模型调用被模块 1 拒绝",
            changed_files: changed,
          };
        throw error;
      }
      // 1 没理会 signal、在取消后才返回：丢弃这一轮，不执行它的工具
      throwIfAborted(signal);
      if (res.content) lastText = res.content;
      // 思考内容原样放进这一轮的 assistant 消息（含 signature，不改写、不截断），下一轮回传；
      // 没有思考内容时不带 reasoning 字段
      messages.push({
        role: "assistant",
        content: res.content,
        tool_calls: res.tool_calls,
        ...(res.reasoning && res.reasoning.length > 0 ? { reasoning: [...res.reasoning] } : {}),
      });

      if (res.tool_calls.length === 0) {
        const fin = parseFinish(res.content);
        if (fin) return { status: fin.status, summary: fin.summary, changed_files: changed };
        if (unparsed !== undefined)
          // 已经要求过一次格式，仍解析不了：按放弃处理，summary 放原文
          return {
            status: "gave_up",
            summary: res.content.trim() || unparsed.trim(),
            changed_files: changed,
          };
        // 解析不了：追加一条格式提示让模型再回一轮（计入 max_turns）
        unparsed = res.content;
        messages.push({ role: "user", content: FINISH_RETRY_PROMPT });
        continue;
      }
      // 模型又调了工具：照常继续，之后的结束回复重新计
      unparsed = undefined;

      // 工具调用按顺序串行执行，结果（含拒绝和错误）原样交还模型
      for (const call of res.tool_calls) {
        // 每个工具调用前检查取消：已取消就不再动 worktree
        throwIfAborted(signal);
        let result: ToolResult;
        if (!isFileTool(call.name)) {
          result = { ok: false, code: UNKNOWN_TOOL_CODE, message: `没有名为 ${call.name} 的工具` };
        } else {
          try {
            result = await tools[call.name](call.input);
          } catch (error) {
            result = {
              ok: false,
              code: TOOL_EXCEPTION_CODE,
              message: error instanceof Error ? error.message : String(error),
            };
          }
        }
        if (result.ok && (call.name === "write" || call.name === "edit")) {
          const p = changedPath(call.input);
          if (p && !changed.includes(p)) changed.push(p);
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: renderResult(result),
          is_error: !result.ok,
        });
      }
    }
    // 最后一轮的工具执行完才取消：照样按取消处理
    throwIfAborted(signal);
    return {
      status: "turn_limit",
      summary: `达到 pipeline.max_turns 上限（${maxTurns} 轮）未完成${lastText ? `；最后一条回复：${lastText}` : ""}`,
      changed_files: changed,
    };
  }

  return {
    runTicket,
    async prefix(project_id) {
      return { system: await systemPrefix(project_id), tools: FILE_TOOL_DEFINITIONS };
    },
  };
}
