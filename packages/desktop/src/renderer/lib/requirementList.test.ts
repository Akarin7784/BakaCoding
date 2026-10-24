// UI-05e：需求列表数据（命名 / 分类 / 摘要 / 排序 / 时间）。
import { describe, expect, it } from "vitest";
import {
  fmtActivity,
  listRequirements,
  requirementName,
  REQUIREMENT_NAME_MAX,
} from "./requirementList";
import { msg, ticketOf } from "./testEvents";

const none = new Set<string>();

describe("requirementName", () => {
  it("只取第一行、脱敏、截到 80 字", () => {
    expect(requirementName("加登录页\n第二行")).toBe("加登录页");
    const long = "字".repeat(120);
    expect([...requirementName(long)]).toHaveLength(REQUIREMENT_NAME_MAX);
    expect([...requirementName("字".repeat(80))]).toHaveLength(80);
    const r = requirementName("修 /home/eva/secret.txt 的读取");
    expect(r).not.toContain("/home/eva");
  });
});

describe("listRequirements", () => {
  const tickets = [
    ticketOf({
      ticket_id: "T-2",
      requirement_id: "r1",
      created_at: "2026-10-24T03:00:00Z",
      title: "后来的单",
      status: "merged",
    }),
    ticketOf({
      ticket_id: "T-1",
      requirement_id: "r1",
      created_at: "2026-10-24T02:00:00Z",
      title: "最早的单\n细节",
      status: "in_review",
    }),
    ticketOf({
      ticket_id: "T-3",
      requirement_id: "r2",
      created_at: "2026-10-24T01:00:00Z",
      status: "merged",
    }),
    ticketOf({
      ticket_id: "T-4",
      requirement_id: "r3",
      created_at: "2026-10-24T00:30:00Z",
      status: "escalated",
    }),
    ticketOf({ ticket_id: "T-9", project_id: "other", requirement_id: "rx" }),
  ];

  it("名字取最早一张单的第一行；只列本项目", () => {
    const rows = listRequirements("p1", tickets, [], none);
    expect(rows.map((r) => r.requirement_id).sort()).toEqual(["r1", "r2", "r3"]);
    expect(rows.find((r) => r.requirement_id === "r1")!.name).toBe("最早的单");
  });

  it("分类：attention 集合优先；全部合入为已完成；其余进行中", () => {
    const rows = listRequirements("p1", tickets, [], new Set(["r3"]));
    const cat = Object.fromEntries(rows.map((r) => [r.requirement_id, r.category]));
    expect(cat).toEqual({ r1: "active", r2: "done", r3: "attention" });
    // 反向：不在集合里，escalated 的需求不算需要处理（集合由 attentionOf 统一算）
    expect(
      listRequirements("p1", tickets, [], none).find((r) => r.requirement_id === "r3")!.category,
    ).toBe("active");
  });

  it("摘要", () => {
    const rows = listRequirements("p1", tickets, [], new Set(["r3"]));
    const s = Object.fromEntries(rows.map((r) => [r.requirement_id, r.summary]));
    expect(s.r2).toBe("1 张单 · 全部合入");
    expect(s.r3).toBe("1 张单 · 1 张单需要你处理");
    expect(s.r1).toMatch(/^2 张单 · /);
    expect(
      listRequirements("p1", [ticketOf({ status: "merged" })], [], new Set(["r1"]))[0]!.summary,
    ).toBe("1 张单 · 高风险 PR 待你裁决");
  });

  it("按最近活动倒序；事件 ts 也算活动", () => {
    expect(listRequirements("p1", tickets, [], none).map((r) => r.requirement_id)).toEqual([
      "r1",
      "r2",
      "r3",
    ]);
    const ev = { ...msg("r3", "新消息"), ts: "2026-10-24T09:00:00Z" };
    const rows = listRequirements("p1", tickets, [ev], none);
    expect(rows.map((r) => r.requirement_id)).toEqual(["r3", "r1", "r2"]);
    expect(rows[0]!.last).toBe("2026-10-24T09:00:00Z");
  });
});

describe("fmtActivity", () => {
  const now = new Date(2026, 9, 24, 15, 0);
  it("今天 HH:MM，昨天，更早 M月D日，空 / 坏值为空", () => {
    expect(fmtActivity(new Date(2026, 9, 24, 12, 40).toISOString(), now)).toBe("12:40");
    expect(fmtActivity(new Date(2026, 9, 23, 23, 0).toISOString(), now)).toBe("昨天");
    expect(fmtActivity(new Date(2026, 9, 3, 8, 0).toISOString(), now)).toBe("10月3日");
    expect(fmtActivity("", now)).toBe("");
    expect(fmtActivity("bad", now)).toBe("");
  });
});
