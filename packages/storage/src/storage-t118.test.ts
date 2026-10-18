// T-118：保留期自动清理。打开写库先清一次（补停机期间过期的数据），之后按 purge_interval_ms 定时清；
// 只读连接不跑；失败只记日志不挡启动；close() 停掉定时器。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BakaEvent } from "@bakacoding/types";
import { openStorage, openStorageReadonly, type Storage } from "./index.js";

let dirs: string[] = [];
let opened: Array<Storage | ReturnType<typeof openStorageReadonly>> = [];
afterEach(() => {
  for (const s of opened) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  opened = [];
});
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "bc-t118-"));
  dirs.push(d);
  return join(d, "bakacoding.db");
}
function openStorageAt(opts: Parameters<typeof openStorage>[0]): Storage {
  const s = openStorage(opts);
  opened.push(s);
  return s;
}
function openReadonlyAt(path: string): ReturnType<typeof openStorageReadonly> {
  const s = openStorageReadonly({ path });
  opened.push(s);
  return s;
}

let n = 0;
function call(ts: string, prompt = "写一个函数"): BakaEvent {
  n += 1;
  return {
    event_id: `t118-${n}`,
    seq: n,
    ts,
    trace_id: "tr-1",
    span_id: `sp-${n}`,
    parent_span_id: null,
    requirement_id: "R-1",
    ticket_id: "T-1",
    type: "call_completed",
    payload: {
      role: "coder",
      provider: "deepseek",
      model: "deepseek-flash",
      effort: "low",
      prompt,
      output: "function f() {}",
      tokens: { input: 100, output: 20, cache_hit_input: 60 },
      cache_hit: true,
      latency_ms: 1200,
      cost: 37,
      is_resubmit: false,
      rate_limited_retry: 0,
    },
  } as BakaEvent;
}

/** 读出落库后的提示词；过期清理后是空串。 */
function promptOf(s: Storage, event_id: string): string {
  const e = s.queryEvents({ types: ["call_completed"] }).find((x) => x.event_id === event_id);
  return (e?.payload as { prompt: string }).prompt;
}

async function waitUntil(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待自动清理超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("T-118 保留期自动清理", () => {
  it("打开写库时先清一次：停机期间过期的提示词和输出被清掉", () => {
    const path = tmpDb();
    const s1 = openStorageAt({ path, now: () => new Date("2026-01-01T00:00:00.000Z") });
    const e = call("2026-01-01T00:00:00.000Z");
    s1.ingest(e);
    expect(promptOf(s1, e.event_id)).toBe("写一个函数");
    s1.close();

    // 两个月后才启动：原来的调用已经超过 30 天保留期
    const s2 = openStorageAt({ path, now: () => new Date("2026-03-01T00:00:00.000Z") });
    expect(promptOf(s2, e.event_id)).toBe("");
  });

  it("到期后按 purge_interval_ms 自动清，不用等到重启", async () => {
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const s = openStorageAt({
      path: tmpDb(),
      now: () => clock,
      purge_interval_ms: 20,
    });
    const e = call("2026-01-01T00:00:00.000Z");
    s.ingest(e);
    expect(promptOf(s, e.event_id)).toBe("写一个函数");

    clock = new Date("2026-03-01T00:00:00.000Z");
    await waitUntil(() => promptOf(s, e.event_id) === "");
  });

  it("close() 之后定时器不再跑（不会在已关闭的库上清理）", async () => {
    const warns: string[] = [];
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const s = openStorageAt({
      path: tmpDb(),
      now: () => clock,
      purge_interval_ms: 10,
      logger: { warn: (m) => warns.push(m) },
    });
    s.close();
    expect(s.health().closed).toBe(true);
    clock = new Date("2026-03-01T00:00:00.000Z");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(warns).toEqual([]);
  });

  it("purge_interval_ms: 0 关闭自动清理（打开时那一次也不跑）", async () => {
    const s = openStorageAt({
      path: tmpDb(),
      now: () => new Date("2026-03-01T00:00:00.000Z"),
      purge_interval_ms: 0,
    });
    const e = call("2026-01-01T00:00:00.000Z");
    s.ingest(e);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(promptOf(s, e.event_id)).toBe("写一个函数");
    // 数据本身已经过期：手动清理时清掉 1 条，证明不是数据没到期
    expect(s.purgeExpired()).toEqual({ purged_calls: 1 });
  });

  it("只读连接不清理", () => {
    const path = tmpDb();
    const s1 = openStorageAt({ path, now: () => new Date("2026-01-01T00:00:00.000Z") });
    const e = call("2026-01-01T00:00:00.000Z");
    s1.ingest(e);
    s1.close();

    const ro = openReadonlyAt(path);
    expect(
      (ro.queryEvents().find((x) => x.event_id === e.event_id)!.payload as { prompt: string })
        .prompt,
    ).toBe("写一个函数");
  });

  it("purge_interval_ms 必须是非负整数", () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => openStorage({ path: tmpDb(), purge_interval_ms: bad })).toThrow(RangeError);
    }
  });
});
