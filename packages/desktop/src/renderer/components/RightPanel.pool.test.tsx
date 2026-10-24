// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RightPanel } from "./RightPanel";
import { projects } from "../mock/data";

afterEach(cleanup);
const view = projects[0]!;

describe("RightPanel 编码池行（UI-06b）", () => {
  it("反压开：整行强调色，文案按格式", () => {
    render(
      <RightPanel
        view={view}
        onOpenTopic={() => {}}
        pool={{ ok: true, row: { coding: 1, limit: 4, throttled: 2, backpressure: true } }}
      />,
    );
    const row = screen.getByText("并发 1/4 · 限流 2 · 反压 开");
    expect(row.className).toContain("text-accent");
    expect(row.dataset.backpressure).toBe("on");
  });

  it("反压关：不用强调色", () => {
    render(
      <RightPanel
        view={view}
        onOpenTopic={() => {}}
        pool={{ ok: true, row: { coding: 0, limit: 4, throttled: 0, backpressure: false } }}
      />,
    );
    const row = screen.getByText("并发 0/4 · 限流 0 · 反压 关");
    expect(row.className).not.toContain("text-accent");
  });

  it("ok:false 显示原因；不给 pool 时回退 view.pool", () => {
    render(
      <RightPanel view={view} onOpenTopic={() => {}} pool={{ ok: false, reason: "不可用X" }} />,
    );
    expect(screen.getByTestId("pool-status").textContent).toBe("编码池状态：不可用X");
    cleanup();
    render(<RightPanel view={view} onOpenTopic={() => {}} />);
    expect(screen.getByTestId("pool-status").textContent).toContain("并发 ");
  });
});
