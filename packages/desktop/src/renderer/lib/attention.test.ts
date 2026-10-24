// UI-05d：左栏红点 / 需求页高风险过滤。
import { describe, expect, it } from "vitest";
import { attentionOf, highRiskOfRequirement } from "./attention";
import { hr, ticketOf } from "./testEvents";

const tickets = [
  ticketOf({ ticket_id: "T-1", requirement_id: "r1", project_id: "p1" }),
  ticketOf({ ticket_id: "T-2", requirement_id: "r2", project_id: "p2", status: "escalated" }),
  ticketOf({ ticket_id: "T-3", requirement_id: "r3", project_id: "p3", status: "merged" }),
];

describe("attentionOf", () => {
  it("高风险待裁决 + 上报的单都算需要处理；正常单不算", () => {
    const a = attentionOf(tickets, [hr()]);
    expect([...a.requirements].sort()).toEqual(["r1", "r2"]);
    expect([...a.projects].sort()).toEqual(["p1", "p2"]);
  });

  it("快照里没有这张单：项目照样标红，需求不标", () => {
    const a = attentionOf([], [hr({ ticket_id: "T-x", project_id: "p9" })]);
    expect([...a.projects]).toEqual(["p9"]);
    expect(a.requirements.size).toBe(0);
  });

  it("什么都没有时为空", () => {
    const a = attentionOf([tickets[2]!], []);
    expect(a.projects.size + a.requirements.size).toBe(0);
  });
});

describe("highRiskOfRequirement", () => {
  it("只留本需求的单", () => {
    const items = [hr(), hr({ ticket_id: "T-2", pr_id: "pr-2" })];
    expect(highRiskOfRequirement("r1", tickets, items).map((i) => i.ticket_id)).toEqual(["T-1"]);
    expect(highRiskOfRequirement("r3", tickets, items)).toEqual([]);
  });
});
