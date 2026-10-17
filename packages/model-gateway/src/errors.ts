/** 预算耗尽：调用前查 3 的 budgetState()，当日或本单已用完时抛，不发请求。 */
export class BudgetExceededError extends Error {
  readonly code = "BUDGET_EXCEEDED" as const;
  constructor(
    readonly scope: "daily" | "ticket",
    message: string,
  ) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export type ModelErrorCode =
  | "AUTH"
  | "QUOTA"
  | "RATE_LIMIT"
  | "INVALID_REQUEST"
  | "CONTEXT_WINDOW_EXCEEDED"
  | "SERVER"
  | "NETWORK"
  | "BAD_RESPONSE"
  | "CONFIG";

/** 服务商调用失败（分类同 harness transport.ts）。message 不含密钥。 */
export class ModelGatewayError extends Error {
  constructor(
    message: string,
    readonly code: ModelErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelGatewayError";
  }
}

/** 与 fetch 一致的取消错误：name 为 "AbortError"。 */
export function abortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const e = new Error("模型调用已取消");
  e.name = "AbortError";
  return e;
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}
