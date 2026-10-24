import { describe, expect, it } from "vitest";
import type { BackpressureState, TicketView } from "../../shared/api";
import { poolRowLabel, poolRowOf } from "./poolState";

const state = (o: Partial<BackpressureState> = {}): BackpressureState => ({
  paused: false,
  concurrency: 4,
  reasons: [],
  review_backlog: { pending: 0, capacity: 8 },
  supervisor_backlog: null,
  pending_prs: { merge_queued: 0, in_review: 0, total: 0, limit: 10, high_risk_held: 0 },
  daily_budget_exhausted: false,
  ...o,
});
const t = (id: string, status: TicketView["status"], pid = "P-1"): TicketView => ({
  ticket_id: id,
  project_id: pid,
  requirement_id: "R-1",
  created_at: "2026-10-17T01:00:00.000Z",
  title: id,
  status,
  resubmit_count: 0,
});

describe("poolRowOf / poolRowLabel（UI-06b）", () => {
  it("X 只数 coding（跨项目），Y 取 concurrency，限流数 reasons，反压看 paused", () => {
    const row = poolRowOf(
      state({ concurrency: 3, reasons: ["review_backlog_halve", "daily_budget"], paused: true }),
      [t("T-1", "coding"), t("T-2", "coding", "P-2"), t("T-3", "in_review"), t("T-4", "pending")],
    );
    expect(row).toEqual({ coding: 2, limit: 3, throttled: 2, backpressure: true });
    expect(poolRowLabel(row)).toBe("并发 2/3 · 限流 2 · 反压 开");
  });

  it("没有 coding 单、无原因、未暂停", () => {
    const row = poolRowOf(state(), [t("T-1", "merged")]);
    expect(poolRowLabel(row)).toBe("并发 0/4 · 限流 0 · 反压 关");
  });
});
