import type { CallCtx, Effort, PermissionList } from "@bakacoding/types";

export type MaybePromise<T> = T | Promise<T>;

/** 5 只用到的需求单字段（types 里还没有 Ticket 类型）。 */
export interface CoderTicket {
  ticket_id: string;
  /** 用来取同一项目的公共前缀（架构约束） */
  project_id: string;
}

export interface RunTicketInput {
  ticket: CoderTicket;
  /** 8 写好的需求单部分（接在公共前缀之后） */
  prompt: string;
  /** 由 4 / 8 / 9 建好的 worktree；5 不建不清 */
  worktree_path: string;
  permission_list: PermissionList;
  /** 由 8 算好（含复投升档） */
  effort: Effort;
  /** 上一轮评审理由、冲突文件或上一轮 diff；接在需求单后面，不动前缀 */
  feedback?: string;
  /** 1 的 call() 的 ctx；is_resubmit 由 8 填，5 原样传下去（role 改为 coder） */
  ctx: CallCtx;
}

export type RunStatus = "done" | "gave_up" | "turn_limit" | "budget_exceeded";

export interface RunTicketResult {
  status: RunStatus;
  summary: string;
  /** write / edit 成功过的文件（相对 worktree 的路径，按首次修改顺序） */
  changed_files: string[];
}

// ---- 模型多轮对话（1 的 call() 草案只收一个 prompt 字符串，不够做工具调用，这里定义最小接口） ----

/** 工具定义：名称 + 说明 + JSON Schema 入参。属于公共前缀，必须逐字节稳定。 */
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

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string; is_error: boolean }
  /** 后备做法：中途改提示时作为 system 消息追加在历史末尾，不动开头 */
  | { role: "system"; content: string };

export interface ChatRequest {
  role: "coder";
  provider: string;
  model: string;
  effort: Effort;
  /** 公共前缀的一部分：系统提示 + 架构约束 */
  system: string;
  /** 公共前缀的一部分：工具定义（只增不改） */
  tools: readonly ToolDefinition[];
  messages: readonly ChatMessage[];
  ctx: CallCtx;
}

export interface ChatResponse {
  /** 模型的文字输出 */
  content: string;
  /** 本轮要执行的工具调用；为空表示模型结束本单 */
  tool_calls: ToolCall[];
}

/** 模块 1 的多轮调用接口（需与基础层对接）；预算耗尽时应抛错，由 isBudgetExceeded 识别。 */
export type ModelChat = (req: ChatRequest) => Promise<ChatResponse>;

// ---- 4 的文件工具（T-010 未合入，按 modules.md 第 4 节的形状注入） ----

export type ToolResult =
  | { ok: true; output: string }
  /** code 如 FS_EDIT_NOT_FOUND / FS_AMBIGUOUS_EDIT / FS_NOT_OBSERVED / FS_STALE_VERSION，或权限拒绝 */
  | { ok: false; code: string; message: string };

export const FILE_TOOL_NAMES = ["read", "write", "edit", "glob", "grep"] as const;
export type FileToolName = (typeof FILE_TOOL_NAMES)[number];

export type FileTools = Record<FileToolName, (input: unknown) => MaybePromise<ToolResult>>;

/** 为一张单创建绑定 worktree 和权限清单的工具实例（4 负责执行权限、越界时发 write_scope_requested）。 */
export type CreateFileTools = (opts: {
  ticket_id: string;
  worktree_path: string;
  permission_list: PermissionList;
}) => MaybePromise<FileTools>;

/** 读到的配置子集；模块 3 的 Config 在结构上满足它。 */
export interface CoderPoolConfig {
  roles: { coder: { provider: string; model: string } };
  pipeline: { max_turns: number };
}

export interface CoderPoolDeps {
  getConfig: () => CoderPoolConfig;
  chat: ModelChat;
  createTools: CreateFileTools;
  /** 3 的 promptTemplate("coder")（T-008 未合入，暂注入）：公共前缀里的系统提示 */
  promptTemplate: (role: "coder") => MaybePromise<string>;
  /** 同一项目的架构约束（公共前缀的一部分；同一项目每次必须返回相同内容） */
  architectureConstraints: (project_id: string) => MaybePromise<readonly string[]>;
  /** 识别 1 报的预算耗尽；默认看 error.code === "BUDGET_EXCEEDED" */
  isBudgetExceeded?: (error: unknown) => boolean;
  /** feedback 截断长度，默认 20000 字符 */
  maxFeedbackChars?: number;
}
