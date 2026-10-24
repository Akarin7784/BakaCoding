// @vitest-environment jsdom
// UI-06e：主管对话等待时显示已用秒数；回复到达后按回复的 requirement_id 汇总 role=supervisor 的 call_completed，
// 只算不晚于回复到达的调用，显示 token 和费用；回复不带 requirement_id 时只显示用时。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopChatResult, UiEvent } from "../../shared/api";
import { ChatStore } from "../data/chatStore";
import { CALL_USAGE_COPY, fmtCost, summarizeCalls, usageLine } from "../lib/callUsage";
import { SupervisorChat } from "./SupervisorChat";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

const T0 = Date.parse("2026-10-24T10:00:00.000Z");
const REQ = "req-chat1";
let seq = 0;
const call = (
  atMs: number,
  role: "supervisor" | "coder",
  input: number,
  output: number,
  cost: number,
  requirement_id: string | null = REQ,
): UiEvent =>
  ({
    event_id: `e-${++seq}`,
    seq,
    ts: new Date(atMs).toISOString(),
    requirement_id,
    ticket_id: null,
    type: "call_completed",
    payload: {
      role,
      provider: "deepseek",
      model: "m",
      effort: "low",
      prompt: "",
      output: "o",
      tokens: { input, output, cache_hit_input: 0 },
      cache_hit: false,
      latency_ms: 100,
      cost,
      is_resubmit: false,
      rate_limited_retry: 0,
    },
  }) as unknown as UiEvent;

function setup(events?: UiEvent[]) {
  let clock = T0;
  const now = () => clock;
  let resolve: (r: DesktopChatResult) => void = () => {};
  const supervisorChat = vi.fn(() => new Promise<DesktopChatResult>((r) => (resolve = r)));
  const props = { store: new ChatStore(), initial: [], api: { supervisorChat }, now };
  const ui = render(<SupervisorChat {...props} events={events} />);
  return {
    advance: (ms: number) => {
      clock += ms;
      act(() => vi.advanceTimersByTime(ms));
    },
    send: () => {
      fireEvent.change(screen.getByLabelText("发给主管"), { target: { value: "你好" } });
      fireEvent.click(screen.getByLabelText("发送"));
    },
    reply: async (requirement_id: string | null = REQ) =>
      act(async () =>
        resolve({
          ok: true,
          reply: {
            kind: "dispatched",
            message_id: `r-${++seq}`,
            text: "答",
            ...(requirement_id && { requirement_id }),
          },
        }),
      ),
    rerender: (ev: UiEvent[]) => ui.rerender(<SupervisorChat {...props} events={ev} />),
  };
}

describe("UI-06e：调用计时与 token / 费用", () => {
  it("等待中显示已用秒数并每秒刷新；回复后计时消失", async () => {
    vi.useFakeTimers();
    const s = setup([]);
    s.send();
    expect(screen.getByTestId("chat-elapsed").textContent).toBe(CALL_USAGE_COPY.elapsed(0));
    s.advance(1000);
    expect(screen.getByTestId("chat-elapsed").textContent).toBe("已用 1 秒");
    s.advance(2500);
    expect(screen.getByTestId("chat-elapsed").textContent).toBe("已用 3 秒");
    await s.reply();
    expect(screen.queryByTestId("chat-elapsed")).toBeNull();
  });

  it("按回复的 requirement_id 汇总 supervisor 调用（逐字比对）；别的需求（评审单子，时间重叠也不算）、别的角色不算", async () => {
    vi.useFakeTimers();
    const s = setup([]);
    s.send();
    expect(screen.queryByTestId("chat-call-usage")).toBeNull();
    s.advance(4000);
    await s.reply();
    // 事件晚于回复到达：到了再显示
    expect(screen.queryByTestId("chat-call-usage")).toBeNull();
    s.rerender([
      call(T0 + 1000, "supervisor", 1200, 300, 2100),
      call(T0 + 3000, "supervisor", 500, 0, 400),
      call(T0 + 2000, "supervisor", 88888, 1, 88888, "req-review-other"),
      call(T0 + 2500, "supervisor", 77777, 1, 77777, null),
      call(T0 + 2000, "coder", 99999, 1, 99999),
    ]);
    expect(screen.getByTestId("chat-call-usage").textContent).toBe(
      "本次 2 次调用 · 2.0k tokens · $0.0025",
    );
  });

  it("回复之后同一 requirement_id 的后续调用（拆单 / 评审 / 重拆）不计入，数字冻结", async () => {
    vi.useFakeTimers();
    const first = call(T0 + 1000, "supervisor", 100, 50, 300);
    const s = setup([first]);
    s.send();
    s.advance(2000);
    await s.reply();
    const line = "本次 1 次调用 · 150 tokens · $0.0003";
    expect(screen.getByTestId("chat-call-usage").textContent).toBe(line);
    s.advance(5000);
    s.rerender([first, call(T0 + 2001, "supervisor", 9000, 9000, 9000)]);
    expect(screen.getByTestId("chat-call-usage").textContent).toBe(line);
  });

  it("回复不带 requirement_id：只显示用时，不显示用量", async () => {
    vi.useFakeTimers();
    const s = setup([call(T0 + 500, "supervisor", 10, 5, 7, null)]);
    s.send();
    s.advance(2000);
    expect(screen.getByTestId("chat-elapsed").textContent).toBe("已用 2 秒");
    await s.reply(null);
    expect(screen.queryByTestId("chat-call-usage")).toBeNull();
  });

  it("下一次发送时旧的统计消失，重新计时", async () => {
    vi.useFakeTimers();
    const s = setup([call(T0 + 500, "supervisor", 10, 5, 7)]);
    s.send();
    s.advance(1000);
    await s.reply();
    expect(screen.getByTestId("chat-call-usage").textContent).toBe(
      usageLine({ calls: 1, tokens: 15, cost_micro_usd: 7 }),
    );
    s.send();
    expect(screen.queryByTestId("chat-call-usage")).toBeNull();
    expect(screen.getByTestId("chat-elapsed").textContent).toBe("已用 0 秒");
  });

  it("不给 events：只计时，不显示统计", async () => {
    vi.useFakeTimers();
    const s = setup(undefined);
    s.send();
    s.advance(2000);
    await s.reply();
    expect(screen.queryByTestId("chat-call-usage")).toBeNull();
  });

  it("summarizeCalls / fmtCost 边界", () => {
    const scope = { requirement_id: REQ, until: T0 };
    expect(summarizeCalls([], scope)).toBeNull();
    expect(summarizeCalls([call(T0, "supervisor", 1, 1, 1)], scope)).toEqual({
      calls: 1,
      tokens: 2,
      cost_micro_usd: 1,
    });
    expect(summarizeCalls([call(T0 + 1, "supervisor", 1, 1, 1)], scope)).toBeNull();
    expect(summarizeCalls([call(T0, "supervisor", 1, 1, 1, "req-x")], scope)).toBeNull();
    expect(CALL_USAGE_COPY.usage("1.5k", "$0.0100", 3)).toBe(
      "本次 3 次调用 · 1.5k tokens · $0.0100",
    );
    expect(fmtCost(123456)).toBe("$0.1235");
    expect(fmtCost(-5)).toBe("$0.0000");
    expect(fmtCost(Number.NaN)).toBe("$0.0000");
  });
});
