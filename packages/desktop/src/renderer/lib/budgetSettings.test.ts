// T-153：设置 › 预算的文案不再出现「复投」，对外统一叫「重写」（docs/ui-design.md §5.6）。
import { describe, expect, it } from "vitest";
import { BUDGET_COPY } from "./budgetSettings";

describe("BUDGET_COPY 文案", () => {
  it("面向用户的文案不含「复投」，花费里的重写部分叫「重写」", () => {
    const texts = Object.values(BUDGET_COPY).map((v) =>
      typeof v === "function" ? (v as (s: string) => string)("1.5") : v,
    );
    for (const t of texts) expect(t).not.toContain("复投");
    expect(BUDGET_COPY.spendResubmit("1.5")).toBe("（含重写 $1.5）");
    expect(BUDGET_COPY.spendHint).toContain("含重写");
  });
});
