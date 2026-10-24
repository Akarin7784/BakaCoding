// @vitest-environment jsdom
// UI-10：只有消息列表自己滚；在底部附近时新消息跟到底，往上翻了不拉回。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatStore, type ChatItem } from "../data/chatStore";
import { FOLLOW_THRESHOLD_PX, SupervisorChat } from "./SupervisorChat";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

let n = 0;
function msg(content: string): ChatItem {
  n += 1;
  return {
    message_id: `m-${n}`,
    project_id: null,
    role: "user",
    kind: null,
    content,
    requirement_id: null,
    ticket_ids: [],
    created_at: Date.now(),
  } as ChatItem;
}

/** jsdom 没有排版：给滚动容器装上可控的 scrollHeight / clientHeight / scrollTop。 */
function fakeLayout(el: HTMLElement) {
  const box = { height: 2000, top: 0 };
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 400 });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => box.height });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => box.top,
    set: (v: number) => {
      box.top = Math.max(0, Math.min(v, box.height - 400));
    },
  });
  return box;
}

function setup() {
  const store = new ChatStore();
  const initial = Array.from({ length: 30 }, (_, i) => msg(`第 ${i} 条`));
  render(<SupervisorChat store={store} initial={initial} api={null} />);
  const el = screen.getByTestId("chat-scroll");
  const box = fakeLayout(el);
  return { store, el, box };
}

describe("消息列表滚动（UI-10）", () => {
  it("列表是独立滚动区：flex-1 + min-h-0 + overflow-y-auto，外层 section 也 min-h-0", () => {
    setup();
    const cls = screen.getByTestId("chat-scroll").className.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(["flex-1", "min-h-0", "overflow-y-auto"]));
    const section = screen.getByRole("region", { name: "主管对话" }).className.split(/\s+/);
    expect(section).toEqual(expect.arrayContaining(["min-h-0", "overflow-hidden"]));
  });

  it("用户在底部附近时，新消息自动滚到底", () => {
    const { store, el, box } = setup();
    // 离底 FOLLOW_THRESHOLD_PX 以内也算在底部
    box.top = box.height - 400 - FOLLOW_THRESHOLD_PX;
    fireEvent.scroll(el);
    box.height = 2600;
    act(() => store.append(msg("新来的")));
    expect(box.top).toBe(2600 - 400);
  });

  it("用户往上翻了，新消息不把他拉回底部", () => {
    const { store, el, box } = setup();
    box.top = box.height - 400 - FOLLOW_THRESHOLD_PX - 1;
    fireEvent.scroll(el);
    const before = box.top;
    box.height = 2600;
    act(() => store.append(msg("新来的")));
    expect(box.top).toBe(before);
  });
});
