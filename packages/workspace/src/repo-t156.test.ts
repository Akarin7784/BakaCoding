import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { branchStatus, BranchStatusError, type BranchStatusCode } from "./repo.js";

// T-156：补 T-155 的三个 P3。timeout / git_failed 用 PATH 前置的 git 包装脚本触发：
// 只拦 rev-list（让它睡眠或带路径报错退出），其余子命令转给真 git。不改实现。
const posix = process.platform !== "win32";
const REAL_GIT = posix
  ? execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()
  : "";
const SECRET = "SECRET-raw-stderr-token";

let base: string;
let dir: string;
const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (...a: string[]) =>
  execFileSync(REAL_GIT || "git", a, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...ENV },
  }).trim();
const setup = () => {
  git("init", "-q");
  git("symbolic-ref", "HEAD", "refs/heads/main");
  git("commit", "-q", "--allow-empty", "-m", "c0");
  git("branch", "bakacoding/integration");
};
/** 装 git 包装脚本：rev-list 时执行 body，其余转真 git。 */
const shim = (body: string) => {
  const bin = join(base, "bin");
  mkdirSync(bin);
  const p = join(bin, "git");
  writeFileSync(
    p,
    `#!/bin/sh\nif [ "$1" = "rev-list" ]; then\n${body}\nfi\nexec "${REAL_GIT}" "$@"\n`,
  );
  chmodSync(p, 0o755);
  process.env.PATH = `${bin}${delimiter}${saved.PATH ?? ""}`;
};
const caught = async (p: Promise<unknown>): Promise<BranchStatusError> => {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(BranchStatusError);
  return e as BranchStatusError;
};
/** 错误对象上任何可见处都不能有原始信息。 */
const expectNoLeak = (e: BranchStatusError, ...needles: string[]) => {
  const own = Object.getOwnPropertyNames(e).map((k) =>
    String((e as unknown as Record<string, unknown>)[k]),
  );
  const views = [
    e.message,
    String(e),
    JSON.stringify(e),
    JSON.stringify({ ...e }),
    ...own.filter((_, i) => Object.getOwnPropertyNames(e)[i] !== "stack"),
  ];
  for (const v of views) for (const n of needles) expect(v).not.toContain(n);
  expect(e.cause).toBeUndefined();
  expect(Object.keys(e).sort()).toEqual(["code", "name"]);
};

beforeEach(() => {
  for (const k of ["HOME", "XDG_CONFIG_HOME", "PATH"]) saved[k] = process.env[k];
  base = realpathSync(mkdtempSync(join(tmpdir(), "bc-t156-")));
  dir = join(base, "proj");
  mkdirSync(dir);
  process.env.HOME = join(base, "home");
  process.env.XDG_CONFIG_HOME = join(base, "home", ".config");
  mkdirSync(process.env.HOME);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe.skipIf(!posix)("branchStatus 错误路径（T-156）", () => {
  it("rev-list 超时：timeout，消息等于固定文案", async () => {
    setup();
    shim("exec sleep 10");
    const e = await caught(branchStatus(dir, { timeout_ms: 500 }));
    expect(e.code).toBe("timeout");
    expect(e.message).toBe("Git 命令超时");
    expectNoLeak(e, base, "rev-list");
  });

  it("rev-list 带路径的原始 stderr、stdout 为 0、退出码 128：git_failed，原始信息不外泄", async () => {
    setup();
    shim(`echo "fatal: ${SECRET} at $PWD" >&2\necho 0\nexit 128`);
    const e = await caught(branchStatus(dir));
    expect(e.code).toBe("git_failed");
    expect(e.message).toBe("Git 命令执行失败");
    expectNoLeak(e, base, SECRET, "fatal", "128", "rev-list");
  });

  it("rev-list 被信号杀掉（非超时的意外错误）：git_failed，不外泄", async () => {
    setup();
    shim(`echo "${SECRET} $PWD" >&2\nkill -KILL $$`);
    const e = await caught(branchStatus(dir));
    expect(e.code).toBe("git_failed");
    expect(e.message).toBe("Git 命令执行失败");
    expectNoLeak(e, base, SECRET, "SIGKILL", "rev-list");
  });

  it("rev-list 输出非数字：git_failed，不外泄输出", async () => {
    setup();
    shim(`echo "${SECRET} $PWD"\nexit 0`);
    const e = await caught(branchStatus(dir));
    expect(e.code).toBe("git_failed");
    expect(e.message).toBe("Git 命令执行失败");
    expectNoLeak(e, base, SECRET);
  });
});

describe("branchStatus 各错误码文案完全相等（T-156）", () => {
  const cases: [BranchStatusCode, string, () => Promise<unknown>][] = [
    ["not_git", "这个文件夹还不是 Git 仓库", () => branchStatus(dir)],
    [
      "nested_repo",
      "这个文件夹在另一个 Git 仓库里面",
      async () => {
        setup();
        mkdirSync(join(dir, "sub"));
        return branchStatus(join(dir, "sub"));
      },
    ],
    ["invalid_branch", "分支名不合法", () => branchStatus(dir, { integration_branch: "--all" })],
    [
      "no_base",
      "找不到基线分支",
      async () => {
        setup();
        git("branch", "-m", "main", "trunk");
        return branchStatus(dir);
      },
    ],
    [
      "no_integration",
      "找不到集成分支",
      async () => {
        setup();
        git("branch", "-D", "bakacoding/integration");
        return branchStatus(dir);
      },
    ],
  ];
  for (const [c, msg, run] of cases) {
    it(`${c}：message 与固定文案 toBe`, async () => {
      const e = await caught(run());
      expect(e.code).toBe(c);
      expect(e.message).toBe(msg);
      expect(e.name).toBe("BranchStatusError");
    });
  }
});
