import { describe, expect, it } from "vitest";
import { countActiveTickets, isTicketActive } from "./active-tickets.js";

describe("isTicketActive / countActiveTickets（T-072）", () => {
  it("merged / escalated 不算进行中；其余（含没有状态）都算", () => {
    expect(isTicketActive("merged")).toBe(false);
    expect(isTicketActive("escalated")).toBe(false);
    for (const s of ["pending", "coding", "in_review", "merge_queued", "conflict", undefined, null])
      expect(isTicketActive(s)).toBe(true);
    expect(countActiveTickets([{ status: "coding" }, { status: "merged" }, {}])).toBe(2);
  });
});
