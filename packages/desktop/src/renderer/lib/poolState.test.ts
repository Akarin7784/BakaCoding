import { describe, expect, it } from "vitest";
import type { BackpressureState, TicketView } from "../../shared/api";
import { BACKPRESSURE_REASON_LABEL, poolRowLabel, poolRowOf, poolRowTitle } from "./poolState";

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

describe("poolRowOf / poolRowLabel / poolRowTitle（UI-06b）", () => {
  it("X 只数 coding（跨项目，不算 resubmitting），Y 取 concurrency", () => {
    const row = poolRowOf(state({ concurrency: 3 }), [
      t("T-1", "coding"),
      t("T-2", "coding", "P-2"),
      t("T-3", "resubmitting"),
      t("T-4", "in_review"),
    ]);
    expect(row.coding).toBe(2);
    expect(row.limit).toBe(3);
  });

  it("暂停：反压开，行里带原因文字，不显示原因个数；悬停逐条列出", () => {
    const row = poolRowOf(
      state({ paused: true, reasons: ["review_backlog_pause", "daily_budget"] }),
      [t("T-1", "coding")],
    );
    expect(row.backpressure).toBe(true);
    expect(poolRowLabel(row)).toBe("并发 1/4 · 反压 开 · 评审积压：暂停派单、今日预算已用完");
    expect(poolRowTitle(row)).toBe("评审积压：暂停派单\n今日预算已用完");
  });

  it("只降并发（有 reasons 未暂停）：反压关、行里不标原因，悬停仍列出", () => {
    const row = poolRowOf(state({ concurrency: 2, reasons: ["review_backlog_halve"] }), []);
    expect(poolRowLabel(row)).toBe("并发 0/2 · 反压 关");
    expect(poolRowTitle(row)).toBe("评审积压：并发减半");
  });

  it("无原因：反压关，悬停为空", () => {
    const row = poolRowOf(state(), [t("T-1", "merged")]);
    expect(poolRowLabel(row)).toBe("并发 0/4 · 反压 关");
    expect(poolRowTitle(row)).toBe("");
  });

  it("每种原因都有固定、互不相同的中文文案", () => {
    const labels = Object.values(BACKPRESSURE_REASON_LABEL);
    expect(labels).toHaveLength(6);
    expect(new Set(labels).size).toBe(6);
    for (const l of labels) expect(l).toMatch(/[\u4e00-\u9fff]/);
  });
});
