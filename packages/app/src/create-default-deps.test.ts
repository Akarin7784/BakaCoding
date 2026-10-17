import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, getConfig } from "@bakacoding/config-budget";
import { openStorage, type Storage } from "@bakacoding/storage";
import { WorktreeManager, WORKTREES_DIR } from "@bakacoding/workspace";
import { afterEach, describe, expect, it } from "vitest";
import { assemble, type App } from "./assemble.js";
import {
  createDefaultDeps,
  integrationTargetHead,
  PrNotWiredError,
} from "./create-default-deps.js";
import { RepoNotReadyError } from "./index.js";

const examplePath = fileURLToPath(new URL("../../../config/models.example.json", import.meta.url));
const pricingPath = fileURLToPath(new URL("../../../config/pricing.json", import.meta.url));

let dirs: string[] = [];
let opened: Storage[] = [];
let apps: App[] = [];
let disposers: Array<() => void> = [];

afterEach(() => {
  for (const a of apps) a.stop();
  apps = [];
  for (const d of disposers) d();
  disposers = [];
  for (const s of opened) s.close();
  opened = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** 默认分支 main、一个提交（T-084 起没有 main 的仓库启动即抛 RepoNotReadyError） */
function gitRepo(): { root: string; db: string } {
  const root = mkdtempSync(join(tmpdir(), "bc-cdd-"));
  dirs.push(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  writeFileSync(join(root, "README.md"), "x\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root });
  const dbDir = join(root, ".bakacoding");
  mkdirSync(dbDir, { recursive: true });
  const db = join(dbDir, "bakacoding.db");
  return { root, db };
}

function openDb(path: string): Storage {
  const s = openStorage({ path, logger: { warn: () => {} } });
  opened.push(s);
  return s;
}

const env = { DEEPSEEK_API_KEY: "test-key-not-real" };

describe("createDefaultDeps（T-063）", () => {
  it("缺 DEEPSEEK_API_KEY 抛 ConfigError，信息不含值", async () => {
    const { root, db } = gitRepo();
    const storage = openDb(db);
    const config = getConfig(examplePath);
    await expect(
      createDefaultDeps(config, storage, {
        repoRoot: root,
        notifyUser: () => {},
        pricingPath,
        env: {},
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("只建一条总线：模块 1 publish、模块 3 台账、supervisor 共用", async () => {
    const { root, db } = gitRepo();
    const storage = openDb(db);
    const config = getConfig(examplePath);
    const notes: string[] = [];
    const handle = await createDefaultDeps(config, storage, {
      repoRoot: root,
      notifyUser: (m) => notes.push(m.text),
      pricingPath,
      env,
      logger: { warn: () => {} },
    });
    disposers.push(handle.dispose);
    expect(handle.deps.bus).toBe(handle.bus);

    const app = await assemble(handle.deps);
    apps.push(app);
    expect(app.bus).toBe(handle.bus);

    // 经总线发 call_completed → storage 落库 + budget 台账（同一条 bus）
    await handle.bus.publish({
      type: "call_completed",
      trace_id: "tr",
      span_id: "sp",
      parent_span_id: null,
      requirement_id: "req-1",
      ticket_id: null,
      payload: {
        role: "supervisor",
        provider: "deepseek",
        model: "deepseek-flash",
        effort: "max",
        prompt: "p",
        output: "o",
        tokens: { input: 1, output: 1, cache_hit_input: 0 },
        cache_hit: false,
        latency_ms: 1,
        cost: 1,
        is_resubmit: false,
        rate_limited_retry: 0,
        error: null,
      },
    });
    const evs = storage.queryEvents({ types: ["call_completed"] });
    expect(evs).toHaveLength(1);
    const day = new Date().toISOString().slice(0, 10);
    const totals = await storage.ledger.totalsByDay(day);
    expect(totals.total_micro_usd).toBeGreaterThanOrEqual(1);

    // supervisor / 组合根用的就是同一条 bus（发 ticket_warning 也能落库）
    await app.bus.publish({
      type: "ticket_warning",
      trace_id: "tr2",
      span_id: "sp2",
      parent_span_id: null,
      requirement_id: "req-1",
      ticket_id: "t-1",
      payload: {
        ticket_id: "t-1",
        requirement_id: "req-1",
        project_id: "p",
        code: "fields_invalid",
        detail: "x",
      },
    });
    expect(storage.queryEvents({ types: ["ticket_warning"] }).length).toBe(1);
  });

  it("接线前 reviewPr 抛错；assemble 返回后已接上", async () => {
    const { root, db } = gitRepo();
    const storage = openDb(db);
    const config = getConfig(examplePath);
    const handle = await createDefaultDeps(config, storage, {
      repoRoot: root,
      notifyUser: () => {},
      pricingPath,
      env,
      logger: { warn: () => {} },
    });
    disposers.push(handle.dispose);

    await expect(handle.reviewPr.diff("nope")).rejects.toBeInstanceOf(PrNotWiredError);
    await expect(handle.reviewPr.checks("nope")).rejects.toThrow(/还没接上/);

    const app = await assemble(handle.deps);
    apps.push(app);
    // 接线后：真实 provider 对不存在的 PR 抛自己的错，不再是 PrNotWiredError
    let err: unknown;
    try {
      await handle.reviewPr.diff("missing-pr");
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(PrNotWiredError);
    expect(app.pr).toBeTruthy();
  });

  it("PermissionRegistry 是同一份（4/5 共用）", async () => {
    const { root, db } = gitRepo();
    const storage = openDb(db);
    const config = getConfig(examplePath);
    const handle = await createDefaultDeps(config, storage, {
      repoRoot: root,
      notifyUser: () => {},
      pricingPath,
      env,
      logger: { warn: () => {} },
    });
    disposers.push(handle.dispose);
    handle.registry.applyPermissions("T-reg", [{ glob: "src/**", level: "rw" }]);
    expect(handle.registry.get("T-reg")).toEqual([{ glob: "src/**", level: "rw" }]);
    // 编码池注入的就是这一份：释放后登记表清空
    handle.registry.release("T-reg");
    expect(handle.registry.get("T-reg")).toBeUndefined();
  });

  it("deps.repoRoot 取 worktrees 解析出的仓库根（不是调用方传的目录原样）", async () => {
    const { root, db } = gitRepo();
    // 故意从仓库子目录启动：4 的 WorktreeManager 会解析成仓库根（--show-toplevel，真实路径），
    // deps.repoRoot 必须是它；组合根漏传这一行时 deps.repoRoot 为 undefined，本条变红
    const sub = join(root, "sub", "dir");
    mkdirSync(sub, { recursive: true });
    const storage = openDb(db);
    const config = getConfig(examplePath);
    const handle = await createDefaultDeps(config, storage, {
      repoRoot: sub,
      notifyUser: () => {},
      pricingPath,
      env,
      logger: { warn: () => {} },
    });
    disposers.push(handle.dispose);
    const expected = (await WorktreeManager.open(sub)).repoRoot;
    expect(expected).toBe(realpathSync(root));
    expect(handle.deps.repoRoot).toBe(expected);
    expect(handle.deps.worktreeRoot).toBe(join(expected, WORKTREES_DIR));
  });
});

describe("targetHead 读集成分支（T-079）", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  /** main 上一个提交；检出 feature，上面有一个没合进 main 的提交 */
  function repoOnFeature(): { root: string; db: string; main: string; feature: string } {
    const root = mkdtempSync(join(tmpdir(), "bc-t079-"));
    dirs.push(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@test");
    git(root, "config", "user.name", "t");
    writeFileSync(join(root, "README.md"), "x\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "init");
    const main = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-q", "-b", "feature");
    writeFileSync(join(root, "feat.txt"), "f\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "unmerged");
    const feature = git(root, "rev-parse", "HEAD");
    const dbDir = join(root, ".bakacoding");
    mkdirSync(dbDir, { recursive: true });
    return { root, db: join(dbDir, "bakacoding.db"), main, feature };
  }

  it("集成分支还没建：退回 main，不读检出的 feature HEAD", async () => {
    const { root, main, feature } = repoOnFeature();
    expect(await integrationTargetHead(root)).toBe(main);
    expect(await integrationTargetHead(root)).not.toBe(feature);
  });

  it("仓库里没有 main（默认分支叫别的）：不退回检出的 HEAD，抛 RepoNotReadyError no_main（T-084）", async () => {
    const { root } = gitRepo();
    git(root, "branch", "-m", "trunk");
    const err = await integrationTargetHead(root).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoNotReadyError);
    expect(err).toMatchObject({ code: "no_main", current: "trunk" });
  });

  it("基线分支由参数给出：集成分支未建时读该分支，不写死 main", async () => {
    const { root, main } = repoOnFeature();
    git(root, "branch", "trunk", main);
    git(root, "branch", "-D", "main");
    expect(await integrationTargetHead(root, "trunk")).toBe(main);
  });

  it("集成分支已建且领先 main：读集成分支；组合根的 deps.targetHead 用的就是它", async () => {
    const { root, db, main, feature } = repoOnFeature();
    // 模拟单 1 已合入：集成分支 = main + 一个提交（不检出）
    const tree = git(root, "rev-parse", `${main}^{tree}`);
    const merged = git(root, "commit-tree", tree, "-p", main, "-m", "T-1 merged");
    git(root, "update-ref", "refs/heads/bakacoding/integration", merged);
    expect(await integrationTargetHead(root)).toBe(merged);

    const storage = openDb(db);
    const handle = await createDefaultDeps(getConfig(examplePath), storage, {
      repoRoot: root,
      notifyUser: () => {},
      pricingPath,
      env,
      logger: { warn: () => {} },
    });
    disposers.push(handle.dispose);
    const head = await handle.deps.targetHead();
    expect(head).toBe(merged);
    expect(head).not.toBe(feature);
    expect(head).not.toBe(main);
  });
});

describe("仓库没准备好时启动报明确原因（T-084）", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  /** 空仓库（未提交）；`commit` 时在 branch 上提交一次 */
  function repo(branch: string, commit: boolean): { root: string; db: string } {
    const root = mkdtempSync(join(tmpdir(), "bc-t084-"));
    dirs.push(root);
    git(root, "init", "-q", "-b", branch);
    git(root, "config", "user.email", "t@test");
    git(root, "config", "user.name", "t");
    if (commit) {
      writeFileSync(join(root, "README.md"), "x\n");
      git(root, "add", ".");
      git(root, "commit", "-q", "-m", "init");
    }
    const dbDir = join(root, ".bakacoding");
    mkdirSync(dbDir, { recursive: true });
    return { root, db: join(dbDir, "bakacoding.db") };
  }

  async function startErr(root: string, db: string): Promise<unknown> {
    const storage = openDb(db);
    try {
      const handle = await createDefaultDeps(getConfig(examplePath), storage, {
        repoRoot: root,
        notifyUser: () => {},
        pricingPath,
        env,
        logger: { warn: () => {} },
      });
      disposers.push(handle.dispose);
      return undefined;
    } catch (e) {
      return e;
    }
  }

  function expectNoPath(err: unknown, root: string): void {
    const msg = (err as Error).message;
    expect(msg).not.toContain(root);
    expect(msg).not.toContain(tmpdir());
    expect(msg).not.toMatch(/bc-t084-/);
  }

  it("空仓库（一次提交都没有）→ no_commits，消息是中文原因、不含路径", async () => {
    const { root, db } = repo("main", false);
    const err = await startErr(root, db);
    expect(err).toBeInstanceOf(RepoNotReadyError);
    expect(err).toBeInstanceOf(Error);
    const e = err as RepoNotReadyError;
    expect(e.name).toBe("RepoNotReadyError");
    expect(e.code).toBe("no_commits");
    expect(e.current).toBeUndefined();
    expect(e.message).toBe("仓库没有任何提交，请先提交一次再启动");
    expectNoPath(e, root);
  });

  it("只有 master → no_main，current 为 master", async () => {
    const { root, db } = repo("master", true);
    const err = await startErr(root, db);
    expect(err).toBeInstanceOf(RepoNotReadyError);
    const e = err as RepoNotReadyError;
    expect(e.code).toBe("no_main");
    expect(e.current).toBe("master");
    expect(e.message).toBe("仓库里没有 main 分支（当前是 master），这一版只支持 main");
    expectNoPath(e, root);
  });

  it("分离 HEAD 且没有 main → no_main，current 缺省，消息写分离 HEAD", async () => {
    const { root, db } = repo("master", true);
    git(root, "checkout", "-q", "--detach");
    git(root, "branch", "-D", "master");
    const err = await startErr(root, db);
    expect(err).toBeInstanceOf(RepoNotReadyError);
    const e = err as RepoNotReadyError;
    expect(e.code).toBe("no_main");
    expect(e.current).toBeUndefined();
    expect(e.message).toBe("仓库里没有 main 分支（当前是 分离 HEAD），这一版只支持 main");
    expectNoPath(e, root);
  });

  it("有提交但 HEAD 在未出生的分支、仓库里只有 master → no_main（不是 no_commits）", async () => {
    const { root, db } = repo("master", true);
    git(root, "checkout", "-q", "--orphan", "fresh");
    const err = await startErr(root, db);
    expect(err).toMatchObject({ code: "no_main", current: "fresh" });
  });

  it("有 main：正常建好，targetHead 是 main 的提交", async () => {
    const { root, db } = repo("main", true);
    const storage = openDb(db);
    const handle = await createDefaultDeps(getConfig(examplePath), storage, {
      repoRoot: root,
      notifyUser: () => {},
      pricingPath,
      env,
      logger: { warn: () => {} },
    });
    disposers.push(handle.dispose);
    expect(await handle.deps.targetHead()).toBe(git(root, "rev-parse", "main"));
  });

  it("main 不存在但集成分支在 → 照常启动（targetHead 读集成分支）", async () => {
    const { root, db } = repo("master", true);
    git(root, "branch", "bakacoding/integration", "master");
    const storage = openDb(db);
    const handle = await createDefaultDeps(getConfig(examplePath), storage, {
      repoRoot: root,
      notifyUser: () => {},
      pricingPath,
      env,
      logger: { warn: () => {} },
    });
    disposers.push(handle.dispose);
    expect(await handle.deps.targetHead()).toBe(git(root, "rev-parse", "master"));
  });

  it("仓库检查先于其他：没准备好时连缺 DEEPSEEK_API_KEY 都不报，也不建总线", async () => {
    const { root, db } = repo("master", true);
    const storage = openDb(db);
    const before = storage.nextSeq();
    const err = await createDefaultDeps(getConfig(examplePath), storage, {
      repoRoot: root,
      notifyUser: () => {},
      pricingPath,
      env: {},
      logger: { warn: () => {} },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoNotReadyError);
    expect(err).not.toBeInstanceOf(ConfigError);
    expect(storage.nextSeq()).toBe(before);
  });
});

describe("仓库检查不受外部 GIT_* 环境变量影响（T-084，#97 评审）", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: cleanEnv() }).trim();

  /** 建测试仓库本身也不能被设进 process.env 的 GIT_* 影响 */
  function cleanEnv(): NodeJS.ProcessEnv {
    return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  }

  const originalGitDir = process.env.GIT_DIR;
  const saved = new Map<string, string | undefined>();
  function setEnv(name: string, value: string): void {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    process.env[name] = value;
  }
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });

  function repo(branch: string, commit: boolean): { root: string; db: string } {
    const root = mkdtempSync(join(tmpdir(), "bc-t084env-"));
    dirs.push(root);
    git(root, "init", "-q", "-b", branch);
    git(root, "config", "user.email", "t@test");
    git(root, "config", "user.name", "t");
    if (commit) {
      writeFileSync(join(root, "README.md"), "x\n");
      git(root, "add", ".");
      git(root, "commit", "-q", "-m", "init");
    }
    const dbDir = join(root, ".bakacoding");
    mkdirSync(dbDir, { recursive: true });
    return { root, db: join(dbDir, "bakacoding.db") };
  }

  it("GIT_DIR 指向另一个有 main 的仓库：目标仓库（只有 master）仍报 no_main", async () => {
    const other = repo("main", true);
    const { root, db } = repo("master", true);
    setEnv("GIT_DIR", join(other.root, ".git"));
    const storage = openDb(db);
    const err = await createDefaultDeps(getConfig(examplePath), storage, {
      repoRoot: root,
      notifyUser: () => {},
      pricingPath,
      env,
      logger: { warn: () => {} },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoNotReadyError);
    expect(err).toMatchObject({ code: "no_main", current: "master" });
    expect(await integrationTargetHead(root).catch((e: unknown) => e)).toBeInstanceOf(
      RepoNotReadyError,
    );
  });

  it("目标仓库有 main、GIT_DIR 指向空仓库：仍正常启动，targetHead 是目标仓库的 main", async () => {
    const empty = repo("main", false);
    const { root, db } = repo("main", true);
    const mainSha = git(root, "rev-parse", "main");
    setEnv("GIT_DIR", join(empty.root, ".git"));
    const storage = openDb(db);
    const handle = await createDefaultDeps(getConfig(examplePath), storage, {
      repoRoot: root,
      notifyUser: () => {},
      pricingPath,
      env,
      logger: { warn: () => {} },
    });
    disposers.push(handle.dispose);
    expect(await handle.deps.targetHead()).toBe(mainSha);
    expect(await integrationTargetHead(root)).toBe(mainSha);
  });

  it("listFiles（T-101）：GIT_DIR 指向另一个仓库时仍列目标仓库的文件", async () => {
    const other = repo("main", true);
    writeFileSync(join(other.root, "only-in-other.txt"), "o\n");
    git(other.root, "add", ".");
    git(other.root, "commit", "-q", "-m", "other");
    const { root, db } = repo("main", true);
    const head = git(root, "rev-parse", "main");
    setEnv("GIT_DIR", join(other.root, ".git"));
    const storage = openDb(db);
    const handle = await createDefaultDeps(getConfig(examplePath), storage, {
      repoRoot: root,
      notifyUser: () => {},
      pricingPath,
      env,
      logger: { warn: () => {} },
    });
    disposers.push(handle.dispose);
    expect(await handle.deps.listFiles?.("p", "HEAD")).toEqual(["README.md"]);
    expect(await handle.deps.listFiles?.("p", head)).toEqual(["README.md"]);
  });

  it("测试设的 GIT_DIR 在用例之后已恢复原值", () => {
    expect(process.env.GIT_DIR).toBe(originalGitDir);
  });
});

describe("listFiles 大输出（T-101）", () => {
  it("ls-tree 输出超过默认 1 MiB 也能读完（listFiles 自带 16 MiB 上限）", async () => {
    const { root, db } = gitRepo();
    const g = (input: string | undefined, ...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8", input }).trim();
    // 用底层命令直接造一棵 6000 个长文件名的树（同一个 blob），比真建文件快
    const blob = g("x\n", "hash-object", "-w", "--stdin");
    const pad = "n".repeat(200);
    const names = Array.from(
      { length: 6000 },
      (_, i) => `${pad}-${String(i).padStart(5, "0")}.txt`,
    );
    const tree = g(names.map((n) => `100644 blob ${blob}\t${n}`).join("\n") + "\n", "mktree");
    const commit = g(undefined, "commit-tree", tree, "-m", "big");
    const bytes = names.reduce((n, s) => n + Buffer.byteLength(s) + 1, 0);
    expect(bytes).toBeGreaterThan(1024 * 1024);

    const storage = openDb(db);
    const handle = await createDefaultDeps(getConfig(examplePath), storage, {
      repoRoot: root,
      notifyUser: () => {},
      pricingPath,
      env,
      logger: { warn: () => {} },
    });
    disposers.push(handle.dispose);
    const files = await handle.deps.listFiles?.("p", commit);
    expect(files).toHaveLength(6000);
    expect(files).toEqual([...names].sort());
  });
});

describe("testConnection 透出（UI-03b）", () => {
  it("handle.testConnection 转给同一个网关：没配置的服务商回 config_error，不发请求、不抛错", async () => {
    const { root, db } = gitRepo();
    const storage = openDb(db);
    const handle = await createDefaultDeps(getConfig(examplePath), storage, {
      repoRoot: root,
      notifyUser: () => {},
      pricingPath,
      env,
      logger: { warn: () => {} },
    });
    disposers.push(handle.dispose);
    await expect(handle.testConnection({ provider: "no-such-provider" })).resolves.toEqual({
      ok: false,
      reason: "config_error",
    });
    await expect(
      handle.testConnection({ provider: "deepseek", model: "no-such-model" }),
    ).resolves.toMatchObject({ ok: false, reason: "config_error" });
  });
});
