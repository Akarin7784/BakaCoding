import { describe, expect, it } from "vitest";
import type { TicketWarningView } from "../mock/types";
import {
  dedupeWarnings,
  sliceWarningsForDisplay,
  truncateDetail,
  WARNINGS_VISIBLE_MAX,
  WARNING_DETAIL_PREVIEW,
  WARNING_DETAIL_TITLE_MAX,
} from "./warnings";

const w = (n: number, ticket_id: string, code: string, detail = ""): TicketWarningView => ({
  event_id: `e${n}`,
  ts: "2026-10-17T00:00:00Z",
  requirement_id: "R-1",
  ticket_id,
  code,
  detail,
});

describe("警告列表（T-062）", () => {
  it("按 ticket_id+code 去重并累加 count，保留首次顺序", () => {
    const list = dedupeWarnings([
      w(1, "T-1", "fields_invalid", "a"),
      w(2, "T-1", "fields_invalid", "b"),
      w(3, "T-2", "pr_close_failed"),
      w(4, "T-1", "fields_invalid"),
    ]);
    expect(list.map((x) => [x.ticket_id, x.code, x.count, x.detail])).toEqual([
      ["T-1", "fields_invalid", 3, "a"],
      ["T-2", "pr_close_failed", 1, ""],
    ]);
  });

  it("detail 预览约 500 字，悬停全文上限 4000", () => {
    const long = "x".repeat(4500);
    const t = truncateDetail(long);
    expect(t.preview.length).toBe(WARNING_DETAIL_PREVIEW + 1); // +省略号
    expect(t.preview.endsWith("…")).toBe(true);
    expect(t.title.length).toBe(WARNING_DETAIL_TITLE_MAX);
    expect(t.truncated).toBe(true);
    expect(truncateDetail("短").truncated).toBe(false);
  });

  it("最多显示约 50 条，其余 +N 条", () => {
    const many = Array.from({ length: WARNINGS_VISIBLE_MAX + 7 }, (_, i) =>
      w(i, `T-${i}`, "fields_invalid"),
    );
    const { visible, more } = sliceWarningsForDisplay(many);
    expect(visible).toHaveLength(WARNINGS_VISIBLE_MAX);
    expect(more).toBe(7);
  });
});
