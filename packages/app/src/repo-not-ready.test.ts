// T-096（#107 评审 nit）：no_main 消息里的分支名截到 100 个字符，current 字段保留完整分支名。
import { describe, expect, it } from "vitest";
import { BRANCH_MESSAGE_MAX, RepoNotReadyError } from "./repo-not-ready.js";

describe("RepoNotReadyError 分支名截断", () => {
  it("超过 100 个字符的分支名在消息里截成 99 个字符加省略号；current 仍是完整分支名", () => {
    const long = "feature/" + "x".repeat(200);
    const err = new RepoNotReadyError("no_main", long);
    const shown = `${long.slice(0, BRANCH_MESSAGE_MAX - 1)}…`;
    expect(BRANCH_MESSAGE_MAX).toBe(100);
    expect(err.message).toBe(`仓库里没有 main 分支（当前是 ${shown}），这一版只支持 main`);
    expect(err.message).not.toContain(long);
    expect(err.current).toBe(long);
  });

  it("正好 100 个字符不截；分离 HEAD 照旧", () => {
    const exact = "b".repeat(100);
    expect(new RepoNotReadyError("no_main", exact).message).toContain(`（当前是 ${exact}）`);
    expect(new RepoNotReadyError("no_main").message).toContain("（当前是 分离 HEAD）");
  });
});
