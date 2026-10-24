// UI-06a：右面板需求单列表 / 动态状态行的纯函数（只读快照 tickets）。
import { describe, expect, it } from "vitest";
import type { TicketView } from "../../shared/api";
import {
  activeTicketLine,
  effectiveStatusFilter,
  filterTicketRows,
  projectTicketRows,
  statusFilterOptions,
} from "./ticketList";

const t = (o: Partial<TicketView> & Pick<TicketView, "ticket_id">): TicketView => ({
  project_id: "P-1",
  requirement_id: "R-1",
  created_at: "2026-10-24T01:00:00Z",
  title: o.ticket_id,
  status: "pending",
  resubmit_count: 0,
  ...o,
});

const tickets: TicketView[] = [
  t({ ticket_id: "T-3", created_at: "2026-10-24T03:00:00Z", status: "in_review" }),
  t({ ticket_id: "T-1", created_at: "2026-10-24T01:00:00Z", status: "merged" }),
  t({ ticket_id: "T-2", created_at: "2026-10-24T02:00:00Z", status: "coding", resubmit_count: 2 }),
  t({ ticket_id: "X-1", project_id: "P-2", status: "coding" }),
];

describe("projectTicketRows", () => {
  it("只列当前项目，按创建时间升序；没有项目时为空", () => {
    expect(projectTicketRows(tickets, "P-1").map((r) => r.ticket_id)).toEqual([
      "T-1",
      "T-2",
      "T-3",
    ]);
    expect(projectTicketRows(tickets, "P-2").map((r) => r.ticket_id)).toEqual(["X-1"]);
    expect(projectTicketRows(tickets, undefined)).toEqual([]);
  });

  it("标题先脱敏（路径、密钥不上屏），状态和重写次数原样", () => {
    const [row] = projectTicketRows(
      [
        t({
          ticket_id: "T-9",
          title: "改 /home/eva/proj/secret.ts 里 sk-abcdefghijklmnopqrstuvwxyz123456",
          status: "resubmitting",
          resubmit_count: 2,
        }),
      ],
      "P-1",
    );
    expect(row!.title).not.toContain("/home/eva");
    expect(row!.title).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(row!.title).toContain("[REDACTED");
    expect(row!.status).toBe("resubmitting");
    expect(row!.resubmit_count).toBe(2);
  });
});

describe("按状态筛选", () => {
  const rows = projectTicketRows(tickets, "P-1");
  it("选项只给本项目出现过的状态，按状态表顺序", () => {
    expect(statusFilterOptions(rows)).toEqual(["coding", "in_review", "merged"]);
  });
  it("all 不过滤；选某个状态只留该状态", () => {
    expect(filterTicketRows(rows, "all")).toHaveLength(3);
    expect(filterTicketRows(rows, "coding").map((r) => r.ticket_id)).toEqual(["T-2"]);
  });
  it("筛选值不在选项里（切项目 / 状态变了）时退回 all", () => {
    expect(effectiveStatusFilter("coding", ["coding"])).toBe("coding");
    expect(effectiveStatusFilter("conflict", ["coding"])).toBe("all");
    expect(effectiveStatusFilter("all", [])).toBe("all");
  });
});

describe("activeTicketLine（动态底部状态行）", () => {
  it("只列当前项目在跑的单，按创建时间", () => {
    expect(activeTicketLine(tickets, "P-1")).toBe("T-2 编码中 · T-3 评审中");
    expect(activeTicketLine(tickets, "P-2")).toBe("X-1 编码中");
  });
  it("没有项目 / 没有在跑的单给空串", () => {
    expect(activeTicketLine(tickets, undefined)).toBe("");
    expect(activeTicketLine([tickets[1]!], "P-1")).toBe("");
  });
});
