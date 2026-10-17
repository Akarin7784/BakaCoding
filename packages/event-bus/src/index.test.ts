import { describe, expect, it, vi } from "vitest";
import type { BakaEvent } from "@bakacoding/types";
import {
  childSpan,
  createEventBus,
  MODULE_ID,
  MODULE_NAME,
  newTrace,
  type PublishInput,
} from "./index.js";

const trace = { trace_id: "tr-1", span_id: "sp-1", parent_span_id: null };
const projectCreated = (name = "demo"): PublishInput =>
  ({
    type: "project_created",
    ...trace,
    requirement_id: "req-1",
    ticket_id: null,
    payload: { project_id: "p-1", name, language: "typescript", has_github_remote: false },
  }) as PublishInput;
const backlog = (pending = 1): PublishInput =>
  ({
    type: "review_backlog",
    ...trace,
    requirement_id: "req-1",
    ticket_id: null,
    payload: { pending, capacity: 2 },
  }) as PublishInput;

describe("@bakacoding/event-bus", () => {
  it("导出模块编号和包名", () => {
    expect(MODULE_ID).toBe(0);
    expect(MODULE_NAME).toBe("@bakacoding/event-bus");
  });

  it("按类型分发，补全 event_id、ts，seq 单调递增", async () => {
    const bus = createEventBus({ now: () => new Date("2026-10-17T06:00:00.000Z") });
    const got: BakaEvent[] = [];
    bus.subscribe("project_created", (e) => void got.push(e));
    const a = await bus.publish(projectCreated("a"));
    const b = await bus.publish(projectCreated("b"));
    expect(got.map((e) => e.seq)).toEqual([0, 1]);
    expect(a.ts).toBe("2026-10-17T06:00:00.000Z");
    expect(a.event_id).not.toBe(b.event_id);
    expect(got[0]).toEqual(a);
  });

  it("保留发布方给的 event_id 和 ts", async () => {
    const bus = createEventBus();
    const e = await bus.publish({
      ...projectCreated(),
      event_id: "ev-x",
      ts: "2026-01-01T00:00:00Z",
    } as PublishInput);
    expect(e.event_id).toBe("ev-x");
    expect(e.ts).toBe("2026-01-01T00:00:00Z");
  });

  it("* 通配订阅收到全部类型，类型订阅只收自己的", async () => {
    const bus = createEventBus();
    const all = vi.fn();
    const onlyBacklog = vi.fn();
    bus.subscribe("*", all);
    bus.subscribe("review_backlog", onlyBacklog);
    await bus.publish(projectCreated());
    await bus.publish(backlog());
    expect(all).toHaveBeenCalledTimes(2);
    expect(onlyBacklog).toHaveBeenCalledTimes(1);
  });

  it("异步分发：publish 返回前不同步调用 handler", () => {
    const bus = createEventBus();
    const h = vi.fn();
    bus.subscribe("*", h);
    void bus.publish(projectCreated());
    expect(h).not.toHaveBeenCalled();
  });

  it("schema 校验失败时 reject，不分发、不消耗 seq", async () => {
    const bus = createEventBus();
    const h = vi.fn();
    bus.subscribe("*", h);
    await expect(bus.publish(backlog(-1))).rejects.toThrow();
    await expect(
      bus.publish({ ...projectCreated(), type: "no_such_event" } as unknown as PublishInput),
    ).rejects.toThrow();
    const ok = await bus.publish(backlog());
    expect(ok.seq).toBe(0);
    expect(h).toHaveBeenCalledTimes(1);
  });

  it("handler 抛错或 reject 不影响其他订阅者，也不让 publish reject", async () => {
    const onHandlerError = vi.fn();
    const bus = createEventBus({ onHandlerError });
    const ok = vi.fn();
    bus.subscribe("*", () => {
      throw new Error("同步错");
    });
    bus.subscribe("*", async () => {
      throw new Error("异步错");
    });
    bus.subscribe("*", ok);
    await expect(bus.publish(projectCreated())).resolves.toBeTruthy();
    expect(ok).toHaveBeenCalledTimes(1);
    expect(onHandlerError).toHaveBeenCalledTimes(2);
    expect(onHandlerError.mock.calls[0]![0].subscription).toBe("*");
  });

  it("同一订阅者按发布顺序串行收到事件，慢订阅者不阻塞别人", async () => {
    const bus = createEventBus();
    const order: number[] = [];
    const fast: number[] = [];
    bus.subscribe("*", async (e) => {
      await new Promise((r) => setTimeout(r, e.seq === 0 ? 20 : 0));
      order.push(e.seq);
    });
    bus.subscribe("*", (e) => void fast.push(e.seq));
    const p0 = bus.publish(backlog());
    const p1 = bus.publish(backlog());
    await new Promise((r) => setTimeout(r, 5));
    expect(fast).toEqual([0, 1]);
    await Promise.all([p0, p1]);
    expect(order).toEqual([0, 1]);
  });

  it("取消订阅后不再收到", async () => {
    const bus = createEventBus();
    const h = vi.fn();
    const off = bus.subscribe("*", h);
    await bus.publish(backlog());
    off();
    await bus.publish(backlog());
    expect(h).toHaveBeenCalledTimes(1);
  });

  it("newTrace / childSpan 生成 span", () => {
    let n = 0;
    const id = () => `id-${n++}`;
    const root = newTrace(id);
    expect(root).toEqual({ trace_id: "id-0", span_id: "id-1", parent_span_id: null });
    expect(childSpan(root, id)).toEqual({
      trace_id: "id-0",
      span_id: "id-2",
      parent_span_id: "id-1",
    });
  });
});
