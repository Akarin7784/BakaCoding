import {
  buildSystemPrefix,
  buildTicketMessage,
  FILE_TOOL_DEFINITIONS,
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

function toolPath(input: unknown): string | undefined {
  const p = (input as { path?: unknown } | null)?.path;
  return typeof p === "string" && p.length > 0 ? p.replace(/^\.\/+/, "") : undefined;
}

function renderResult(r: ToolResult): string {
  return r.ok ? r.output : `${r.code}: ${r.message}`;
}

export function createCoderPool(deps: CoderPoolDeps): CoderPool {
  const isBudgetExceeded = deps.isBudgetExceeded ?? defaultIsBudgetExceeded;
  const maxFeedback = deps.maxFeedbackChars ?? DEFAULT_MAX_FEEDBACK_CHARS;
  // 同一项目只拼一次，保证每单拿到同一个字符串（逐字节相同）
  const prefixes = new Map<string, Promise<string>>();

  function systemPrefix(project_id: string): Promise<string> {
    let p = prefixes.get(project_id);
    if (!p) {
      p = (async () =>
        buildSystemPrefix(
          await deps.promptTemplate("coder"),
          await deps.architectureConstraints(project_id),
        ))();
      p.catch(() => prefixes.delete(project_id));
      prefixes.set(project_id, p);
    }
    return p;
  }

  async function runTicket(input: RunTicketInput): Promise<RunTicketResult> {
    const config = deps.getConfig();
    const { provider, model } = config.roles.coder;
    const maxTurns = config.pipeline.max_turns;
    const system = await systemPrefix(input.ticket.project_id);
    // 每单一个代理：会话状态只活在这次调用里，跑完即丢
    const tools = await deps.createTools({
      ticket_id: input.ticket.ticket_id,
      worktree_path: input.worktree_path,
      permission_list: input.permission_list,
    });
    const messages: ChatMessage[] = [
      { role: "user", content: buildTicketMessage(input.prompt, input.feedback, maxFeedback) },
    ];
    const changed: string[] = [];
    const ctx = { ...input.ctx, role: "coder" as const };
    let lastText = "";

    for (let turn = 0; turn < maxTurns; turn++) {
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
        });
      } catch (error) {
        if (isBudgetExceeded(error))
          return {
            status: "budget_exceeded",
            summary: lastText || "预算耗尽，模型调用被模块 1 拒绝",
            changed_files: changed,
          };
        throw error;
      }
      if (res.content) lastText = res.content;
      messages.push({ role: "assistant", content: res.content, tool_calls: res.tool_calls });

      if (res.tool_calls.length === 0) {
        const fin = parseFinish(res.content);
        if (fin) return { status: fin.status, summary: fin.summary, changed_files: changed };
        return { status: "done", summary: res.content.trim(), changed_files: changed };
      }

      // 工具调用按顺序串行执行，结果（含拒绝和错误）原样交还模型
      for (const call of res.tool_calls) {
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
          const p = toolPath(call.input);
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
