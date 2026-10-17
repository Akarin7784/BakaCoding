import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkRepo,
  createMainBranch,
  initialCommit,
  initRepo,
  listInitialCommitFiles,
  RepoFixError,
} from "./repo.js";

let base: string;
let dir: string;
const saved: Record<string, string | undefined> = {};
const ISOLATE = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: undefined,
  GIT_AUTHOR_EMAIL: undefined,
  GIT_COMMITTER_NAME: undefined,
  GIT_COMMITTER_EMAIL: undefined,
  EMAIL: undefined,
};
const git = (...a: string[]) =>
  execFileSync("git", a, { cwd: dir, encoding: "utf8", env: process.env }).trim();
const ident = () => {
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.com");
};
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RepoFixError);
    return (e as RepoFixError).code;
  }
  throw new Error("没有抛错");
};

beforeEach(() => {
  for (const [k, v] of Object.entries(ISOLATE)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  base = realpathSync(mkdtempSync(join(tmpdir(), "bc-repo-")));
  dir = join(base, "proj");
  mkdirSync(dir);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("checkRepo", () => {
  it("不是仓库：四项都不通过，code 固定", async () => {
    const r = await checkRepo(dir);
    expect(r.items.map((i) => [i.id, i.ok, i.code])).toEqual([
      ["git", false, "not_git"],
      ["commit", false, "no_commits"],
      ["main", false, "no_main"],
      ["ignored", false, "not_ignored"],
    ]);
    expect(r.current_branch).toBeNull();
  });

  it("不存在的目录也只报 not_git", async () => {
    const r = await checkRepo(join(base, "nope"));
    expect(r.items[0]).toMatchObject({ ok: false, code: "not_git" });
  });

  it("外层仓库的子目录不算仓库", async () => {
    execFileSync("git", ["init", "-q"], { cwd: base });
    const r = await checkRepo(dir);
    expect(r.items[0]).toMatchObject({ ok: false, code: "not_git" });
  });

  it("空仓库 master：报 no_commits 和 no_main，带 current，detail 不含路径", async () => {
    git("init", "-q", "-b", "master");
    const r = await checkRepo(dir);
    expect(r.items[0]).toEqual({ id: "git", ok: true });
    expect(r.items[1]).toMatchObject({ ok: false, code: "no_commits" });
    expect(r.items[2]).toMatchObject({ ok: false, code: "no_main", current: "master" });
    expect(r.items[2]!.detail).toContain("master");
    expect(r.current_branch).toBe("master");
    for (const i of r.items) expect(i.detail ?? "").not.toContain(base);
  });

  it("身份只回是否配置，不回值", async () => {
    git("init", "-q");
    expect((await checkRepo(dir)).identity).toEqual({ name: false, email: false });
    ident();
    const r = await checkRepo(dir);
    expect(r.identity).toEqual({ name: true, email: true });
    expect(JSON.stringify(r)).not.toContain("t@example.com");
  });

  it("全部就绪时四项都通过；只读，不写 exclude", async () => {
    git("init", "-q", "-b", "main");
    ident();
    git("commit", "-q", "--allow-empty", "-m", "x");
    const exclude = join(dir, ".git", "info", "exclude");
    const before = existsSync(exclude) ? readFileSync(exclude, "utf8") : null;
    const r = await checkRepo(dir);
    expect(r.items.find((i) => i.id === "ignored")).toMatchObject({ ok: false });
    expect(existsSync(exclude) ? readFileSync(exclude, "utf8") : null).toBe(before);
    writeFileSync(exclude, "/.bakacoding/\n");
    const r2 = await checkRepo(dir);
    expect(r2.items.every((i) => i.ok)).toBe(true);
  });
});

describe("initRepo", () => {
  it("新建目录并初始化到 main，写 exclude；identity 只写本仓库", async () => {
    const p = join(base, "new", "deep");
    await initRepo(p, { identity: { name: "Eva", email: "eva@example.com" } });
    const g = (...a: string[]) => execFileSync("git", a, { cwd: p, encoding: "utf8" }).trim();
    expect(g("symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(g("config", "--local", "user.email")).toBe("eva@example.com");
    expect(readFileSync(join(p, ".git", "info", "exclude"), "utf8")).toContain("/.bakacoding/");
    const r = await checkRepo(p);
    expect(r.items.map((i) => i.ok)).toEqual([true, false, false, true]);
    expect(r.items[2]!.current).toBeUndefined();
  });

  it("已经是仓库：repo_exists，不改配置", async () => {
    git("init", "-q", "-b", "master");
    expect(await code(initRepo(dir, { identity: { name: "x", email: "x@y.z" } }))).toBe(
      "repo_exists",
    );
    expect(git("symbolic-ref", "--short", "HEAD")).toBe("master");
    expect(() => git("config", "--local", "user.name")).toThrow();
  });

  it("身份不合法先拒绝，什么都不建", async () => {
    const p = join(base, "bad");
    expect(await code(initRepo(p, { identity: { name: "a\nb", email: "x@y.z" } }))).toBe(
      "invalid_identity",
    );
    expect(await code(initRepo(p, { identity: { name: "a", email: "nope" } }))).toBe(
      "invalid_identity",
    );
    expect(existsSync(p)).toBe(false);
  });
});

describe("listInitialCommitFiles / initialCommit", () => {
  beforeEach(async () => {
    await initRepo(dir, { identity: { name: "t", email: "t@example.com" } });
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, ".bakacoding"));
    writeFileSync(join(dir, "src", "a.ts"), "a\n");
    writeFileSync(join(dir, "README.md"), "r\n");
    writeFileSync(join(dir, ".env"), "SECRET=x\n");
    writeFileSync(join(dir, ".env.example"), "SECRET=\n");
    writeFileSync(join(dir, "id_rsa"), "k\n");
    writeFileSync(join(dir, ".bakacoding", "db.sqlite"), "d");
    writeFileSync(join(dir, ".gitignore"), "dist/\n");
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "x.js"), "x");
  });

  it("列出可提交文件，排除 .env 类、私钥和 .gitignore 忽略的文件", async () => {
    const r = await listInitialCommitFiles(dir);
    expect(r.include).toEqual([".env.example", ".gitignore", "README.md", "src/a.ts"]);
    expect(r.excluded).toEqual([
      { path: ".env", reason: "protected" },
      { path: "id_rsa", reason: "protected" },
    ]);
  });

  it("exclude 没写时 .bakacoding/ 下的文件也排除", async () => {
    writeFileSync(join(dir, ".git", "info", "exclude"), "");
    const r = await listInitialCommitFiles(dir);
    expect(r.excluded).toContainEqual({ path: ".bakacoding/db.sqlite", reason: "bakacoding" });
    expect(r.include.some((p) => p.startsWith(".bakacoding"))).toBe(false);
  });

  it("只提交列出的文件，提交到 main，工作区不动", async () => {
    const { commit } = await initialCommit(dir, { files: ["README.md", "src/a.ts"] });
    expect(git("rev-parse", "main")).toBe(commit);
    expect(git("symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git("ls-tree", "-r", "--name-only", "HEAD").split("\n")).toEqual([
      "README.md",
      "src/a.ts",
    ]);
    expect(existsSync(join(dir, ".env"))).toBe(true);
    expect(git("status", "--porcelain", "--", "README.md")).toBe("");
    expect((await checkRepo(dir)).items.every((i) => i.ok)).toBe(true);
  });

  it("用户事先暂存了 .env 也不会被提交，暂存区重置为新提交", async () => {
    git("add", "-f", ".env", "README.md");
    expect((await listInitialCommitFiles(dir)).excluded).toContainEqual({
      path: ".env",
      reason: "protected",
    });
    await initialCommit(dir, { files: ["README.md"] });
    expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("README.md");
    expect(git("diff", "--cached", "--name-only")).toBe("");
  });

  it("列表里混进受保护或不存在的文件：整体拒绝，什么都不提交", async () => {
    expect(await code(initialCommit(dir, { files: ["README.md", ".env"] }))).toBe("invalid_files");
    expect(await code(initialCommit(dir, { files: ["nope.txt"] }))).toBe("invalid_files");
    expect(await code(initialCommit(dir, { files: [] }))).toBe("invalid_files");
    expect(await code(initialCommit(dir, { files: ["dist/x.js"] }))).toBe("invalid_files");
    expect((await checkRepo(dir)).items[1]).toMatchObject({ ok: false, code: "no_commits" });
  });

  it("空提交；已有提交后再做抛 has_commits", async () => {
    const { commit } = await initialCommit(dir, { empty: true });
    expect(git("ls-tree", "HEAD")).toBe("");
    expect(git("rev-parse", "HEAD")).toBe(commit);
    expect(await code(initialCommit(dir, { empty: true }))).toBe("has_commits");
  });

  it("HEAD 指向未出生的 master 时也提交到 main，并把 HEAD 指过去", async () => {
    git("symbolic-ref", "HEAD", "refs/heads/master");
    await initialCommit(dir, { files: ["README.md"] });
    expect(git("symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(() => git("rev-parse", "--verify", "-q", "refs/heads/master")).toThrow();
  });

  it("没配身份抛 no_identity", async () => {
    git("config", "--unset", "user.name");
    expect(await code(initialCommit(dir, { empty: true }))).toBe("no_identity");
    expect((await checkRepo(dir)).items[1]).toMatchObject({ ok: false });
  });

  it("确认框补填的身份写进本仓库再提交", async () => {
    git("config", "--unset", "user.name");
    git("config", "--unset", "user.email");
    await initialCommit(dir, {
      empty: true,
      identity: { name: "Eva", email: "eva@example.com" },
    });
    expect(git("log", "-1", "--format=%an <%ae>")).toBe("Eva <eva@example.com>");
    expect(git("config", "--local", "user.name")).toBe("Eva");
    expect(
      await code(initialCommit(dir, { empty: true, identity: { name: "", email: "x@y.z" } })),
    ).toBe("invalid_identity");
  });

  it("不跑 hooks", async () => {
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await expect(initialCommit(dir, { empty: true })).resolves.toHaveProperty("commit");
  });

  it("不是仓库抛 not_git", async () => {
    const p = join(base, "plain");
    mkdirSync(p);
    expect(await code(listInitialCommitFiles(p))).toBe("not_git");
    expect(await code(initialCommit(p, { empty: true }))).toBe("not_git");
  });
});

describe("createMainBranch", () => {
  beforeEach(() => {
    git("init", "-q", "-b", "master");
    ident();
    git("commit", "-q", "--allow-empty", "-m", "x");
  });

  it("从当前分支新建 main，不切换、不删原分支", async () => {
    expect(await createMainBranch(dir)).toEqual({ from: "master" });
    expect(git("rev-parse", "main")).toBe(git("rev-parse", "master"));
    expect(git("symbolic-ref", "--short", "HEAD")).toBe("master");
    expect(await code(createMainBranch(dir))).toBe("main_exists");
  });

  it("分离 HEAD 时 from 是提交哈希", async () => {
    const sha = git("rev-parse", "HEAD");
    git("checkout", "-q", "--detach");
    expect(await createMainBranch(dir)).toEqual({ from: sha });
  });

  it("没有提交抛 no_commits", async () => {
    const p = join(base, "empty");
    await initRepo(p);
    expect(await code(createMainBranch(p))).toBe("no_commits");
  });
});

describe("超时", () => {
  it("git 超时抛 timeout，信息不含路径", async () => {
    const bin = join(base, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    try {
      const err = await checkRepo(dir, { timeout_ms: 200 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RepoFixError);
      expect((err as RepoFixError).code).toBe("timeout");
      expect((err as RepoFixError).message).not.toContain(base);
    } finally {
      process.env.PATH = path;
    }
  });
});
