// @vitest-environment jsdom
import { EventSchema, TICKET_STATUSES } from "@bakacoding/types";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { projects } from "../../mock/data";
import { STATUS_LABEL, StatusBadge } from "./badge";

afterEach(cleanup);

describe("状态徽标（TicketStatus）", () => {
  it("强调色只用于编码中、复投、冲突、已合并，其余中性", () => {
    const accent = new Set(["coding", "resubmitting", "conflict", "merged"]);
    for (const s of TICKET_STATUSES) {
      render(<StatusBadge status={s} />);
      const el = screen.getByText(STATUS_LABEL[s]);
      expect(el.getAttribute("data-status")).toBe(s);
      expect(el.getAttribute("data-accent")).toBe(String(accent.has(s)));
      cleanup();
    }
  });

  it("escalated 显示为需要人工介入", () => {
    render(<StatusBadge status="escalated" />);
    expect(screen.getByText("需要人工介入").getAttribute("data-accent")).toBe("false");
  });
});

describe("假数据符合 @bakacoding/types 的事件 schema", () => {
  it("project_created 与 group_message 都能通过 EventSchema 校验", () => {
    for (const p of projects) {
      expect(EventSchema.safeParse(p.project).success).toBe(true);
      for (const m of p.messages) expect(EventSchema.safeParse(m).success).toBe(true);
    }
  });
});
