// @vitest-environment jsdom
// UI-01：需求单状态 → lucide 图标（docs/ui-design.md §5.2），覆盖全部 9 个 TicketStatus。
import { TICKET_STATUSES, type TicketStatus } from "@bakacoding/types";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TICKET_STATUS_LABEL } from "../lib/copy";
import { STATUS_ICON, StatusIcon, type StatusTone } from "./StatusIcon";

afterEach(cleanup);

/** §5.2 表格原样抄过来：图标名、色调、是否旋转。 */
const SPEC: Record<TicketStatus, [string, StatusTone, boolean]> = {
  pending: ["circle-dashed", "muted", false],
  coding: ["loader-circle", "accent", true],
  in_review: ["loader-circle", "accent", true],
  re_reviewing: ["loader-circle", "accent", true],
  resubmitting: ["rotate-ccw", "accent", false],
  merge_queued: ["git-pull-request", "muted", false],
  conflict: ["git-compare-arrows", "danger", false],
  merged: ["circle-check", "foreground", false],
  escalated: ["circle-alert", "danger", false],
};

describe("StatusIcon", () => {
  it("映射表覆盖全部 TicketStatus，且与 §5.2 一致", () => {
    expect(Object.keys(STATUS_ICON).sort()).toEqual([...TICKET_STATUSES].sort());
    for (const s of TICKET_STATUSES) {
      const [name, tone, spin] = SPEC[s];
      expect(STATUS_ICON[s]).toMatchObject({ name, tone, spin });
    }
  });

  it.each(TICKET_STATUSES)("%s：渲染出的确实是对应的 lucide 图标、色调和文案", (s) => {
    const [name, tone, spin] = SPEC[s];
    render(<StatusIcon status={s} />);
    const el = screen.getByRole("img", { name: TICKET_STATUS_LABEL[s] });
    expect(el.dataset.status).toBe(s);
    expect(el.dataset.tone).toBe(tone);
    expect(el.dataset.icon).toBe(name);
    const svg = el.querySelector("svg");
    expect(svg?.getAttribute("class")).toContain(`lucide-${name}`);
    expect(svg?.getAttribute("stroke-width")).toBe("1.5");
    expect(svg?.getAttribute("class")?.includes("animate-spin-slow")).toBe(spin);
    if (spin) expect(svg?.getAttribute("class")).toContain("motion-reduce:animate-none");
    const toneClass = {
      muted: "text-muted-foreground",
      accent: "text-accent",
      danger: "text-danger",
      foreground: "text-foreground",
    }[tone];
    expect(el.className).toContain(toneClass);
  });

  it("颜色为辅：除运行中的三态共用转圈外，每个状态的图标形状都不同", () => {
    const running = new Set<TicketStatus>(["coding", "in_review", "re_reviewing"]);
    const names = TICKET_STATUSES.filter((s) => !running.has(s)).map((s) => STATUS_ICON[s].name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain("loader-circle");
  });

  it("重写时图标旁显示次数，朗读文案带次数；其他状态忽略次数", () => {
    render(<StatusIcon status="resubmitting" resubmitCount={2} />);
    const el = screen.getByRole("img", { name: "重写（重写 2 次）" });
    expect(el.textContent).toBe("2");
    cleanup();
    render(<StatusIcon status="coding" resubmitCount={2} />);
    expect(screen.getByRole("img", { name: "编码中" }).textContent).toBe("");
  });

  it("尺寸只有 16 / 20（§5.5）", () => {
    render(<StatusIcon status="merged" size={20} />);
    expect(screen.getByRole("img").querySelector("svg")?.getAttribute("width")).toBe("20");
  });
});
