import { randomUUID } from "node:crypto";
import {
  PermissionListSchema,
  type BakaEvent,
  type PermissionEntry,
  type PermissionList,
  type Trace,
} from "@bakacoding/types";

/**
 * 每单当前生效的权限清单（三级：rw / ro / deny，后条覆盖前条，未匹配即拒绝）。
 * `createTools` 用调用方给的清单登记；`applyPermissions` 整份替换，同一单所有活着的工具实例立刻按新清单判定；
 * 越界写拿到「已批准」后把批准的范围以 rw 追加在末尾。只存在本进程内存里，不写 PR 记录，也不落库：
 * 需要跨轮次保留的范围由调用方（8）写回模块 2 的需求单记录，下一轮建工具时带进来。
 */
export class PermissionRegistry {
  private readonly lists = new Map<string, PermissionList>();

  /** 整份替换某单的权限清单；格式不对抛 ZodError。返回生效后的（冻结）清单。 */
  applyPermissions(ticket_id: string, permission_list: readonly PermissionEntry[]): PermissionList {
    if (typeof ticket_id !== "string" || ticket_id.length === 0)
      throw new TypeError("ticket_id 必须是非空字符串");
    const parsed = PermissionListSchema.parse(permission_list);
    // 冻结后存：调用方之后改自己手里的数组不影响已生效的清单
    const frozen = Object.freeze(
      parsed.map((e) => Object.freeze({ glob: e.glob, level: e.level })),
    ) as unknown as PermissionList;
    this.lists.set(ticket_id, frozen);
    return frozen;
  }

  /** 在末尾追加读写条目（批准的写入范围）。 */
  grant(ticket_id: string, globs: readonly string[]): PermissionList {
    const cur = this.lists.get(ticket_id) ?? [];
    return this.applyPermissions(ticket_id, [
      ...cur,
      ...globs.map((glob) => ({ glob, level: "rw" as const })),
    ]);
  }

  get(ticket_id: string): PermissionList | undefined {
    return this.lists.get(ticket_id);
  }

  /** 单子结束（清理 worktree 后）调用，释放内存。 */
  release(ticket_id: string): void {
    this.lists.delete(ticket_id);
  }
}

/** 进程内默认登记表：`createTools` 不传 `registry` 时用它。 */
export const defaultPermissionRegistry = new PermissionRegistry();

/** modules.md 第 4 节的 `applyPermissions(ticket_id, permission_list)`：作用于默认登记表。 */
export function applyPermissions(
  ticket_id: string,
  permission_list: readonly PermissionEntry[],
): PermissionList {
  return defaultPermissionRegistry.applyPermissions(ticket_id, permission_list);
}

type ScopeEvent = Extract<
  BakaEvent,
  { type: "write_scope_requested" | "write_scope_granted" | "write_scope_denied" }
>;

/** 结构上兼容模块 0 的 EventBus，只用到这三类事件（模块 4 不依赖总线包）。 */
export interface ScopeBus {
  publish(
    input: Omit<Extract<ScopeEvent, { type: "write_scope_requested" }>, "seq" | "event_id" | "ts">,
  ): Promise<unknown>;
  subscribe(
    type: "write_scope_granted",
    handler: (e: Extract<ScopeEvent, { type: "write_scope_granted" }>) => void,
  ): () => void;
  subscribe(
    type: "write_scope_denied",
    handler: (e: Extract<ScopeEvent, { type: "write_scope_denied" }>) => void,
  ): () => void;
}

export interface ScopeRequestOptions {
  bus: ScopeBus;
  /** 事件归属：需求号和当前 span（申请事件挂在它下面）。 */
  ctx: { requirement_id: string; trace: Pick<Trace, "trace_id" | "span_id"> };
  /** 等批复的时长，默认 SCOPE_REQUEST_TIMEOUT_MS；超时按拒绝处理。 */
  timeout_ms?: number;
  /** 测试用。 */
  newId?: () => string;
}

/** 等「已批准 / 已拒绝」的默认时长：5 分钟。 */
export const SCOPE_REQUEST_TIMEOUT_MS = 5 * 60_000;

export type ScopeDecision =
  { granted: true; granted_scope: string[] } | { granted: false; reason: string };

/** 发「需要扩大写入范围」并等同一 request_id 的批复；先订阅再发布，避免漏掉同步回复。 */
export async function requestWriteScope(
  opts: ScopeRequestOptions,
  ticket_id: string,
  requested_scope: string[],
  reason: string,
): Promise<ScopeDecision> {
  const newId = opts.newId ?? randomUUID;
  const request_id = newId();
  const timeout = opts.timeout_ms ?? SCOPE_REQUEST_TIMEOUT_MS;
  let offGranted = (): void => {};
  let offDenied = (): void => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const decision = new Promise<ScopeDecision>((resolve) => {
      offGranted = opts.bus.subscribe("write_scope_granted", (e) => {
        if (e.ticket_id === ticket_id && e.payload.request_id === request_id)
          resolve({ granted: true, granted_scope: [...e.payload.granted_scope] });
      });
      offDenied = opts.bus.subscribe("write_scope_denied", (e) => {
        if (e.ticket_id === ticket_id && e.payload.request_id === request_id)
          resolve({ granted: false, reason: e.payload.reason });
      });
      timer = setTimeout(
        () => resolve({ granted: false, reason: `no reply within ${timeout} ms` }),
        timeout,
      );
    });
    await opts.bus.publish({
      type: "write_scope_requested",
      trace_id: opts.ctx.trace.trace_id,
      span_id: newId(),
      parent_span_id: opts.ctx.trace.span_id,
      requirement_id: opts.ctx.requirement_id,
      ticket_id,
      payload: { request_id, requested_scope, reason },
    });
    return await decision;
  } finally {
    if (timer) clearTimeout(timer);
    offGranted();
    offDenied();
  }
}
