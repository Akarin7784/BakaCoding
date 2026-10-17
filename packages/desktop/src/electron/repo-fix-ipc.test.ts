// UI-03a：仓库检查与修复 IPC——参数类型校验、`..` / 绝对路径被拒、身份只写本仓库、失败只回固定文案、写后 reconnect。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialCommit } from "@bakacoding/app";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type DesktopRepoFixResult } from "../shared/api.js";
import { serveRepoFix, type IpcMainLike } from "./ipc.js";
import { isSafeRelPath, parseInitialCommit, repoFixFailure } from "./repo-fix-ipc.js";

let dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

// 全局 git 配置指向一个空的临时 HOME：既验证「不碰全局」，也让 identity 检查不受本机配置影响
const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };
let home = "";
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "bc-home-"));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
});
afterAll(() => {
  if (saved.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = saved.HOME;
  if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved.XDG;
  rmSync(home, { recursive: true, force: true });
});

const FAKE_EVENT = Object.freeze({ sender: { id: 1 } });
function setup(root: string) {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const ipc: IpcMainLike = {
    handle: (c, l) => void handlers.set(c, l),
    removeHandler: (c) => void handlers.delete(c),
  };
  const reconnect = vi.fn(async () => ({ state: "reloaded" as const }));
  const stop = serveRepoFix(ipc, { repoRoot: () => root, reconnect });
  const invoke = <T>(c: string, ...args: unknown[]) =>
    handlers.get(c)!(FAKE_EVENT, ...args) as Promise<T>;
  return { invoke, reconnect, stop, handlers };
}
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const ID = { name: "Eva Test", email: "eva@test.local" };

describe("repo:check / repo:init（UI-03a）", () => {
  it("不是仓库：check 回 not_git；init 带 identity 只写本仓库 .git/config，成功后 reconnect", async () => {
    const root = tmp("bc-fix-");
    const { invoke, reconnect } = setup(root);
    const c = await invoke<{ ok: true; check: { items: { id: string; code?: string }[] } }>(
      IPC_CHANNELS.repoCheck,
    );
    expect(c.ok).toBe(true);
    expect(c.check.items.map((i) => i.code)).toEqual([
      "not_git",
      "no_commits",
      "no_main",
      "not_ignored",
    ]);
    const r = await invoke<DesktopRepoFixResult>(IPC_CHANNELS.repoInit, { identity: ID });
    expect(r).toEqual({ ok: true, reload: { state: "reloaded" } });
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(git(root, "config", "--local", "user.name")).toBe(ID.name);
    expect(existsSync(join(home, ".gitconfig"))).toBe(false);
    expect(existsSync(join(home, ".config", "git", "config"))).toBe(false);
    expect(git(root, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  });

  it("已是仓库再 init：repo_exists 固定文案，不带路径，不 reconnect", async () => {
    const root = tmp("bc-fix-");
    git(root, "init", "-q");
    const { invoke, reconnect } = setup(root);
    const r = await invoke<DesktopRepoFixResult>(IPC_CHANNELS.repoInit);
    expect(r).toEqual({ ok: false, code: "repo_exists", reason: "这个文件夹已经是 Git 仓库" });
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("init 的 identity 类型不对：invalid_identity，什么都不改", async () => {
    const root = join(tmp("bc-fix-"), "sub");
    const { invoke } = setup(root);
    for (const bad of [{ identity: "x" }, { identity: { name: 1, email: "a@b" } }, "str", [1]]) {
      const r = await invoke<DesktopRepoFixResult>(IPC_CHANNELS.repoInit, bad);
      expect(r).toMatchObject({ ok: false, code: "invalid_identity" });
    }
    expect(existsSync(root)).toBe(false);
  });
});

describe("repo:list-initial-files / repo:initial-commit（UI-03a）", () => {
  function freshRepo(): string {
    const root = tmp("bc-fix-");
    git(root, "init", "-q");
    git(root, "symbolic-ref", "HEAD", "refs/heads/main");
    writeFileSync(join(root, "a.txt"), "a\n");
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "b.ts"), "b\n");
    return root;
  }

  it("列出 include / excluded（带原因）；身份缺失时 no_identity；补上缺的身份后只提交选中的文件", async () => {
    const root = freshRepo();
    const { invoke, reconnect } = setup(root);
    const l = await invoke(IPC_CHANNELS.repoListInitialFiles);
    expect(l).toEqual({
      ok: true,
      include: ["a.txt", "src/b.ts"],
      excluded: [{ path: ".env", reason: "protected" }],
    });
    const c = await invoke<{ ok: true; check: { identity: unknown } }>(IPC_CHANNELS.repoCheck);
    expect(c.check.identity).toEqual({ name: false, email: false });
    expect(await invoke(IPC_CHANNELS.repoInitialCommit, { files: ["a.txt"] })).toMatchObject({
      ok: false,
      code: "no_identity",
    });
    const r = await invoke<DesktopRepoFixResult>(IPC_CHANNELS.repoInitialCommit, {
      files: ["a.txt", "src/b.ts"],
      identity: ID,
    });
    expect(r.ok).toBe(true);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(git(root, "ls-tree", "-r", "--name-only", "main").split("\n")).toEqual([
      "a.txt",
      "src/b.ts",
    ]);
    expect(existsSync(join(home, ".gitconfig"))).toBe(false);
    expect(readFileSync(join(root, ".git", "config"), "utf8")).toContain(ID.email);
  });

  it("`..` 和绝对路径在 IPC 层就被拒（invalid_files），没有提交、不 reconnect", async () => {
    const root = freshRepo();
    const { invoke, reconnect } = setup(root);
    const outside = join(tmp("bc-out-"), "x.txt");
    writeFileSync(outside, "x");
    for (const files of [
      ["../x.txt"],
      ["src/../a.txt"],
      ["a.txt", "..\\x.txt"],
      [outside],
      ["/etc/passwd"],
      ["C:\\Windows\\x"],
      ["\\\\server\\share\\x"],
    ]) {
      const r = await invoke(IPC_CHANNELS.repoInitialCommit, { files, identity: ID });
      expect(r, JSON.stringify(files)).toEqual({
        ok: false,
        code: "invalid_files",
        reason: "要提交的文件不在可提交列表里",
      });
    }
    expect(reconnect).not.toHaveBeenCalled();
    expect(() => git(root, "rev-parse", "--verify", "-q", "HEAD")).toThrow();
  });

  it("模块 4 自己也拒绝 `..`、绝对路径和不在清单里的文件（IPC 层之下还有一层）", async () => {
    const root = freshRepo();
    for (const files of [["../x"], [join(root, "a.txt")], [".env"], ["nope.txt"]]) {
      await expect(initialCommit(root, { files, identity: ID })).rejects.toMatchObject({
        code: "invalid_files",
      });
    }
  });

  it("参数类型不对：files 非数组 / 空 / 非字符串、empty 不是 true、两者都给或都不给 → invalid_files", async () => {
    const root = freshRepo();
    const { invoke } = setup(root);
    for (const bad of [
      undefined,
      "a.txt",
      { files: "a.txt" },
      { files: [] },
      { files: [1] },
      { files: [""] },
      { files: ["a\0b"] },
      { empty: "yes" },
      { empty: true, files: ["a.txt"] },
      {},
    ]) {
      expect(await invoke(IPC_CHANNELS.repoInitialCommit, bad), JSON.stringify(bad)).toMatchObject({
        ok: false,
        code: "invalid_files",
      });
    }
    expect(
      await invoke(IPC_CHANNELS.repoInitialCommit, { empty: true, identity: { name: "x" } }),
    ).toMatchObject({ ok: false, code: "invalid_identity" });
  });

  it("空提交可行；已有提交再提交 has_commits", async () => {
    const root = freshRepo();
    const { invoke } = setup(root);
    const r = await invoke<DesktopRepoFixResult>(IPC_CHANNELS.repoInitialCommit, {
      empty: true,
      identity: ID,
    });
    expect(r.ok).toBe(true);
    expect(git(root, "ls-tree", "-r", "--name-only", "main")).toBe("");
    expect(await invoke(IPC_CHANNELS.repoInitialCommit, { empty: true })).toMatchObject({
      ok: false,
      code: "has_commits",
    });
  });
});

describe("repo:create-main（UI-03a）", () => {
  it("从 master 新建 main：from 是原分支名，原分支还在，成功后 reconnect；再建 main_exists", async () => {
    const root = tmp("bc-fix-");
    git(root, "init", "-q", "-b", "master");
    git(root, "config", "user.name", "t");
    git(root, "config", "user.email", "t@t");
    writeFileSync(join(root, "a"), "a");
    git(root, "add", ".");
    git(root, "commit", "-qm", "x");
    const { invoke, reconnect } = setup(root);
    expect(await invoke(IPC_CHANNELS.repoCreateMain)).toEqual({
      ok: true,
      from: "master",
      reload: { state: "reloaded" },
    });
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(git(root, "branch", "--format=%(refname:short)").split("\n").sort()).toEqual([
      "main",
      "master",
    ]);
    expect(await invoke(IPC_CHANNELS.repoCreateMain)).toMatchObject({
      ok: false,
      code: "main_exists",
    });
  });

  it("reconnect 抛错：修复仍算成功，reload 记成 failed（固定文案）", async () => {
    const root = tmp("bc-fix-");
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    serveRepoFix(
      { handle: (c, l) => void handlers.set(c, l), removeHandler: () => {} },
      {
        repoRoot: () => root,
        reconnect: async () => {
          throw new Error(`boom ${root}`);
        },
      },
    );
    const r = await handlers.get(IPC_CHANNELS.repoInit)!(FAKE_EVENT, {});
    expect(r).toEqual({ ok: true, reload: { state: "failed", reason: "重新连接失败" } });
  });
});

describe("主进程参数校验先于 4（UI-03a）", () => {
  it("identity 类型不对时根本不调 4；对的只把 name / email 两个字段交给 4（多余字段丢掉）", async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const initRepo = vi.fn(async () => {});
    const initialCommitFn = vi.fn(async () => ({ commit: "c" }));
    serveRepoFix(
      { handle: (c, l) => void handlers.set(c, l), removeHandler: () => {} },
      {
        repoRoot: () => "/r",
        reconnect: async () => ({ state: "reloaded" }),
        fns: { initRepo, initialCommit: initialCommitFn },
      },
    );
    const call = (c: string, a: unknown) => handlers.get(c)!(FAKE_EVENT, a);
    for (const bad of [{ name: 1, email: "a@b" }, { name: "a" }, "x", ["a", "b"]]) {
      expect(await call(IPC_CHANNELS.repoInit, { identity: bad })).toMatchObject({
        code: "invalid_identity",
      });
      expect(
        await call(IPC_CHANNELS.repoInitialCommit, { empty: true, identity: bad }),
      ).toMatchObject({ code: "invalid_identity" });
    }
    expect(initRepo).not.toHaveBeenCalled();
    expect(initialCommitFn).not.toHaveBeenCalled();
    await call(IPC_CHANNELS.repoInit, { identity: { ...ID, evil: "--global" } });
    expect(initRepo).toHaveBeenCalledWith("/r", { identity: ID });
    await call(IPC_CHANNELS.repoInitialCommit, { files: ["a"], identity: { ...ID, x: 1 } });
    expect(initialCommitFn).toHaveBeenCalledWith("/r", { files: ["a"], identity: ID });
  });

  it("files 里有 `..` / 绝对路径时根本不调 4", async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const initialCommitFn = vi.fn(async () => ({ commit: "c" }));
    serveRepoFix(
      { handle: (c, l) => void handlers.set(c, l), removeHandler: () => {} },
      {
        repoRoot: () => "/r",
        reconnect: async () => ({ state: "reloaded" }),
        fns: { initialCommit: initialCommitFn },
      },
    );
    for (const files of [["../x"], ["/etc/passwd"], ["C:\\x"], ["a/../../b"]])
      expect(
        await handlers.get(IPC_CHANNELS.repoInitialCommit)!(FAKE_EVENT, { files }),
      ).toMatchObject({ code: "invalid_files" });
    expect(initialCommitFn).not.toHaveBeenCalled();
  });
});

describe("失败文案（UI-03a）", () => {
  it("非 RepoFixError 一律 git_failed 固定文案，不带原始信息和路径", () => {
    expect(repoFixFailure(new Error("fatal: /home/eva/secret"))).toEqual({
      ok: false,
      code: "git_failed",
      reason: "Git 命令执行失败",
    });
    expect(repoFixFailure("x")).toMatchObject({ code: "git_failed" });
  });

  it("check 里 4 抛了未知错误：同样只回固定文案", async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    serveRepoFix(
      { handle: (c, l) => void handlers.set(c, l), removeHandler: () => {} },
      {
        repoRoot: () => "/r",
        reconnect: async () => ({ state: "reloaded" }),
        fns: {
          checkRepo: async () => {
            throw new Error("EACCES /r/.git");
          },
        },
      },
    );
    expect(await handlers.get(IPC_CHANNELS.repoCheck)!(FAKE_EVENT)).toEqual({
      ok: false,
      code: "git_failed",
      reason: "Git 命令执行失败",
    });
  });

  it("isSafeRelPath / parseInitialCommit 纯函数", () => {
    expect(isSafeRelPath("a/b.txt")).toBe(true);
    expect(isSafeRelPath("a/..b")).toBe(true);
    expect(isSafeRelPath("a/../b")).toBe(false);
    expect(isSafeRelPath("..")).toBe(false);
    expect(isSafeRelPath("/a")).toBe(false);
    expect(isSafeRelPath("D:a")).toBe(false);
    expect(parseInitialCommit({ files: ["a"], identity: ID })).toEqual({
      files: ["a"],
      identity: ID,
    });
    expect(parseInitialCommit({ empty: true })).toEqual({ empty: true });
  });
});
