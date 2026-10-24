// @vitest-environment jsdom
// UI-10：内容区根是 overflow hidden，每个可能超高的视图都要有自己的滚动区（min-h-0 flex-1 overflow-y-auto），
// 外层 flex 祖先 min-h-0，否则底部会被裁掉。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ticketOf } from "../lib/testEvents";
import { projects } from "../mock/data";
import type { EscalationView } from "../mock/types";
import { UnattributedPanel } from "./Escalations";
import { ProjectPage } from "./ProjectPage";
import { RequirementPage } from "./RequirementPage";
import { SettingsPanel } from "./SettingsPanel";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

afterEach(cleanup);

const SCROLL = ["min-h-0", "flex-1", "overflow-y-auto"];
const cls = (el: Element) => el.className.split(/\s+/);
const expectScroll = (id: string) =>
  expect(cls(screen.getByTestId(id))).toEqual(expect.arrayContaining(SCROLL));
const expectShrinkable = (el: Element) => expect(cls(el)).toContain("min-h-0");

const esc = (i: number): EscalationView => ({
  event_id: `e-${i}`,
  ticket_id: `T-${i}`,
  requirement_id: "r1",
  reason: "review_limit",
  ts: "2026-10-17T01:00:00.000Z",
});

describe("内容区各视图有自己的滚动区（UI-10）", () => {
  it("需求页：section min-h-0，正文 min-h-0 flex-1 overflow-y-auto", () => {
    const tickets = [ticketOf({ ticket_id: "T-1", requirement_id: "r1", title: "需求" })];
    render(<RequirementPage requirementId="r1" tickets={tickets} events={[]} api={null} />);
    expectScroll("requirement-scroll");
    expectShrinkable(screen.getByTestId("requirement-scroll").parentElement!);
  });

  it("项目页：列表区可滚，顶部人工介入条限高自己滚", () => {
    const view = { ...projects[0]!, escalations: [esc(1), esc(2)], warnings: [] };
    render(
      <ProjectPage
        view={view}
        tickets={[]}
        events={[]}
        attention={new Set()}
        onOpenRequirement={() => {}}
        onNewRequirement={() => {}}
      />,
    );
    expectScroll("project-scroll");
    expectShrinkable(screen.getByTestId("project-scroll").parentElement!);
    const bar = cls(screen.getByRole("alert", { name: "需要人工介入" }));
    expect(bar).toEqual(expect.arrayContaining(["max-h-40", "shrink-0", "overflow-y-auto"]));
  });

  it("未归属：section min-h-0，列表 min-h-0 flex-1 overflow-y-auto", () => {
    render(
      <UnattributedPanel
        escalations={Array.from({ length: 30 }, (_, i) => esc(i))}
        warnings={[]}
        showHeader={false}
      />,
    );
    expectScroll("unattributed-scroll");
    expectShrinkable(screen.getByRole("region", { name: "未归属" }));
  });

  it("设置（非嵌入）：正文 min-h-0 flex-1 overflow-y-auto", () => {
    render(<SettingsPanel settings={null} onBack={() => {}} />);
    expectScroll("settings-scroll");
    expectShrinkable(screen.getByRole("region", { name: "设置" }));
  });

  it("弹窗默认限高到视口内并可滚动（导入、确认、向导等）", () => {
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined} data-testid="dlg">
          <DialogTitle>t</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(cls(screen.getByTestId("dlg"))).toEqual(
      expect.arrayContaining(["max-h-[calc(100vh-2rem)]", "overflow-y-auto"]),
    );
  });
});
