import { describe, expect, it } from "vitest";
import { gitEnv } from "./git-env.js";

describe("gitEnv", () => {
  it("剔掉所有 GIT_ 开头的变量（不分大小写），保留其它，加固定项和 extra", () => {
    const env = gitEnv(
      { GIT_INDEX_FILE: "/tmp/i" },
      { PATH: "/bin", GIT_DIR: "/x", git_work_tree: "/y", GIT_CONFIG_COUNT: "1", HOME: "/h" },
    );
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/h",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      GIT_INDEX_FILE: "/tmp/i",
    });
  });
});
