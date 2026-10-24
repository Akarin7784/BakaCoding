// @vitest-environment jsdom
// UI-05b：TicketStepper（docs/ui-design.md §4.4）。
import { TICKET_STATUSES, type TicketStatus } from "@bakacoding/types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TicketView, UiEvent } from "../../shared/api";
import { STEPPER_COPY, TICKET_STATUS_LABEL, TICKET_STEPS } from "../lib/copy";
import { STATUS_STEP, TicketStepper, stepMarks } from "./TicketStepper";

afterEach(cleanup);

function ticket(status: TicketStatus, over: Partial<TicketView> = {}): TicketView {
  return {
    ticket_id: "T-1",
    project_id: "p1",
    requirement_id: "r1",
    created_at: "2026-10-24T00:00:00Z",
    title: "加登录页",
    status,
    resubmit_count: 0,
    ...over,
  };
}

let seq = 0;
function changed(ticket_id: string, to: TicketStatus, from: TicketStatus | null = null): UiEvent {
  return {
    type: "ticket_status_changed",
    seq: seq++,
    ts: "2026-10-24T00:00:00Z",
    requirement_id: "r1",
    ticket_id,
    payload: { project_id: "p1", from, to },
  } as unknown as UiEvent;
}

function row() {
  return screen.getByRole("group", { name: STEPPER_COPY.label("T-1") });
}
function stepState(step: string) {
  return row().querySelector(`[data-step="${step}"]`)?.getAttribute("data-state");
}

describe("TicketStepper", () => {
  it("9 个状态各落在哪一步（§4.4 五步）", () => {
    expect(Object.keys(STATUS_STEP).sort()).toEqual([...TICKET_STATUSES].sort());
    expect(STATUS_STEP).toEqual({
      pending: "pending",
      coding: "coding",
      resubmitting: "coding",
      in_review: "in_review",
      re_reviewing: "in_review",
      merge_queued: "merge_queued",
      conflict: "merge_queued",
      merged: "merged",
      escalated: null,
    });
  });

  it.each(TICKET_STATUSES.filter((s) => s !== "escalated"))(
    "%s：当前步、前面已完成、后面未开始，当前步显示状态文案和图标",
    (s) => {
      render(<TicketStepper ticket={ticket(s)} events={[]} reviewLimit={3} />);
      const idx = TICKET_STEPS.indexOf(STATUS_STEP[s]!);
      TICKET_STEPS.forEach((step, i) =>
        expect(stepState(step)).toBe(i < idx ? "done" : i === idx ? "current" : "todo"),
      );
      const cur = row().querySelector('[aria-current="step"]');
      expect(cur?.textContent).toContain(TICKET_STATUS_LABEL[s]);
      expect(row().querySelector("[data-icon]")?.getAttribute("data-status")).toBe(s);
    },
  );

  it("评审步骤显示「第 N 轮 / 上限」，N = 重写次数 + 1，上限来自 props", () => {
    render(
      <TicketStepper
        ticket={ticket("in_review", { resubmit_count: 1 })}
        events={[]}
        reviewLimit={4}
      />,
    );
    expect(row().querySelector("[data-round]")?.textContent).toBe("第 2 轮 / 4");
    cleanup();
    render(<TicketStepper ticket={ticket("pending")} events={[]} reviewLimit={4} />);
    expect(row().querySelector("[data-round]")).toBeNull();
  });

  it("当前步只看快照状态：事件说已到 merged 也不改", () => {
    render(
      <TicketStepper
        ticket={ticket("coding")}
        events={[changed("T-1", "merge_queued"), changed("T-1", "merged")]}
        reviewLimit={3}
      />,
    );
    expect(stepState("coding")).toBe("current");
    expect(stepState("merged")).toBe("todo");
    expect(row().dataset.status).toBe("coding");
  });

  it("小标记只来自本单的 ticket_status_changed；别的单、别的事件不算", () => {
    const events = [
      changed("T-1", "conflict"),
      changed("T-1", "re_reviewing"),
      changed("T-1", "re_reviewing"),
      changed("T-2", "conflict"),
      { ...changed("T-1", "conflict"), type: "ticket_warning" } as unknown as UiEvent,
    ];
    expect(stepMarks("T-1", events)).toEqual({ conflict: 1, reReview: 2 });
    expect(stepMarks("T-2", events)).toEqual({ conflict: 1, reReview: 0 });
    render(<TicketStepper ticket={ticket("merge_queued")} events={events} reviewLimit={3} />);
    const conflict = row().querySelector('[data-step="merge_queued"] [data-mark="conflict"]');
    expect(conflict?.textContent).toBe("冲突");
    const re = row().querySelector('[data-step="in_review"] [data-mark="re_review"]');
    expect(re?.textContent).toBe("重新评审×2");
  });

  it("没有事件的旧单（T-085 之前）不显示标记", () => {
    render(
      <TicketStepper
        ticket={ticket("merged")}
        events={[changed("T-9", "conflict")]}
        reviewLimit={3}
      />,
    );
    expect(row().querySelector("[data-mark]")).toBeNull();
  });

  it("上报的单整行标红，「需要你处理」交给回调；其他状态没有按钮", () => {
    const onAction = vi.fn();
    render(
      <TicketStepper
        ticket={ticket("escalated")}
        events={[]}
        reviewLimit={3}
        onEscalationAction={onAction}
      />,
    );
    expect(row().dataset.escalated).toBe("true");
    expect(row().className).toContain("bg-danger-soft");
    fireEvent.click(screen.getByRole("button", { name: STEPPER_COPY.needsYou }));
    expect(onAction).toHaveBeenCalledWith("T-1");
    expect(row().querySelector('[aria-current="step"]')).toBeNull();
    cleanup();
    render(
      <TicketStepper
        ticket={ticket("conflict")}
        events={[]}
        reviewLimit={3}
        onEscalationAction={onAction}
      />,
    );
    expect(row().dataset.escalated).toBeUndefined();
    expect(row().className).not.toContain("bg-danger");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("文案不出现「复投」", () => {
    const all = [
      ...Object.values(STEPPER_COPY).map((v) =>
        typeof v === "function" ? (v as (a: never, b: never) => string)(2 as never, 3 as never) : v,
      ),
    ];
    for (const l of all) expect(l).not.toContain("复投");
    for (const s of TICKET_STATUSES) {
      render(
        <TicketStepper
          ticket={ticket(s, { resubmit_count: 2 })}
          events={[changed("T-1", "conflict"), changed("T-1", "re_reviewing")]}
          reviewLimit={3}
        />,
      );
      expect(row().textContent).not.toContain("复投");
      expect(row().getAttribute("aria-label")).not.toContain("复投");
      cleanup();
    }
  });
});
