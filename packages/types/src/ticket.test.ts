import { describe, expect, it } from "vitest";
import { TICKET_STATUSES, TicketStatusSchema, TERMINAL_TICKET_STATUSES } from "./index.js";

describe("TicketStatus", () => {
  it("共 9 个取值，pending 在首位", () => {
    expect(TICKET_STATUSES).toHaveLength(9);
    expect(TICKET_STATUSES[0]).toBe("pending");
  });
  it("拒绝未知状态", () => {
    expect(TicketStatusSchema.safeParse("queued").success).toBe(false);
    expect(TicketStatusSchema.safeParse("re_reviewing").success).toBe(true);
  });
  it("终态为 merged 与 escalated", () => {
    expect([...TERMINAL_TICKET_STATUSES]).toEqual(["merged", "escalated"]);
  });
});
