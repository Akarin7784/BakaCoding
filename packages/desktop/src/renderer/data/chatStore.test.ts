// UI-04a：chatStore 的 hydrate / loadOlder / 按 message_id 去重。
import { describe, expect, it, vi } from "vitest";
import type { DesktopHistoryResult, DesktopSupervisorMessage } from "../../shared/api";
import { CHAT_HISTORY_PAGE, ChatStore, replyMessageId } from "./chatStore";

const msg = (id: string, role: "user" | "supervisor" = "user"): DesktopSupervisorMessage => ({
  message_id: id,
  project_id: null,
  role,
  kind: role === "supervisor" ? "answer" : null,
  content: id,
  requirement_id: null,
  ticket_ids: [],
  created_at: 0,
});
const page = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => msg(`m${String(from + i).padStart(4, "0")}`));
const ids = (s: ChatStore) => s.getSnapshot().items.map((m) => m.message_id);

describe("ChatStore 去重（UI-04a）", () => {
  it("hydrate 里重复的 message_id 只留一条", () => {
    const s = new ChatStore();
    s.hydrate([msg("a"), msg("b"), msg("a")]);
    expect(ids(s)).toEqual(["a", "b"]);
  });

  it("append 同一 message_id（重试）不重复", () => {
    const s = new ChatStore();
    s.append(msg("u-1"));
    s.append(msg("u-1"));
    s.append(msg(replyMessageId("u-1"), "supervisor"));
    expect(ids(s)).toEqual(["u-1", "u-1-r"]);
  });

  it("hydrate 只生效一次；先追加的本地消息和历史重复时不重复", () => {
    const s = new ChatStore();
    s.append(msg("u-1"));
    expect(s.hydrate([msg("m0"), msg("u-1")])).toBe(true);
    expect(s.hydrate([msg("x")])).toBe(false);
    expect(ids(s)).toEqual(["m0", "u-1"]);
  });
});

describe("ChatStore.loadOlder（UI-04a）", () => {
  it("before 用当前最早一条的 message_id，取回的一页放到最前，去重", async () => {
    const s = new ChatStore();
    s.hydrate(page(100, CHAT_HISTORY_PAGE));
    expect(s.getSnapshot().hasOlder).toBe(true);
    const fetch = vi.fn<(before: string) => Promise<DesktopHistoryResult>>(async () => ({
      ok: true,
      messages: [...page(50, CHAT_HISTORY_PAGE), msg("m0100")],
    }));
    await s.loadOlder(fetch);
    expect(fetch).toHaveBeenCalledWith("m0100");
    const all = ids(s);
    expect(all).toHaveLength(100);
    expect(all[0]).toBe("m0050");
    expect(all.filter((x) => x === "m0100")).toHaveLength(1);
    // 第二页游标前移到新的最早一条
    fetch.mockResolvedValueOnce({ ok: true, messages: page(40, 10) });
    await s.loadOlder(fetch);
    expect(fetch).toHaveBeenLastCalledWith("m0050");
    expect(ids(s)[0]).toBe("m0040");
    // 不满一页：到头了，不再取
    expect(s.getSnapshot().hasOlder).toBe(false);
    await s.loadOlder(fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("首屏不满一页时不取；取失败只结束加载、不清记录", async () => {
    const s = new ChatStore();
    s.hydrate(page(0, 3));
    const fetch = vi.fn(async (): Promise<DesktopHistoryResult> => ({ ok: true, messages: [] }));
    await s.loadOlder(fetch);
    expect(fetch).not.toHaveBeenCalled();

    const t = new ChatStore();
    t.hydrate(page(100, CHAT_HISTORY_PAGE));
    await t.loadOlder(async () => ({ ok: false, reason: "读取对话历史失败" }));
    expect(ids(t)).toHaveLength(CHAT_HISTORY_PAGE);
    expect(t.getSnapshot().loadingOlder).toBe(false);
  });
});
