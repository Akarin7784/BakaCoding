// UI-06e：renderer/App 里每个 SupervisorChat 都传了 events（计时后的 token / 费用靠它）。放在 electron/ 下用 node 读源码（renderer 不许引 node:*）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("App 接线（UI-06e）", () => {
  it("App 里每个 SupervisorChat 都传了 events", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../renderer/App.tsx", import.meta.url)),
      "utf8",
    );
    const uses = src
      .split("<SupervisorChat")
      .slice(1)
      .map((s) => s.slice(0, s.indexOf("/>")));
    expect(uses.length).toBeGreaterThan(1);
    for (const u of uses) expect(u).toMatch(/\bevents=\{events\}/);
  });
});
