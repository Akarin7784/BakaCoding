// T-094：isManagedPath 只在 worktrees 根目录 lstat 报 ENOENT 时按字面路径判断；
// lstat 的其它错误、realpath 出错（含根目录是悬空符号链接）一律当不受管，不删。
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const broken = { prefix: "", lstatPath: "" };
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  const realpathSync = ((p: fs.PathLike, ...rest: unknown[]) => {
    if (broken.prefix && String(p).startsWith(broken.prefix)) {
      throw Object.assign(new Error("ELOOP: too many symbolic links"), { code: "ELOOP" });
    }
    return (real.realpathSync as (...a: unknown[]) => string)(p, ...rest);
  }) as typeof real.realpathSync;
  const lstatSync = ((p: fs.PathLike, ...rest: unknown[]) => {
    if (broken.lstatPath && String(p) === broken.lstatPath) {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    }
    return (real.lstatSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof real.lstatSync;
  const patched = { realpathSync, lstatSync };
  return { ...real, ...patched, default: { ...real, ...patched } };
});

const { cleanupMergedWorktrees } = await import("./cleanup.js");

let repo: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(() => {
  repo = fs.realpathSync(mkdtempSync(join(tmpdir(), "bc-clean-m-")));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "init");
  git("branch", "bakacoding/integration");
});
afterEach(() => {
  broken.prefix = "";
  broken.lstatPath = "";
  rmSync(repo, { recursive: true, force: true });
});

describe("isManagedPath（T-094）", () => {
  it("worktrees 根目录存在但 realpath 出错：当不受管，不删目录也不删分支", async () => {
    const wt = join(repo, ".bakacoding/worktrees/T-1-r0");
    git("worktree", "add", "-q", "-b", "bakacoding/T-1-r0", wt, "HEAD");
    broken.prefix = join(repo, ".bakacoding/worktrees");
    const res = await cleanupMergedWorktrees(repo, "T-1", {
      merged_into: "bakacoding/integration",
      retry_delays_ms: [],
      sleep: async () => {},
    });
    expect(existsSync(wt)).toBe(true);
    expect(res.removed_worktrees).toEqual([]);
    expect(res.kept_branches).toEqual([{ branch: "bakacoding/T-1-r0", reason: "checked_out" }]);
  });

  it("worktrees 根目录不存在（lstat 报 ENOENT）：按字面路径判断（登记残留照常 prune、分支照常删）", async () => {
    const wt = join(repo, ".bakacoding/worktrees/T-2-r0");
    git("worktree", "add", "-q", "-b", "bakacoding/T-2-r0", wt, "HEAD");
    rmSync(join(repo, ".bakacoding"), { recursive: true, force: true });
    broken.prefix = join(repo, ".bakacoding/worktrees"); // 即使 realpath 会出错也走不到
    const res = await cleanupMergedWorktrees(repo, "T-2", {
      merged_into: "bakacoding/integration",
      retry_delays_ms: [],
      sleep: async () => {},
    });
    expect(res.errors).toEqual([]);
    expect(res.removed_worktrees).toEqual([wt]);
    expect(res.deleted_branches).toEqual(["bakacoding/T-2-r0"]);
  });
  it("worktrees 根目录 lstat 报 EACCES：当不受管，不删目录也不删分支", async () => {
    const wt = join(repo, ".bakacoding/worktrees/T-3-r0");
    git("worktree", "add", "-q", "-b", "bakacoding/T-3-r0", wt, "HEAD");
    broken.lstatPath = join(repo, ".bakacoding/worktrees");
    const res = await cleanupMergedWorktrees(repo, "T-3", {
      merged_into: "bakacoding/integration",
      retry_delays_ms: [],
      sleep: async () => {},
    });
    expect(existsSync(wt)).toBe(true);
    expect(res.removed_worktrees).toEqual([]);
    expect(res.kept_branches).toEqual([{ branch: "bakacoding/T-3-r0", reason: "checked_out" }]);
  });

  it.skipIf(process.platform === "win32")(
    "worktrees 根目录是悬空符号链接：当不受管（不删目录、分支保留）",
    async () => {
      const wt = join(repo, ".bakacoding/worktrees/T-4-r0");
      git("worktree", "add", "-q", "-b", "bakacoding/T-4-r0", wt, "HEAD");
      rmSync(join(repo, ".bakacoding/worktrees"), { recursive: true, force: true });
      symlinkSync(join(repo, "no-such-target"), join(repo, ".bakacoding/worktrees"));
      const res = await cleanupMergedWorktrees(repo, "T-4", {
        merged_into: "bakacoding/integration",
        retry_delays_ms: [],
        sleep: async () => {},
      });
      expect(res.removed_worktrees).toEqual([]);
      expect(res.deleted_branches).toEqual([]);
      expect(res.kept_branches).toEqual([{ branch: "bakacoding/T-4-r0", reason: "checked_out" }]);
      expect(git("branch", "--list", "bakacoding/T-4-r0")).toContain("bakacoding/T-4-r0");
      expect(existsSync(join(repo, "no-such-target"))).toBe(false);
    },
  );
});
