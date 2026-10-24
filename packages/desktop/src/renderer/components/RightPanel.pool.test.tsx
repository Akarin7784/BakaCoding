// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RightPanel } from "./RightPanel";
import type { PoolRow } from "../lib/poolState";
import { projects } from "../mock/data";

afterEach(cleanup);
const view = projects[0]!;

const row = (backpressure: boolean, reasons: PoolRow["reasons"]) => ({
  ok: true as const,
  row: { coding: 1, limit: 4, reasons, backpressure },
});

describe("RightPanel 编码池行（UI-06b）", () => {
  it("反压开：整行强调色，带原因文字，悬停逐条列出", () => {
    render(
      <RightPanel
        view={view}
        onOpenTopic={() => {}}
        pool={row(true, ["review_backlog_pause", "daily_budget"])}
      />,
    );
    const el = screen.getByText("并发 1/4 · 反压 开 · 评审积压：暂停派单、今日预算已用完");
    expect(el.className).toContain("text-accent");
    expect(el.dataset.backpressure).toBe("on");
    expect(el.getAttribute("title")).toBe("评审积压：暂停派单\n今日预算已用完");
  });

  it("只降并发：反压关、不用强调色、行里不标原因，悬停仍列出", () => {
    render(
      <RightPanel view={view} onOpenTopic={() => {}} pool={row(false, ["review_backlog_halve"])} />,
    );
    const el = screen.getByText("并发 1/4 · 反压 关");
    expect(el.className).not.toContain("text-accent");
    expect(el.getAttribute("title")).toBe("评审积压：并发减半");
  });

  it("无原因：反压关，没有悬停提示", () => {
    render(<RightPanel view={view} onOpenTopic={() => {}} pool={row(false, [])} />);
    expect(screen.getByText("并发 1/4 · 反压 关").hasAttribute("title")).toBe(false);
  });

  it("ok:false 显示原因；不给 pool 时回退 view.pool", () => {
    render(
      <RightPanel view={view} onOpenTopic={() => {}} pool={{ ok: false, reason: "不可用X" }} />,
    );
    expect(screen.getByTestId("pool-status").textContent).toBe("不可用X");
    cleanup();
    render(<RightPanel view={view} onOpenTopic={() => {}} />);
    expect(screen.getByTestId("pool-status").textContent).toContain("并发 ");
  });
});
