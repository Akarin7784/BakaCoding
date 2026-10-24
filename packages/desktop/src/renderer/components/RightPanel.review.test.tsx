// @vitest-environment jsdom
// UI-06d2：Git 区「审查集成分支」——ok 时保存 head_sha，合入按钮才可点并透传该 sha；blocked 显示固定文案；
// main:merge 返回 stale_head / not_reviewed 时清掉 sha，合入按钮回到禁用。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopGitStatusResult,
  DesktopIntegrationReviewResult,
  DesktopMainMergeResult,
} from "../../shared/api";
import { INTEGRATION_BLOCK_TEXT, INTEGRATION_REVIEW_COPY, MAIN_MERGE_COPY } from "../lib/gitStatus";
import { READONLY_COPY } from "../lib/readonly";
import { projects } from "../mock/data";
import { RightPanel } from "./RightPanel";

afterEach(cleanup);
const view = projects[0]!;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const st: DesktopGitStatusResult = {
  ok: true,
  current_branch: "feat/x",
  integration_branch: "bakacoding/integration",
  ahead: 3,
  main_merge: "user",
};
const OK: DesktopIntegrationReviewResult = {
  ok: true,
  review: {
    result: "ok",
    pr_id: "pr-int",
    head_sha: SHA,
    base_sha: "b".repeat(40),
    summary: "原文 /home/secret 不该显示",
    ci: "green",
  },
};
const blocked = (
  reasons: Extract<
    Extract<DesktopIntegrationReviewResult, { ok: true }>["review"],
    { result: "blocked" }
  >["reasons"],
): DesktopIntegrationReviewResult => ({
  ok: true,
  review: { result: "blocked", pr_id: null, head_sha: null, reasons },
});
const panel = (p: Partial<Parameters<typeof RightPanel>[0]> = {}) =>
  render(
    <RightPanel
      view={view}
      tickets={[]}
      onOpenTicket={() => {}}
      gitStatus={st}
      mainMergeHead={null}
      {...p}
    />,
  );
const reviewBtn = () => screen.getByTestId("integration-review") as HTMLButtonElement;
const mergeBtn = () => screen.getByTestId("main-merge-button") as HTMLButtonElement;

describe("审查集成分支（UI-06d2）", () => {
  it("未审查：合入禁用并提示先审查；审查中两个按钮都禁用；ok 后合入可点并透传 sha", async () => {
    let resolve!: (r: DesktopIntegrationReviewResult) => void;
    const onReviewIntegration = vi.fn(
      () => new Promise<DesktopIntegrationReviewResult>((r) => (resolve = r)),
    );
    const onMergeMain = vi.fn(async (): Promise<DesktopMainMergeResult> => ({
      ok: true,
      result: "notified",
    }));
    panel({ onReviewIntegration, onMergeMain });
    expect(mergeBtn().disabled).toBe(true);
    expect(screen.getByTestId("main-merge-hint").textContent).toBe(MAIN_MERGE_COPY.needsReview);
    expect(reviewBtn().disabled).toBe(false);
    fireEvent.click(reviewBtn());
    expect(onReviewIntegration).toHaveBeenCalledTimes(1);
    expect(reviewBtn().disabled).toBe(true);
    expect(reviewBtn().textContent).toContain(INTEGRATION_REVIEW_COPY.reviewing);
    expect(mergeBtn().disabled).toBe(true);
    await act(async () => resolve(OK));
    expect(screen.getByTestId("integration-review-ok").textContent).toBe(
      INTEGRATION_REVIEW_COPY.passed,
    );
    expect(document.body.textContent).not.toContain("/home/secret");
    expect(mergeBtn().disabled).toBe(false);
    expect(screen.queryByTestId("main-merge-hint")).toBeNull();
    await act(async () => fireEvent.click(mergeBtn()));
    expect(onMergeMain).toHaveBeenCalledWith(SHA);
  });

  it.each([
    [[{ code: "tickets_in_flight" as const, ticket_ids: ["T-1", "T-2"] }], ["tickets_in_flight"]],
    [
      [
        {
          code: "ci_failed" as const,
          checks: [{ name: "ci", conclusion: "failure", url: "https://x" }],
        },
        {
          code: "model_blocked" as const,
          items: [{ detail: "/home/secret 有问题", file: "a.ts" }],
        },
      ],
      ["ci_failed", "model_blocked"],
    ],
    [[], ["review_failed"]],
  ] as const)("blocked → 固定文案（%#），不保存 sha，合入仍禁用", async (reasons, codes) => {
    panel({
      onReviewIntegration: async () => blocked([...reasons]),
      onMergeMain: async () => ({ ok: true, result: "notified" }),
    });
    await act(async () => fireEvent.click(reviewBtn()));
    const box = screen.getByTestId("integration-review-blocked");
    expect([...box.querySelectorAll("p")].map((p) => p.textContent)).toEqual(
      codes.map((c) => INTEGRATION_BLOCK_TEXT[c]),
    );
    expect(document.body.textContent).not.toMatch(/T-1|\/home\/secret|https:\/\/x|a\.ts/);
    expect(mergeBtn().disabled).toBe(true);
    expect(screen.queryByTestId("integration-review-ok")).toBeNull();
  });

  it("blocked 文案逐字锁定", () => {
    expect(INTEGRATION_BLOCK_TEXT).toEqual({
      nothing_to_merge: "集成分支没有新改动，不用审查",
      tickets_in_flight: "还有需求单在进行中，等它们完成后再审查",
      ci_failed: "CI 没通过，修好后再审查",
      ci_pending: "CI 还在跑，稍后再审查",
      model_blocked: "主管审查没通过，请看集成 PR 里的意见",
      review_failed: "审查没能完成，请稍后重试",
    });
  });

  it("审查失败（ok:false / 抛错）→ 显示固定 reason，合入仍禁用", async () => {
    panel({
      onReviewIntegration: async () => ({ ok: false, code: "unavailable", reason: "暂不可用" }),
      onMergeMain: async () => ({ ok: true, result: "notified" }),
    });
    await act(async () => fireEvent.click(reviewBtn()));
    expect(screen.getByTestId("integration-review-error").textContent).toBe("暂不可用");
    expect(mergeBtn().disabled).toBe(true);
    cleanup();
    panel({
      onReviewIntegration: async () => Promise.reject(new Error("/home/secret")),
      onMergeMain: async () => ({ ok: true, result: "notified" }),
    });
    await act(async () => fireEvent.click(reviewBtn()));
    expect(screen.getByTestId("integration-review-error").textContent).toBe(
      INTEGRATION_REVIEW_COPY.failed,
    );
  });

  it.each(["stale_head", "not_reviewed"] as const)(
    "main:merge 返回 %s → 清掉 sha，合入回到禁用并提示先审查；可重新审查",
    async (code) => {
      const onMergeMain = vi.fn(async (): Promise<DesktopMainMergeResult> => ({
        ok: false,
        code,
        reason: `固定文案-${code}`,
      }));
      const onReviewIntegration = vi.fn(async () => OK);
      panel({ onReviewIntegration, onMergeMain });
      await act(async () => fireEvent.click(reviewBtn()));
      expect(mergeBtn().disabled).toBe(false);
      await act(async () => fireEvent.click(mergeBtn()));
      expect(screen.getByTestId("main-merge-error").textContent).toBe(`固定文案-${code}`);
      expect(mergeBtn().disabled).toBe(true);
      expect(screen.getByTestId("main-merge-hint").textContent).toBe(MAIN_MERGE_COPY.needsReview);
      expect(screen.queryByTestId("integration-review-ok")).toBeNull();
      expect(reviewBtn().disabled).toBe(false);
      await act(async () => fireEvent.click(reviewBtn()));
      expect(onReviewIntegration).toHaveBeenCalledTimes(2);
      expect(mergeBtn().disabled).toBe(false);
    },
  );

  it.each(["conflict", "rate_limit"] as const)(
    "main:merge 返回 %s → 保留 sha，可重试",
    async (code) => {
      panel({
        onReviewIntegration: async () => OK,
        onMergeMain: async () => ({ ok: false, code, reason: "x" }),
      });
      await act(async () => fireEvent.click(reviewBtn()));
      await act(async () => fireEvent.click(mergeBtn()));
      expect(mergeBtn().disabled).toBe(false);
    },
  );

  it("只读 / 没接 integration:review → 审查按钮禁用", () => {
    panel({ readonly: true, onReviewIntegration: async () => OK });
    expect(reviewBtn().disabled).toBe(true);
    expect(screen.getByTestId("main-merge-hint").textContent).toBe(READONLY_COPY.mergeMainDisabled);
    cleanup();
    panel({});
    expect(reviewBtn().disabled).toBe(true);
  });

  it("supervisor 模式不显示审查按钮", () => {
    panel({ gitStatus: { ...st, main_merge: "supervisor" }, onReviewIntegration: async () => OK });
    expect(screen.queryByTestId("integration-review")).toBeNull();
  });
});
