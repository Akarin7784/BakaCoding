import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, getConfig } from "@bakacoding/config-budget";
import { openStorage, type Storage } from "@bakacoding/storage";
import { afterEach, describe, expect, it } from "vitest";
import { assemble, type App } from "./assemble.js";
import { createDefaultDeps, integrationTargetHead, PrNotWiredError } from "./create-default-deps.js";

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

function gitRepo(): { root: string; db: string } {
  const root = mkdtempSync(join(tmpdir(), "bc-cdd-"));
  dirs.push(root);
  execFileSync("git", ["init"], { cwd: root });
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

  it("仓库里没有 main（默认分支叫别的）：退回检出的 HEAD，不抛错", async () => {
    const { root } = gitRepo();
    git(root, "branch", "-m", "trunk");
    expect(await integrationTargetHead(root)).toBe(git(root, "rev-parse", "HEAD"));
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
