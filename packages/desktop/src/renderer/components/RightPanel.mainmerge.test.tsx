// @vitest-environment jsdom
// UI-06d：右面板 Git 区「合入 main」入口——main_merge=user 时按钮（透传审查过的 head_sha），
// supervisor 时固定说明；合入中 / 结果 / 错误（主进程固定文案）；没审过、没领先、只读时禁用并说明。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopGitStatusResult, DesktopMainMergeResult } from "../../shared/api";
import { MAIN_MERGE_COPY } from "../lib/gitStatus";
import { READONLY_COPY } from "../lib/readonly";
import { projects } from "../mock/data";
import { RightPanel } from "./RightPanel";

afterEach(cleanup);
const view = projects[0]!;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const st = (
  o: Partial<Extract<DesktopGitStatusResult, { ok: true }>> = {},
): DesktopGitStatusResult => ({
  ok: true,
  current_branch: "feat/x",
  integration_branch: "bakacoding/integration",
  ahead: 3,
  main_merge: "user",
  ...o,
});
const panel = (p: Partial<Parameters<typeof RightPanel>[0]> = {}) =>
  render(<RightPanel view={view} tickets={[]} onOpenTicket={() => {}} gitStatus={st()} {...p} />);
const btn = () => screen.getByRole("button", { name: /合入 main/ }) as HTMLButtonElement;

describe("Git 区合入 main（UI-06d）", () => {
  it("领先数显示具体数字（P3）", () => {
    panel({ gitStatus: st({ ahead: 7 }) });
    expect(screen.getByTestId("git-ahead").textContent).toBe(
      "集成 bakacoding/integration（领先 main 7）",
    );
  });

  it("可合入：点击透传 head_sha，合入中按钮禁用，成功显示短 sha", async () => {
    let resolve!: (r: DesktopMainMergeResult) => void;
    const onMergeMain = vi.fn(() => new Promise<DesktopMainMergeResult>((r) => (resolve = r)));
    panel({ mainMergeHead: SHA, onMergeMain });
    expect(btn().disabled).toBe(false);
    expect(screen.queryByTestId("main-merge-hint")).toBeNull();
    fireEvent.click(btn());
    expect(onMergeMain).toHaveBeenCalledWith(SHA);
    expect(btn().disabled).toBe(true);
    expect(btn().textContent).toContain(MAIN_MERGE_COPY.merging);
    await act(async () => resolve({ ok: true, result: "merged", sha: "abcdef1".padEnd(40, "0") }));
    expect(screen.getByTestId("main-merge-result").textContent).toBe("已合入 main（abcdef1）");
  });

  it("notified → 固定「没有合入，已转为通知」", async () => {
    panel({ mainMergeHead: SHA, onMergeMain: async () => ({ ok: true, result: "notified" }) });
    await act(async () => fireEvent.click(btn()));
    expect(screen.getByTestId("main-merge-result").textContent).toBe(MAIN_MERGE_COPY.notified);
  });

  it("错误：显示主进程给的固定文案；抛错时固定「合入 main 失败」", async () => {
    panel({
      mainMergeHead: SHA,
      onMergeMain: async () => ({
        ok: false,
        code: "stale_head",
        reason: "集成分支在审查后有新提交，请重新审查",
      }),
    });
    await act(async () => fireEvent.click(btn()));
    expect(screen.getByTestId("main-merge-error").textContent).toBe(
      "集成分支在审查后有新提交，请重新审查",
    );
    cleanup();
    panel({ mainMergeHead: SHA, onMergeMain: async () => Promise.reject(new Error("/home/x")) });
    await act(async () => fireEvent.click(btn()));
    expect(screen.getByTestId("main-merge-error").textContent).toBe(MAIN_MERGE_COPY.failed);
  });

  it("没有审查过的 head → 禁用并提示先审查", () => {
    panel({ mainMergeHead: null, onMergeMain: vi.fn() });
    expect(btn().disabled).toBe(true);
    expect(screen.getByTestId("main-merge-hint").textContent).toBe(MAIN_MERGE_COPY.needsReview);
  });

  it("没领先 → 禁用并提示", () => {
    panel({ gitStatus: st({ ahead: 0 }), mainMergeHead: SHA, onMergeMain: vi.fn() });
    expect(btn().disabled).toBe(true);
    expect(screen.getByTestId("main-merge-hint").textContent).toBe(MAIN_MERGE_COPY.nothingAhead);
  });

  it("只读 → 禁用并说明", () => {
    panel({ readonly: true, mainMergeHead: SHA, onMergeMain: vi.fn() });
    expect(btn().disabled).toBe(true);
    expect(btn().title).toBe(READONLY_COPY.mergeMainDisabled);
  });

  it("main_merge=supervisor → 没有按钮，只有固定说明", () => {
    panel({
      gitStatus: st({ main_merge: "supervisor" }),
      mainMergeHead: SHA,
      onMergeMain: vi.fn(),
    });
    expect(screen.queryByRole("button", { name: /合入 main/ })).toBeNull();
    expect(screen.getByTestId("main-merge-auto").textContent).toBe(MAIN_MERGE_COPY.supervisorMode);
  });
});
