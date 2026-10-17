import { describe, expect, it } from "vitest";
import {
  formatHighRiskFile,
  HIGH_RISK_DECISION_ERROR_LABEL,
  HIGH_RISK_REASON_LABEL,
  highRiskDecisionErrorLabel,
  highRiskReasonLabel,
} from "./high-risk-labels";

describe("高风险文案（T-062）", () => {
  it("九个裁决错误码都有中文；stale_pr 固定「PR 已更新，请重新查看」", () => {
    expect(Object.keys(HIGH_RISK_DECISION_ERROR_LABEL).sort()).toEqual([
      "already_merged",
      "gate_off",
      "merge_in_progress",
      "not_found",
      "not_held",
      "not_high_risk",
      "stale_pr",
      "terminal",
      "unavailable",
    ]);
    expect(HIGH_RISK_DECISION_ERROR_LABEL.stale_pr).toBe("PR 已更新，请重新查看");
    expect(highRiskDecisionErrorLabel("stale_pr")).toBe("PR 已更新，请重新查看");
    expect(highRiskDecisionErrorLabel("future_code")).toBe("future_code");
  });

  it("四个 HighRiskReason 都有中文（含 diff_unavailable / unverified）", () => {
    expect(Object.keys(HIGH_RISK_REASON_LABEL).sort()).toEqual([
      "dependency_file",
      "dependency_kind",
      "diff_unavailable",
      "unverified",
    ]);
    expect(highRiskReasonLabel("diff_unavailable")).toContain("diff");
    expect(highRiskReasonLabel("unverified")).toContain("diff");
  });

  it("命中文件：有 old_path 写成「旧 → 新」，否则只写 path（T-065）", () => {
    expect(formatHighRiskFile({ path: "x.json", old_path: "package.json" })).toBe(
      "package.json → x.json",
    );
    expect(formatHighRiskFile({ path: "pnpm-lock.yaml" })).toBe("pnpm-lock.yaml");
  });
});
