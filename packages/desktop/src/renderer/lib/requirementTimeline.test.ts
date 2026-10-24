// UI-05c：需求页时间线聚合。
import { describe, expect, it } from "vitest";
import { buildTimeline } from "./requirementTimeline";
import { call, changed, msg } from "./testEvents";

describe("buildTimeline", () => {
  it("只取本需求的事件（按 requirement_id 过滤）", () => {
    const items = buildTimeline("r1", [
      msg("r1", "本需求"),
      msg("r2", "别的需求"),
      msg(null, "无归属"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "message", text: "本需求" });
  });

  it("相邻的 Flash 调用折叠成一行，被消息隔开就分成两行", () => {
    const items = buildTimeline("r1", [call("r1"), call("r1"), msg("r1", "x"), call("r1")]);
    expect(items.map((i) => i.kind)).toEqual(["calls", "message", "calls"]);
    const first = items[0];
    expect(first?.kind === "calls" && first.calls).toHaveLength(2);
    expect(first?.kind === "calls" && first.summary).toBe(
      "Flash 调用 ×2 · low · 2.3k tokens · 4.0s",
    );
  });

  it("合并只显示「已合入」，不带 sha", () => {
    const [item] = buildTimeline("r1", [changed("r1", "merged")]);
    expect(item).toMatchObject({ kind: "status" });
    expect(item?.kind === "status" && item.text).toContain("已合入");
    expect(JSON.stringify(item)).not.toMatch(/[0-9a-f]{7,40}/);
  });

  it("消息和调用输出都过脱敏", () => {
    const items = buildTimeline("r1", [
      msg("r1", "看 /home/eva/secret.txt"),
      call("r1", "Bearer abcdefghijklmnop1234"),
    ]);
    const s = JSON.stringify(items);
    expect(s).not.toContain("/home/eva");
    expect(s).not.toContain("abcdefghijklmnop1234");
  });
});
