// UI-01：文案表（docs/ui-design.md §5.6）。
import { GROUP_MESSAGE_KINDS, TICKET_STATUSES } from "@bakacoding/types";
import { describe, expect, it } from "vitest";
import {
  ESCALATION_REASON_LABEL,
  GROUP_MESSAGE_KIND_LABEL,
  MERGE_COPY,
  RESUBMIT_COPY,
  TICKET_STATUS_LABEL,
  TICKET_STEPS,
  TICKET_STEP_LABEL,
} from "./copy";

describe("文案表", () => {
  it("每个 TicketStatus 都有非空文案，且互不相同", () => {
    const labels = TICKET_STATUSES.map((s) => TICKET_STATUS_LABEL[s]);
    for (const l of labels) expect(l.trim()).not.toBe("");
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("merged 叫「已合入」，合入 main 叫「已合入 main」", () => {
    expect(TICKET_STATUS_LABEL.merged).toBe("已合入");
    expect(MERGE_COPY.merged).toBe("已合入");
    expect(MERGE_COPY.mergedMain).toBe("已合入 main");
    expect(TICKET_STEP_LABEL.merged).toBe("已合入");
  });

  it("面向用户的「复投」统一叫「重写」", () => {
    expect(TICKET_STATUS_LABEL.resubmitting).toBe("重写");
    expect(GROUP_MESSAGE_KIND_LABEL.resubmit).toBe("重写");
    expect(RESUBMIT_COPY.count(3)).toBe("重写 3 次");
    const all = [
      ...Object.values(TICKET_STATUS_LABEL),
      ...Object.values(GROUP_MESSAGE_KIND_LABEL),
      ...Object.values(ESCALATION_REASON_LABEL),
      ...Object.values(TICKET_STEP_LABEL),
      RESUBMIT_COPY.label,
      RESUBMIT_COPY.countTitle,
    ];
    for (const l of all) expect(l).not.toContain("复投");
  });

  it("群消息类型覆盖全部 kind（§4.5.1 标签）", () => {
    expect(Object.keys(GROUP_MESSAGE_KIND_LABEL).sort()).toEqual([...GROUP_MESSAGE_KINDS].sort());
    expect(GROUP_MESSAGE_KIND_LABEL).toMatchObject({
      dispatch: "派单",
      report: "汇报",
      escalation: "上报",
    });
  });

  it("步骤条五步：排队 → 编码 → 评审 → 合并队列 → 已合入（§4.4）", () => {
    expect(TICKET_STEPS.map((s) => TICKET_STEP_LABEL[s])).toEqual([
      "排队",
      "编码",
      "评审",
      "合并队列",
      "已合入",
    ]);
  });
});
