// @vitest-environment jsdom
import { EventSchema, TICKET_STATUSES } from "@bakacoding/types";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { projects } from "../../mock/data";
import { STATUS_ICON } from "../StatusIcon";
import { STATUS_LABEL, StatusBadge } from "./badge";

afterEach(cleanup);

describe("状态徽标（TicketStatus）", () => {
  it("每个状态的色调与 StatusIcon 一致（§5.2）：运行中 accent，冲突 / 上报 danger，已合入前景色，其余中性", () => {
    const expected = {
      pending: "muted",
      coding: "accent",
      in_review: "accent",
      re_reviewing: "accent",
      resubmitting: "accent",
      merge_queued: "muted",
      conflict: "danger",
      merged: "foreground",
      escalated: "danger",
    } as const;
    for (const s of TICKET_STATUSES) {
      render(<StatusBadge status={s} />);
      const el = screen.getByText(STATUS_LABEL[s]);
      expect(el.getAttribute("data-status")).toBe(s);
      expect(el.getAttribute("data-tone")).toBe(expected[s]);
      expect(el.getAttribute("data-tone")).toBe(STATUS_ICON[s].tone);
      cleanup();
    }
  });

  it("escalated 显示为需要人工介入，用 danger", () => {
    render(<StatusBadge status="escalated" />);
    expect(screen.getByText("需要人工介入").getAttribute("data-tone")).toBe("danger");
  });

  it("徽标里的图标只作装饰，不重复朗读", () => {
    render(<StatusBadge status="merged" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("已合入").querySelector("svg")).toBeTruthy();
  });
});

describe("假数据符合 @bakacoding/types 的事件 schema", () => {
  it("project_created 与 group_message 都能通过 EventSchema 校验", () => {
    for (const p of projects) {
      expect(EventSchema.safeParse(p.project).success).toBe(true);
      for (const m of p.messages) expect(EventSchema.safeParse(m).success).toBe(true);
    }
  });

  it("project_created 的 requirement_id 为 null；group_message 仍必须带需求", () => {
    for (const p of projects) expect(p.project.requirement_id).toBeNull();
    const msg = projects[0]!.messages[0]!;
    expect(msg.requirement_id).not.toBeNull();
    expect(EventSchema.safeParse({ ...msg, requirement_id: null }).success).toBe(false);
  });
});
