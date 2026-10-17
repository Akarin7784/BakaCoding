// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { projects } from "../mock/data";
import { ProjectGroup } from "./ProjectGroup";
import { UnattributedPanel } from "./Escalations";

afterEach(cleanup);

describe("只读标签只在后端只读时显示（T-077）", () => {
  it.each([
    [true, 1],
    [false, 0],
  ])("ProjectGroup readonly=%s → 标签 %i 个", (readonly, n) => {
    render(
      <ProjectGroup
        view={projects[0]!}
        calls={{}}
        sidebarOpen={false}
        onToggleSidebar={() => {}}
        readonly={readonly}
      />,
    );
    expect(screen.queryAllByTestId("readonly-tag")).toHaveLength(n);
  });

  it.each([
    [true, 1],
    [false, 0],
  ])("未归属 readonly=%s → 标签 %i 个", (readonly, n) => {
    render(<UnattributedPanel escalations={[]} readonly={readonly} />);
    expect(screen.queryAllByTestId("readonly-tag")).toHaveLength(n);
  });
});
