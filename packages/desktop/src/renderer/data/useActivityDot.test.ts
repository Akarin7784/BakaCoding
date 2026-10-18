// @vitest-environment jsdom
// T-127：动态标签的小点（§4.5.1）：首次看到项目不亮，新消息亮，看过动态后熄灭，切项目不误亮。
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useActivityDot } from "./useActivityDot";
import { projects } from "../mock/data";
import type { ProjectView } from "../mock/types";

const todo = projects[0]!;
const blog = projects[1]!;

function withNewMessage(project: ProjectView, suffix: string): ProjectView {
  const last = project.messages.at(-1)!;
  return {
    ...project,
    messages: [
      ...project.messages,
      {
        ...last,
        event_id: `evt-new-${suffix}`,
        seq: 900 + project.messages.length,
        ts: "2026-10-17T09:30:00Z",
        payload: { ...last.payload, content: `T-2 复投完成（${suffix}），已提交新 PR。` },
      },
    ],
  };
}

describe("useActivityDot（T-127）", () => {
  it("首次看到项目不亮；来了新消息亮；看动态后熄灭；再看新消息又亮", () => {
    const { result, rerender } = renderHook(
      ({ project, viewing }: { project: ProjectView; viewing: boolean }) =>
        useActivityDot(project, viewing),
      { initialProps: { project: todo, viewing: false } },
    );
    expect(result.current).toBe(false);

    const newer = withNewMessage(todo, "a");
    rerender({ project: newer, viewing: false });
    expect(result.current).toBe(true);

    // 打开面板停在动态标签 = 已读
    rerender({ project: newer, viewing: true });
    expect(result.current).toBe(false);

    // 正在看动态时来了新消息：直接算已读，不亮
    const newest = withNewMessage(newer, "b");
    rerender({ project: newest, viewing: true });
    expect(result.current).toBe(false);

    // 关掉动态标签、没有新消息：不亮
    rerender({ project: newest, viewing: false });
    expect(result.current).toBe(false);

    // 关着时又来一条：再亮
    const latest = withNewMessage(newest, "c");
    rerender({ project: latest, viewing: false });
    expect(result.current).toBe(true);
  });

  it("切到另一个项目不把它的历史消息当新消息", () => {
    const { result, rerender } = renderHook(
      ({ project, viewing }: { project: ProjectView; viewing: boolean }) =>
        useActivityDot(project, viewing),
      { initialProps: { project: todo, viewing: false } },
    );
    expect(result.current).toBe(false);
    rerender({ project: blog, viewing: false });
    expect(result.current).toBe(false);
    // 切回原项目、有未读的新消息才亮
    rerender({ project: withNewMessage(todo, "x"), viewing: false });
    expect(result.current).toBe(true);
  });
});
