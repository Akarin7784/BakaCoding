import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
  HOME: undefined,
  XDG_CONFIG_HOME: undefined,
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
  // 库里的 git 会剔掉 GIT_CONFIG_GLOBAL 等变量，靠空 HOME 隔离全局配置。
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
    expect(r.default_branch).toBeNull();
  });

  it("不存在的目录也只报 not_git", async () => {
    const r = await checkRepo(join(base, "nope"));
    expect(r.items[0]).toMatchObject({ ok: false, code: "not_git" });
    expect(r.default_branch).toBeNull();
  });

  it("外层仓库的子目录报 nested_repo（T-114），其余各项不通过，不含外层路径", async () => {
    execFileSync("git", ["init", "-q"], { cwd: base });
    const r = await checkRepo(dir);
    expect(r.items.map((i) => [i.id, i.ok, i.code])).toEqual([
      ["git", false, "nested_repo"],
      ["commit", false, "no_commits"],
      ["main", false, "no_main"],
      ["ignored", false, "not_ignored"],
    ]);
    expect(r.items[0]!.detail).toBe(
      "这个文件夹在另一个 Git 仓库里面。请导入上层仓库的根目录，或把文件夹移到仓库外再初始化",
    );
    expect(JSON.stringify(r)).not.toContain(base);
    expect(r.current_branch).toBeNull();
    expect(r.default_branch).toBeNull();
  });

  it("空仓库 master：报 no_commits 和 no_main，带 current，detail 不含路径（T-120）", async () => {
    git("init", "-q", "-b", "master");
    const r = await checkRepo(dir);
    expect(r.items[0]).toEqual({ id: "git", ok: true });
    expect(r.items[1]).toMatchObject({ ok: false, code: "no_commits" });
    expect(r.items[2]).toMatchObject({ ok: false, code: "no_main", current: "master" });
    expect(r.items[2]!.detail).toContain("master");
    expect(r.current_branch).toBe("master");
    expect(r.default_branch).toBeNull();
    for (const i of r.items) expect(i.detail ?? "").not.toContain(base);
  });

  it("默认分支识别（T-120）：只有 master / trunk 且有提交时不再要求叫 main", async () => {
    for (const name of ["master", "trunk"]) {
      const p = join(base, `proj-${name}`);
      mkdirSync(p);
      const g = (...a: string[]) => execFileSync("git", a, { cwd: p, encoding: "utf8" }).trim();
      g("init", "-q", "-b", name);
      g("config", "user.name", "t");
      g("config", "user.email", "t@example.com");
      g("commit", "-q", "--allow-empty", "-m", "x");
      const r = await checkRepo(p);
      expect(r.items[2]).toEqual({ id: "main", ok: true });
      expect(r.current_branch).toBe(name);
      expect(r.default_branch).toBe(name);
    }
  });

  it("默认分支识别（T-120）：仓库有 main 时，检出在功能分支上不影响默认分支", async () => {
    git("init", "-q", "-b", "main");
    ident();
    git("commit", "-q", "--allow-empty", "-m", "x");
    git("branch", "feat/x");
    git("checkout", "-q", "feat/x");
    const r = await checkRepo(dir);
    expect(r.items[2]).toEqual({ id: "main", ok: true });
    expect(r.current_branch).toBe("feat/x");
    expect(r.default_branch).toBe("main");
  });

  it("默认分支识别（T-120）：origin/HEAD 指向的远程默认分支优先于当前检出分支", async () => {
    git("init", "-q", "-b", "main");
    ident();
    git("commit", "-q", "--allow-empty", "-m", "x");
    git("branch", "master");
    git("checkout", "-q", "master");
    git("update-ref", "refs/remotes/origin/main", "refs/heads/main");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const r = await checkRepo(dir);
    expect(r.current_branch).toBe("master");
    expect(r.default_branch).toBe("main");
    expect(r.items[2]).toEqual({ id: "main", ok: true });
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
    expect(r.items[2]!.current).toBe("main");
    expect(r.default_branch).toBeNull();
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
  it("identity 可以只给一项，只写给了的那项（T-108）", async () => {
    const p = join(base, "partial");
    await initRepo(p, { identity: { email: "eva@example.com" } });
    const g = (...a: string[]) => execFileSync("git", a, { cwd: p, encoding: "utf8" }).trim();
    expect(g("config", "--local", "user.email")).toBe("eva@example.com");
    expect(() => g("config", "--local", "user.name")).toThrow();
    expect(await code(initRepo(join(base, "p2"), { identity: {} }))).toBe("invalid_identity");
    expect(existsSync(join(base, "p2"))).toBe(false);
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

  // T-108：只缺一项时只补那一项；先校验再写。
  const localCfg = () => readFileSync(join(dir, ".git", "config"), "utf8");

  it("只缺 email 时只补 email，原来的 name 不动", async () => {
    git("config", "--unset", "user.email");
    await initialCommit(dir, { empty: true, identity: { email: "eva@example.com" } });
    expect(git("log", "-1", "--format=%an <%ae>")).toBe("t <eva@example.com>");
    expect(git("config", "--local", "user.name")).toBe("t");
  });

  it("只缺 name 时只补 name", async () => {
    git("config", "--unset", "user.name");
    await initialCommit(dir, { empty: true, identity: { name: "Eva" } });
    expect(git("log", "-1", "--format=%an <%ae>")).toBe("Eva <t@example.com>");
  });

  it("给的加上已配的还凑不齐 → no_identity，.git/config 不改", async () => {
    git("config", "--unset", "user.name");
    git("config", "--unset", "user.email");
    const before = localCfg();
    expect(await code(initialCommit(dir, { empty: true, identity: { name: "Eva" } }))).toBe(
      "no_identity",
    );
    expect(localCfg()).toBe(before);
  });

  it("文件不合法 → invalid_files，身份不写进 .git/config", async () => {
    git("config", "--unset", "user.name");
    git("config", "--unset", "user.email");
    const before = localCfg();
    expect(
      await code(
        initialCommit(dir, {
          files: [".env"],
          identity: { name: "Eva", email: "eva@example.com" },
        }),
      ),
    ).toBe("invalid_files");
    expect(localCfg()).toBe(before);
    expect(await code(initialCommit(dir, { files: [], identity: { name: "Eva" } }))).toBe(
      "invalid_files",
    );
    expect(localCfg()).toBe(before);
  });

  it.each([
    [{}],
    [{ name: undefined, email: undefined }],
    [{ email: "nope" }],
    [{ name: " " }],
    [{ name: "a\nb" }],
    [null],
  ])("身份不合法 → invalid_identity，什么都不改：%j", async (identity) => {
    const before = localCfg();
    expect(await code(initialCommit(dir, { empty: true, identity: identity as never }))).toBe(
      "invalid_identity",
    );
    expect(localCfg()).toBe(before);
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

describe("git 环境变量隔离（gitEnv）", () => {
  const other = () => {
    const o = join(base, "other");
    mkdirSync(o);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: o });
    return o;
  };
  const otherGit = (o: string, ...a: string[]) =>
    execFileSync("git", a, { cwd: o, encoding: "utf8", env: process.env }).trim();

  it("设了 GIT_DIR / GIT_WORK_TREE：检查和写入都只作用于目标目录", async () => {
    const o = other();
    process.env.GIT_DIR = join(o, ".git");
    process.env.GIT_WORK_TREE = o;
    try {
      expect((await checkRepo(dir)).items[0]).toMatchObject({ ok: false, code: "not_git" });
      await initRepo(dir, { identity: { name: "Eva", email: "eva@example.com" } });
      writeFileSync(join(dir, "README.md"), "x\n");
      await initialCommit(dir, { files: ["README.md"] });
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_WORK_TREE;
    }
    expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("README.md");
    expect(() => otherGit(o, "rev-parse", "--verify", "-q", "HEAD")).toThrow();
    expect(() => otherGit(o, "config", "--local", "user.name")).toThrow();
  });

  it("设了 GIT_INDEX_FILE：不写那个索引，提交照常", async () => {
    git("init", "-q", "-b", "main");
    ident();
    writeFileSync(join(dir, "README.md"), "x\n");
    const idx = join(base, "foreign-index");
    process.env.GIT_INDEX_FILE = idx;
    try {
      await initialCommit(dir, { files: ["README.md"] });
    } finally {
      delete process.env.GIT_INDEX_FILE;
    }
    expect(existsSync(idx)).toBe(false);
    expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("README.md");
  });

  it("设了 GIT_AUTHOR_* / GIT_COMMITTER_*：提交作者和提交者仍取自仓库配置", async () => {
    git("init", "-q", "-b", "main");
    ident();
    const keys = [
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
    ];
    for (const k of keys) process.env[k] = k.endsWith("EMAIL") ? "env@example.com" : "env";
    try {
      await initialCommit(dir, { empty: true });
    } finally {
      for (const k of keys) delete process.env[k];
    }
    expect(git("log", "-1", "--format=%an <%ae>|%cn <%ce>")).toBe(
      "t <t@example.com>|t <t@example.com>",
    );
  });
});

describe("边界情况", () => {
  it("dir 自己已有嵌套仓库（外层里早就建好的）：仍算仓库根，不报 nested_repo", async () => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: base });
    git("init", "-q", "-b", "main");
    expect((await checkRepo(dir)).items[0]).toEqual({ id: "git", ok: true });
    expect(await code(initRepo(dir))).toBe("repo_exists");
  });

  it.skipIf(process.platform === "win32")("符号链接只提交链接本身，不提交目标内容", async () => {
    git("init", "-q", "-b", "main");
    ident();
    const outside = join(base, "outside-secret.txt");
    writeFileSync(outside, "TOP-SECRET-CONTENT\n");
    symlinkSync(outside, join(dir, "link.txt"));
    const files = await listInitialCommitFiles(dir);
    expect(files.include).toContain("link.txt");
    await initialCommit(dir, { files: ["link.txt"] });
    expect(git("ls-tree", "HEAD", "link.txt")).toMatch(/^120000 blob /);
    expect(git("cat-file", "-p", "HEAD:link.txt")).toBe(outside);
  });

  it("detail 里的分支名截断到 100 字符以内，current 给完整名", async () => {
    const long = `feature/${"x".repeat(150)}`;
    git("init", "-q", "-b", long);
    const r = await checkRepo(dir);
    const main = r.items[2]!;
    expect(main.current).toBe(long);
    expect(main.detail).not.toContain(long);
    const shown = /当前是 (.*)）/.exec(main.detail ?? "")![1]!;
    expect(shown.length).toBeLessThanOrEqual(100);
  });
});

describe("嵌套仓库（T-114）", () => {
  const NESTED =
    "这个文件夹在另一个 Git 仓库里面。请导入上层仓库的根目录，或把文件夹移到仓库外再初始化";
  const outerHead = () =>
    execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: base, encoding: "utf8" });

  it("外层仓库的子目录：initRepo 抛 nested_repo，不建 .git、不写 exclude，外层不动", async () => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: base });
    const outerExclude = join(base, ".git", "info", "exclude");
    const excludeBefore = readFileSync(outerExclude, "utf8");
    const statusBefore = outerHead();
    let err: unknown;
    try {
      await initRepo(dir, { identity: { name: "Eva", email: "eva@example.com" } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RepoFixError);
    expect((err as RepoFixError).code).toBe("nested_repo");
    expect((err as RepoFixError).message).toBe(NESTED);
    expect((err as RepoFixError).message).not.toContain(base);
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(readFileSync(outerExclude, "utf8")).toBe(excludeBefore);
    expect(outerHead()).toBe(statusBefore);
    expect(() =>
      execFileSync("git", ["config", "--local", "user.name"], { cwd: base, stdio: "ignore" }),
    ).toThrow();
  });

  it("dir 还不存在、上级在外层仓库里：initRepo 抛 nested_repo，不建目录；checkRepo 也报 nested_repo", async () => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: base });
    const target = join(dir, "a", "b");
    expect(await code(initRepo(target))).toBe("nested_repo");
    expect(existsSync(join(dir, "a"))).toBe(false);
    expect((await checkRepo(target)).items[0]).toMatchObject({ ok: false, code: "nested_repo" });
  });

  it("多层子目录也算嵌套", async () => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: base });
    const deep = join(dir, "x", "y");
    mkdirSync(deep, { recursive: true });
    expect((await checkRepo(deep)).items[0]).toMatchObject({ code: "nested_repo" });
    expect(await code(initRepo(deep))).toBe("nested_repo");
  });

  it.each([
    ["空的 .git 目录", () => mkdirSync(join(base, ".git"))],
    ["指向不存在位置的 .git 文件", () => writeFileSync(join(base, ".git"), "gitdir: ./nowhere\n")],
  ])("rev-parse 失败时逐层 lstat 找 .git：上级有%s 也算嵌套", async (_n, make) => {
    make();
    expect(() =>
      execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, stdio: "ignore" }),
    ).toThrow();
    expect((await checkRepo(dir)).items[0]).toMatchObject({ ok: false, code: "nested_repo" });
    expect(await code(initRepo(dir))).toBe("nested_repo");
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  it("嵌套目录上的提交类修复抛 nested_repo 而不是 not_git", async () => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: base });
    expect(await code(listInitialCommitFiles(dir))).toBe("nested_repo");
    expect(await code(initialCommit(dir, { empty: true }))).toBe("nested_repo");
    expect(await code(createMainBranch(dir))).toBe("nested_repo");
  });

  it("不是仓库的普通目录：行为不变（not_git，可以 init）", async () => {
    expect((await checkRepo(dir)).items[0]).toMatchObject({ code: "not_git" });
    expect(await code(listInitialCommitFiles(dir))).toBe("not_git");
    await initRepo(dir);
    expect((await checkRepo(dir)).items[0]).toEqual({ id: "git", ok: true });
  });

  it("仓库根：行为不变（git 项通过，再 init 报 repo_exists）", async () => {
    git("init", "-q", "-b", "main");
    expect((await checkRepo(dir)).items[0]).toEqual({ id: "git", ok: true });
    expect(await code(initRepo(dir))).toBe("repo_exists");
  });

  it("设了 GIT_DIR / GIT_CEILING_DIRECTORIES 不影响判断（gitEnv 剔掉 GIT_*）", async () => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: base });
    process.env.GIT_DIR = join(base, ".git");
    process.env.GIT_CEILING_DIRECTORIES = base;
    try {
      expect((await checkRepo(dir)).items[0]).toMatchObject({ code: "nested_repo" });
      expect(await code(initRepo(dir))).toBe("nested_repo");
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_CEILING_DIRECTORIES;
    }
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });
});
