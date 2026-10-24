// @vitest-environment jsdom
// T-127：右面板「动态」的纯函数（§4.5.1）：发送方 / 接收方、按单过滤、底部状态行、贴底判断。
import { describe, expect, it } from "vitest";
import {
  activityFilterOptions,
  activityItems,
  effectiveTicketFilter,
  filterActivity,
  formatActivityTime,
  isNearBottom,
  messageParties,
} from "./activity";
import { projects } from "../mock/data";

const todo = projects[0]!;

describe("messageParties", () => {
  it("主管发的派给该单副 Agent，副 Agent 发的都回主管；没有单号时只写副 Agent", () => {
    expect(messageParties("supervisor", "T-1")).toEqual({
      sender: "主管",
      receiver: "副 Agent T-1",
      supervisorSender: true,
    });
    expect(messageParties("sub_agent", "T-2")).toEqual({
      sender: "副 Agent T-2",
      receiver: "主管",
      supervisorSender: false,
    });
    expect(messageParties("supervisor", null).receiver).toBe("副 Agent");
  });
});

describe("activityItems", () => {
  it("按 seq 升序，带类型标签 / 时间 / 单号", () => {
    const items = activityItems(todo);
    expect(items.map((i) => i.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(items[0]).toMatchObject({
      event_id: "evt-2",
      sender: "主管",
      receiver: "副 Agent T-1",
      kindLabel: "派单",
      ticket_id: "T-1",
      content: "T-1：给 Todo 加 due_date 字段，写入范围 src/model/**。",
    });
    expect(items[0]!.time).toMatch(/^\d{2}:\d{2}$/);
    expect(activityItems(undefined)).toEqual([]);
  });
});

describe("按单过滤", () => {
  it("选项按首次出现顺序、去重；all 不过滤、指定单号只留该单", () => {
    expect(activityFilterOptions(todo)).toEqual(["T-1", "T-2"]);
    expect(activityFilterOptions(undefined)).toEqual([]);
    const items = activityItems(todo);
    expect(filterActivity(items, "all")).toHaveLength(5);
    expect(filterActivity(items, "T-2").map((i) => i.seq)).toEqual([5, 6]);
    expect(filterActivity(items, "T-404")).toEqual([]);
  });
});

describe("实际生效的筛选值（T-127 评审 P2：切项目不留在旧单号）", () => {
  it("all 保持；选项里有的保持；选项里没有的退回 all", () => {
    expect(effectiveTicketFilter("all", ["T-1", "T-2"])).toBe("all");
    expect(effectiveTicketFilter("T-2", ["T-1", "T-2"])).toBe("T-2");
    // 切到另一个项目，旧单号不在新选项里
    expect(effectiveTicketFilter("T-2", ["T-7"])).toBe("all");
    expect(effectiveTicketFilter("T-2", [])).toBe("all");
  });
});

describe("formatActivityTime / isNearBottom", () => {
  it("时间解析成 HH:mm，坏时间给「—」", () => {
    expect(formatActivityTime("2026-10-17T02:00:00Z")).toMatch(/^\d{2}:\d{2}$/);
    expect(formatActivityTime("not-a-time")).toBe("—");
  });

  it("距底部 24px 以内算贴底", () => {
    expect(isNearBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 300 })).toBe(false);
    expect(isNearBottom({ scrollTop: 676, scrollHeight: 1000, clientHeight: 300 })).toBe(true);
    expect(isNearBottom({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })).toBe(true);
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toBe(true);
  });
});
