// UI-05c：mock 群聊示例统一用「重写」，不再出现「复投」（蓝色大肥鱼 05b 评审遗留）。
import { describe, expect, it } from "vitest";
import { projects } from "./data";

describe("mock 群聊消息", () => {
  it("不出现「复投」", () => {
    const contents = projects.flatMap((p) =>
      p.messages.flatMap((m) => (m.type === "group_message" ? [m.payload.content] : [])),
    );
    expect(contents.length).toBeGreaterThan(0);
    for (const c of contents) expect(c).not.toContain("复投");
  });
});
