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
  ensureBakacodingIgnored,
  ensureExcludeLines,
  normalizeIgnoreLine,
  WorktreeManager,
} from "./worktree.js";

let repo: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "bc-wt-")));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, ".env"), "SECRET=x\n"); // 未跟踪
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("WorktreeManager", () => {
  it("在约定路径创建 worktree 和分支，不带未跟踪文件，并写 exclude", async () => {
    const m = await WorktreeManager.open(repo);
    const base = git("rev-parse", "HEAD");
    const wt = await m.createWorktree("T-9", base, 1);
    expect(wt.path).toBe(join(repo, ".bakacoding/worktrees/T-9-r1"));
    expect(wt.branch).toBe("bakacoding/T-9-r1");
    expect(existsSync(join(wt.path, "a.txt"))).toBe(true);
    expect(existsSync(join(wt.path, ".env"))).toBe(false);
    expect(readFileSync(join(repo, ".git/info/exclude"), "utf8")).toContain("/.bakacoding/\n");
    expect(git("status", "--porcelain")).toBe("?? .env");
    await m.ensureIgnored();
    expect(readFileSync(join(repo, ".git/info/exclude"), "utf8").match(/bakacoding/g)).toHaveLength(
      1,
    );
  });
  it("T-078：排除整个 .bakacoding/，数据库等运行文件不出现在 git status", async () => {
    const m = await WorktreeManager.open(repo);
    await m.ensureIgnored();
    mkdirSync(join(repo, ".bakacoding"), { recursive: true });
    writeFileSync(join(repo, ".bakacoding/bakacoding.db"), "x");
    writeFileSync(join(repo, ".bakacoding/bakacoding.db-wal"), "x");
    await m.createWorktree("T-1", "HEAD");
    expect(git("status", "--porcelain", "--untracked-files=all")).toBe("?? .env");
  });
  it("T-078：旧版只写了 /.bakacoding/worktrees/ 的仓库补一行新规则，旧行保留，重复调用不再写", async () => {
    const exclude = join(repo, ".git/info/exclude");
    writeFileSync(exclude, "# user\n/.bakacoding/worktrees/");
    const m = await WorktreeManager.open(repo);
    await m.ensureIgnored();
    await m.ensureIgnored();
    expect(readFileSync(exclude, "utf8")).toBe("# user\n/.bakacoding/worktrees/\n/.bakacoding/\n");
    mkdirSync(join(repo, ".bakacoding"), { recursive: true });
    writeFileSync(join(repo, ".bakacoding/bakacoding.db"), "x");
    expect(git("status", "--porcelain", "--untracked-files=all")).toBe("?? .env");
  });
  it("T-078：用户已自行写了等价规则时不重复追加", async () => {
    const exclude = join(repo, ".git/info/exclude");
    writeFileSync(exclude, ".bakacoding/\n");
    const m = await WorktreeManager.open(repo);
    await m.ensureIgnored();
    expect(readFileSync(exclude, "utf8")).toBe(".bakacoding/\n");
  });
  it("T-078：ensureBakacodingIgnored 从子目录调用也写进仓库；非 git 目录返回 false 不抛错", async () => {
    mkdirSync(join(repo, "sub"), { recursive: true });
    expect(await ensureBakacodingIgnored(join(repo, "sub"))).toBe(true);
    expect(readFileSync(join(repo, ".git/info/exclude"), "utf8")).toContain("/.bakacoding/\n");
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "bc-nogit-")));
    try {
      expect(await ensureBakacodingIgnored(plain)).toBe(false);
      expect(existsSync(join(plain, ".git"))).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
  it("T-082：行首有空格的行按 git 语义不等价，照常补新规则；行尾空格和 CRLF 视为等价", async () => {
    const exclude = join(repo, ".git/info/exclude");
    writeFileSync(exclude, " /.bakacoding/\n");
    expect(await ensureBakacodingIgnored(repo)).toBe(true);
    expect(readFileSync(exclude, "utf8")).toBe(" /.bakacoding/\n/.bakacoding/\n");
    mkdirSync(join(repo, ".bakacoding"), { recursive: true });
    writeFileSync(join(repo, ".bakacoding/bakacoding.db"), "x");
    expect(git("status", "--porcelain", "--untracked-files=all")).toBe("?? .env");
    writeFileSync(exclude, "# c\r\n/.bakacoding/   \r\n");
    expect(await ensureBakacodingIgnored(repo)).toBe(true);
    expect(readFileSync(exclude, "utf8")).toBe("# c\r\n/.bakacoding/   \r\n");
  });
});

describe("normalizeIgnoreLine（T-082）", () => {
  it("和 git 一样：去行尾未转义空格、保留行首空格、注释和空行为 null", () => {
    expect(normalizeIgnoreLine("/a/  ")).toBe("/a/");
    expect(normalizeIgnoreLine("  /a/")).toBe("  /a/");
    expect(normalizeIgnoreLine("/a\\ ")).toBe("/a\\ ");
    expect(normalizeIgnoreLine("/a\\  ")).toBe("/a\\ ");
    expect(normalizeIgnoreLine("# x")).toBeNull();
    expect(normalizeIgnoreLine("\\#x")).toBe("\\#x");
    expect(normalizeIgnoreLine("   ")).toBeNull();
    expect(normalizeIgnoreLine("")).toBeNull();
  });
  it("结果和 git check-ignore 一致", () => {
    const exclude = join(repo, ".git/info/exclude");
    writeFileSync(exclude, "lead\n x1\ntrail  \n");
    for (const f of ["lead", "x1", " x1", "trail", "trail "]) writeFileSync(join(repo, f), "");
    const ignored = (f: string) => {
      try {
        execFileSync("git", ["check-ignore", "-q", "--", f], { cwd: repo });
        return true;
      } catch {
        return false;
      }
    };
    const lines = readFileSync(exclude, "utf8").split("\n").map(normalizeIgnoreLine);
    for (const f of ["lead", "x1", " x1", "trail", "trail "]) {
      expect(
        lines.some((l) => l === f),
        f,
      ).toBe(ignored(f));
    }
  });
});

describe("ensureExcludeLines（T-082）", () => {
  const exclude = () => join(repo, ".git/info/exclude");
  it("按顺序只追加缺的规则，已有的不动；重复调用不再写", async () => {
    writeFileSync(exclude(), "/b\n/config/models.json  ");
    const rules = ["/config/models.json", "/config/pricing.json", "/b"];
    expect(await ensureExcludeLines(repo, rules)).toBe(true);
    expect(await ensureExcludeLines(repo, rules)).toBe(true);
    expect(readFileSync(exclude(), "utf8")).toBe(
      "/b\n/config/models.json  \n/config/pricing.json\n",
    );
    writeFileSync(join(repo, "config-x"), "");
    mkdirSync(join(repo, "config"), { recursive: true });
    writeFileSync(join(repo, "config/models.json"), "{}");
    writeFileSync(join(repo, "config/pricing.json"), "{}");
    expect(git("status", "--porcelain", "--untracked-files=all").split("\n").sort()).toEqual([
      "?? .env",
      "?? config-x",
    ]);
  });
  it("没有 exclude 文件和 info 目录时新建；同一批里重复的规则只写一次", async () => {
    rmSync(join(repo, ".git/info"), { recursive: true, force: true });
    expect(await ensureExcludeLines(repo, ["/x", "/x  "])).toBe(true);
    expect(readFileSync(exclude(), "utf8")).toBe("/x\n");
  });
  it("equivalents 里任一写法已存在就不追加", async () => {
    writeFileSync(exclude(), "x/\n");
    expect(await ensureExcludeLines(repo, [{ line: "/x/", equivalents: ["x/"] }])).toBe(true);
    expect(readFileSync(exclude(), "utf8")).toBe("x/\n");
  });
  it("在 worktree 里调用写进主仓库的 exclude；非 git 目录返回 false", async () => {
    const wt = join(repo, ".bakacoding/worktrees/T-1-r0");
    git("worktree", "add", "-q", "-b", "w", wt);
    expect(await ensureExcludeLines(wt, ["/y"])).toBe(true);
    expect(readFileSync(exclude(), "utf8")).toContain("/y\n");
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "bc-nogit-")));
    try {
      expect(await ensureExcludeLines(plain, ["/y"])).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
  it("规则为空、全是空格、是注释或含换行时抛 TypeError，不写文件", async () => {
    writeFileSync(exclude(), "");
    for (const bad of ["", "   ", "# c", "/a\n/b", "/a\r"]) {
      await expect(ensureExcludeLines(repo, ["/ok", bad])).rejects.toThrow(TypeError);
    }
    expect(readFileSync(exclude(), "utf8")).toBe("");
  });
});

describe("WorktreeManager（续）", () => {
  it("cleanup 按 ticket 清掉所有轮次，按路径只清一个", async () => {
    const m = await WorktreeManager.open(repo);
    const a = await m.createWorktree("T-1", "HEAD", 0);
    await m.createWorktree("T-1", "HEAD", 1);
    const c = await m.createWorktree("T-10", "HEAD", 0);
    expect(await m.cleanup(a.path)).toEqual([a.path]);
    expect((await m.cleanup("T-1")).length).toBe(1);
    expect(git("branch", "--list", "bakacoding/T-1-*")).toBe("");
    expect(existsSync(c.path)).toBe(true);
    expect(git("branch", "--list", "bakacoding/T-10-r0")).toContain("T-10-r0");
  });
  it("拒绝非法 ticket_id、重复创建和不存在的 base", async () => {
    const m = await WorktreeManager.open(repo);
    await expect(m.createWorktree("../x", "HEAD")).rejects.toThrow(/ticket_id/);
    await m.createWorktree("T-2", "HEAD");
    await expect(m.createWorktree("T-2", "HEAD")).rejects.toThrow();
    await expect(m.createWorktree("T-3", "deadbeef")).rejects.toThrow();
  });
});
