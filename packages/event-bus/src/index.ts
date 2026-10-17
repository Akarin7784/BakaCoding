// 模块 0：事件总线。进程内异步发布/订阅，只传递不落库（落库由模块 2 用 "*" 订阅完成）。
// 接口见 docs/modules.md「0.」一节。
import { randomUUID } from "node:crypto";
import {
  EventSchema,
  type BakaEvent,
  type EventOf,
  type EventType,
  type Trace,
} from "@bakacoding/types";

export const MODULE_ID = 0 as const;
export const MODULE_NAME = "@bakacoding/event-bus" as const;

/** 发布时的入参：`seq` 由总线分配；`event_id`、`ts` 可省略，省略时由总线补。 */
export type PublishInput<E extends BakaEvent = BakaEvent> = E extends BakaEvent
  ? Omit<E, "seq" | "event_id" | "ts"> & { event_id?: string; ts?: string }
  : never;

export type Handler<E extends BakaEvent = BakaEvent> = (event: E) => void | Promise<void>;
export type Unsubscribe = () => void;

export interface HandlerErrorInfo {
  error: unknown;
  event: BakaEvent;
  /** 订阅的类型，"*" 表示通配订阅。 */
  subscription: EventType | "*";
}

export interface QueueOverflowInfo {
  subscription: EventType | "*";
  /** 当前排队（含正在处理）的事件数。 */
  pending: number;
  limit: number;
}

export interface EventBusOptions {
  /** handler 抛错或 reject 时调用；默认 console.warn。不会把错误再发成事件，避免循环。 */
  onHandlerError?: (info: HandlerErrorInfo) => void;
  /** 起始序号，默认 0。重启时由模块 2 传入库里最大 `seq` + 1，避免撞号。 */
  initialSeq?: number;
  /**
   * 单个订阅者排队未处理的事件上限，默认 10000。超过时调用 `onQueueOverflow` 告警，
   * 事件照常入队、不丢弃（每次从未超限变为超限时告警一次，回落到上限以下后再超会再告警）。
   */
  maxQueue?: number;
  /** 队列超限告警；默认 console.warn。 */
  onQueueOverflow?: (info: QueueOverflowInfo) => void;
  /** 测试用：注入时间。 */
  now?: () => Date;
  /** 测试用：注入 id 生成。 */
  newId?: () => string;
}

export interface EventBus {
  /**
   * 校验后异步分发。校验失败直接 reject（ZodError），任何订阅者都收不到。
   * 返回的 Promise 在所有订阅者处理完后 resolve，值为补全后的事件；handler 出错不会让它 reject。
   */
  publish<E extends BakaEvent>(input: PublishInput<E>): Promise<E>;
  subscribe<K extends EventType>(type: K, handler: Handler<EventOf<K>>): Unsubscribe;
  subscribe(type: "*", handler: Handler<BakaEvent>): Unsubscribe;
}

interface Subscription {
  type: EventType | "*";
  handler: Handler<BakaEvent>;
  /** 每个订阅者一条串行队列：同一订阅者按发布顺序收到事件，不同订阅者互不阻塞。 */
  tail: Promise<void>;
  active: boolean;
  pending: number;
  overflowed: boolean;
}

export function createEventBus(options: EventBusOptions = {}): EventBus {
  const onHandlerError =
    options.onHandlerError ??
    ((info: HandlerErrorInfo) =>
      console.warn(
        `[event-bus] handler 出错（订阅 ${info.subscription}，事件 ${info.event.type} #${info.event.seq}）`,
        info.error,
      ));
  const onQueueOverflow =
    options.onQueueOverflow ??
    ((info: QueueOverflowInfo) =>
      console.warn(
        `[event-bus] 订阅 ${info.subscription} 积压 ${info.pending} 条，超过上限 ${info.limit}（事件不丢弃）`,
      ));
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const maxQueue = options.maxQueue ?? 10_000;
  const initialSeq = options.initialSeq ?? 0;
  if (!Number.isInteger(initialSeq) || initialSeq < 0) {
    throw new RangeError(`initialSeq 必须是非负整数，收到 ${initialSeq}`);
  }
  if (!Number.isInteger(maxQueue) || maxQueue < 1) {
    throw new RangeError(`maxQueue 必须是正整数，收到 ${maxQueue}`);
  }
  const subs: Subscription[] = [];
  let seq = initialSeq;

  function deliver(sub: Subscription, event: BakaEvent): Promise<void> {
    sub.pending += 1;
    if (sub.pending > maxQueue && !sub.overflowed) {
      sub.overflowed = true;
      try {
        onQueueOverflow({ subscription: sub.type, pending: sub.pending, limit: maxQueue });
      } catch (error) {
        console.error("[event-bus] onQueueOverflow 自身出错", error);
      }
    }
    sub.tail = sub.tail.then(async () => {
      try {
        if (!sub.active) return;
        try {
          await sub.handler(event);
        } catch (error) {
          try {
            onHandlerError({ error, event, subscription: sub.type });
          } catch (cbError) {
            // 错误回调本身出错：兜底打一条 console.error，不影响其他订阅者
            console.error("[event-bus] onHandlerError 自身出错", { cbError, original: error });
          }
        }
      } finally {
        sub.pending -= 1;
        if (sub.pending <= maxQueue) sub.overflowed = false;
      }
    });
    return sub.tail;
  }

  return {
    async publish<E extends BakaEvent>(input: PublishInput<E>): Promise<E> {
      const draft = {
        ...input,
        event_id: input.event_id ?? newId(),
        ts: input.ts ?? now().toISOString(),
        seq,
      };
      // 先校验再占用 seq：校验失败不消耗序号，seq 保持连续
      const event = EventSchema.parse(draft) as E;
      seq += 1;
      // 快照当前订阅者：分发过程中新加的订阅者不会收到本条
      const targets = subs.filter((s) => s.active && (s.type === "*" || s.type === event.type));
      await Promise.resolve(); // 保证异步：publish 返回前不会同步调用任何 handler
      await Promise.all(targets.map((s) => deliver(s, event)));
      return event;
    },

    subscribe(type: EventType | "*", handler: Handler<never>): Unsubscribe {
      const sub: Subscription = {
        type,
        handler: handler as Handler<BakaEvent>,
        tail: Promise.resolve(),
        active: true,
        pending: 0,
        overflowed: false,
      };
      subs.push(sub);
      return () => {
        sub.active = false;
        const i = subs.indexOf(sub);
        if (i >= 0) subs.splice(i, 1);
      };
    },
  } as EventBus;
}

/** 新需求开一条 trace：返回根 span（`parent_span_id` 为 null）。trace_id 按需求生成。 */
export function newTrace(newId: () => string = randomUUID): Trace {
  return { trace_id: newId(), span_id: newId(), parent_span_id: null };
}

/** 发布方在已有 span 下开子 span。 */
export function childSpan(parent: Trace, newId: () => string = randomUUID): Trace {
  return { trace_id: parent.trace_id, span_id: newId(), parent_span_id: parent.span_id };
}
