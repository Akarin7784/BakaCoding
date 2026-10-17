import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireWriterLock, type App } from "@bakacoding/app";
import {
  openStorage,
  openStorageReadonly,
  StorageLeaseError,
  type Storage,
} from "@bakacoding/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  backendLogDetail,
  NOT_GIT_REASON,
  NotifyBuffer,
  readonlyReasonFromError,
  resolveConfigPath,
  resolveRepoDbPath,
  resolveRepoPath,
  sanitizedDepsLogging,
  startBackend,
} from "./backend.js";

const examplePath = fileURLToPath(
  new URL("../../../../config/models.example.json", import.meta.url),
);
const pricingPath = fileURLToPath(new URL("../../../../config/pricing.json", import.meta.url));

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function gitRepoWithConfig(): { root: string; db: string } {
  const root = mkdtempSync(join(tmpdir(), "bc-be-"));
  dirs.push(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  writeFileSync(join(root, "README.md"), "x\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root });
  mkdirSync(join(root, "config"), { recursive: true });
  copyFileSync(examplePath, join(root, "config", "models.json"));
  mkdirSync(join(root, ".bakacoding"), { recursive: true });
  return { root, db: join(root, ".bakacoding", "bakacoding.db") };
}

describe("路径解析（T-063）", () => {
  it("--repo > BAKACODING_REPO > cwd；db 默认在 repo 下", () => {
    const cwd = "/tmp/cwd-x";
    expect(resolveRepoPath(["--repo=/r"], {}, cwd)).toBe("/r");
    expect(resolveRepoPath([], { BAKACODING_REPO: "/e" }, cwd)).toBe("/e");
    expect(resolveRepoPath([], {}, cwd)).toBe(cwd);
    expect(resolveRepoDbPath([], {}, "/repo")).toBe(join("/repo", ".bakacoding", "bakacoding.db"));
    expect(resolveConfigPath([], {}, "/repo")).toBe(join("/repo", "config", "models.json"));
  });
});

describe("NotifyBuffer（T-063）", () => {
  it("就绪前缓冲；就绪回放一次后清空；之后直送 listener", () => {
    const got: string[] = [];
    const buf = new NotifyBuffer(200);
    buf.push({ text: "a" });
    buf.push({ text: "b" });
    expect(buf.pending()).toHaveLength(2);
    const off = buf.onNotify((m) => got.push(m.text));
    expect(buf.markReady()).toEqual([{ text: "a" }, { text: "b" }]);
    expect(buf.pending()).toEqual([]);
    buf.push({ text: "c" });
    expect(got).toEqual(["c"]);
    off();
    buf.push({ text: "d" });
    expect(got).toEqual(["c"]);
  });

  it("超过上限丢最旧并回调 onOverflow", () => {
    let drops = 0;
    const buf = new NotifyBuffer(3, () => {
      drops += 1;
    });
    buf.push({ text: "1" });
    buf.push({ text: "2" });
    buf.push({ text: "3" });
    buf.push({ text: "4" });
    buf.push({ text: "5" });
    expect(buf.pending().map((m) => m.text)).toEqual(["3", "4", "5"]);
    expect(drops).toBe(2);
  });
});

describe("startBackend（T-063）", () => {
  it("live：唯一写连接 + 只读 reader 可并存", async () => {
    const { root, db } = gitRepoWithConfig();
    const backend = await startBackend({
      argv: ["node", "app", `--repo=${root}`],
      env: { DEEPSEEK_API_KEY: "sk-test-live" },
      cwd: root,
      pricingPath,
      logger: { warn: () => {} },
    });
    expect(backend.status().mode).toBe("live");
    expect(backend.status().takeOver).toBeDefined();
    expect(backend.status().storage?.ok).toBe(true);
    // T-067：live 时 syncState 直接来自 9（无 GITHUB_TOKEN 走本地模式也能读）
    const st = backend.syncState();
    expect(st.available).toBe(true);
    if (st.available) {
      expect(typeof st.enabled).toBe("boolean");
      expect(st.consecutive_failures).toBe(0);
    }
    const ro = openStorageReadonly({ path: db, logger: { warn: () => {} } });
    const seq = ro.maxSeq();
    expect(seq === null || typeof seq === "number").toBe(true);
    ro.close();
    await backend.stop();
  });

  it("写入锁被活进程占用 → readonly", async () => {
    const { root } = gitRepoWithConfig();
    const a = await startBackend({
      argv: [`--repo=${root}`],
      env: { DEEPSEEK_API_KEY: "sk-a" },
      cwd: root,
      pricingPath,
      logger: { warn: () => {} },
    });
    expect(a.status().mode).toBe("live");
    const b = await startBackend({
      argv: [`--repo=${root}`],
      env: { DEEPSEEK_API_KEY: "sk-b" },
      cwd: root,
      pricingPath,
      logger: { warn: () => {} },
    });
    expect(b.status().mode).toBe("readonly");
    expect(b.status().reason).toMatch(/写入锁被占用/);
    await b.stop();
    await a.stop();
  });

  it("拿到锁但 StorageLeaseError → readonly", async () => {
    const { root } = gitRepoWithConfig();
    const secret = "super-secret-lease-key-should-not-leak";
    const backend = await startBackend({
      argv: [`--repo=${root}`],
      env: { DEEPSEEK_API_KEY: secret },
      cwd: root,
      pricingPath,
      logger: { warn: () => {} },
      openStorage: () => {
        throw new StorageLeaseError("lease held by other");
      },
    });
    expect(backend.status().mode).toBe("readonly");
    expect(backend.status().reason).toContain("StorageLeaseError");
    expect(JSON.stringify(backend.status())).not.toContain(secret);
    await backend.stop();
  });

  it("缺 DEEPSEEK_API_KEY → readonly，原因只写变量名", async () => {
    const { root } = gitRepoWithConfig();
    const backend = await startBackend({
      argv: [`--repo=${root}`],
      env: {},
      cwd: root,
      pricingPath,
      logger: { warn: () => {} },
    });
    expect(backend.status().mode).toBe("readonly");
    expect(backend.status().reason).toBe("缺少环境变量 DEEPSEEK_API_KEY");
    // T-067：只读时同步状态不可用，原因只写变量名
    expect(backend.syncState()).toEqual({
      available: false,
      reason: "只读模式：缺少环境变量 DEEPSEEK_API_KEY",
    });
    await backend.stop();
  });

  it("假密钥不出现在 backend:status 或日志", async () => {
    const { root } = gitRepoWithConfig();
    const secret = "planted-fake-secret-VALUE-xyz";
    const logs: string[] = [];
    const backend = await startBackend({
      argv: [`--repo=${root}`],
      env: { DEEPSEEK_API_KEY: secret },
      cwd: root,
      pricingPath,
      logger: {
        warn: (m, d) => logs.push(`${m} ${d === undefined ? "" : String(d)}`),
      },
      openStorage: () => {
        throw new StorageLeaseError("occupied");
      },
    });
    expect(JSON.stringify(backend.status())).not.toContain(secret);
    expect(JSON.stringify(backend.syncState())).not.toContain(secret);
    expect(logs.join("\n")).not.toContain(secret);
    await backend.stop();
  });
});

describe("startBackend 在建库之前写 .git/info/exclude（T-078）", () => {
  const excludeOf = (root: string) => {
    const p = join(root, ".git", "info", "exclude");
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  };
  const hasRule = (root: string) => excludeOf(root).split(/\r?\n/).includes("/.bakacoding/");

  it("openStorage 被调用时规则已经写好；之后 git status 不显示 .bakacoding/", async () => {
    const { root } = gitRepoWithConfig();
    let atOpen: boolean | undefined;
    const backend = await startBackend({
      argv: [`--repo=${root}`],
      env: { DEEPSEEK_API_KEY: "sk-t078" },
      cwd: root,
      pricingPath,
      logger: { warn: () => {} },
      openStorage: (o) => {
        atOpen = hasRule(root);
        return openStorage(o);
      },
    });
    expect(atOpen).toBe(true);
    expect(backend.status().mode).toBe("live");
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(status).not.toContain(".bakacoding");
    await backend.stop();
  });

  it("缺密钥进只读时也照样写", async () => {
    const { root } = gitRepoWithConfig();
    const backend = await startBackend({
      argv: [`--repo=${root}`],
      env: {},
      cwd: root,
      pricingPath,
      logger: { warn: () => {} },
    });
    expect(backend.status().mode).toBe("readonly");
    expect(hasRule(root)).toBe(true);
    await backend.stop();
  });

  it("数据库用绝对路径放在仓库外时，规则仍写进仓库（传的是仓库根）", async () => {
    const { root } = gitRepoWithConfig();
    const outside = mkdtempSync(join(tmpdir(), "bc-be-db-"));
    dirs.push(outside);
    const seen: string[] = [];
    const backend = await startBackend({
      argv: [`--repo=${root}`],
      env: { DEEPSEEK_API_KEY: "sk-t078", BAKACODING_DB_PATH: join(outside, "x.db") },
      cwd: root,
      pricingPath,
      logger: { warn: () => {} },
      ensureIgnored: async (dir) => {
        seen.push(dir);
        return true;
      },
    });
    expect(seen).toEqual([root]);
    await backend.stop();
  });

  it("返回 false 或抛错都不挡启动和渲染就绪；warn 只记 errorDetail，不带错误对象", async () => {
    for (const mode of ["false", "throw"] as const) {
      const { root } = gitRepoWithConfig();
      const logs: Array<[string, unknown]> = [];
      const err = new Error("exclude 不可写");
      err.name = "Evil\nName";
      const backend = await startBackend({
        argv: [`--repo=${root}`],
        env: { DEEPSEEK_API_KEY: "sk-t078" },
        cwd: root,
        pricingPath,
        logger: { warn: (m, d) => logs.push([m, d]) },
        ensureIgnored: async () => {
          if (mode === "throw") throw err;
          return false;
        },
      });
      expect(backend.status().mode).toBe("live");
      expect(backend.markRendererReady()).toEqual([]);
      const mine = logs.filter(([m]) => m.includes(".git/info/exclude"));
      expect(mine).toHaveLength(1);
      expect(mine[0]?.[1]).toBeUndefined();
      if (mode === "throw") {
        expect(mine[0]?.[0]).toContain("exclude 不可写");
        expect(mine[0]?.[0]).not.toContain("\n");
      }
      await backend.stop();
    }
  });
});

describe("T-105：拆后端先 await app.stop() 再关库、放写锁（真实 backend）", () => {
  /**
   * 真实的 startBackend + 真实 openStorage / createDefaultDeps / assemble；只在 onAssembled 里给 App.stop
   * 包一层：先调原来的 stop（真的停 10/8/9），再模拟一个慢的在途收尾——过 30ms 往库里写一条。
   * 修复前 cleanupPartial 不等 stop，这条写入会落到已关的库上。
   */
  function slowWindDown(order: string[], db: string) {
    let st: Storage | undefined;
    const open: typeof openStorage = (o) => {
      const s = openStorage(o);
      st = s;
      const close = s.close.bind(s);
      s.close = () => {
        order.push("close");
        close();
      };
      return s;
    };
    const onAssembled = (app: App) => {
      const orig = app.stop.bind(app);
      app.stop = async () => {
        order.push("stop:begin");
        await orig();
        await new Promise((r) => setTimeout(r, 30));
        // 收尾期间写锁必须还在本进程手里
        const probe = acquireWriterLock(db);
        if ("heldBy" in probe) order.push("lock:held");
        else {
          order.push("lock:released");
          probe.release();
        }
        try {
          st!.saveDecision({ project_id: "p-t105", content: "收尾时写入" });
          order.push("write:ok");
        } catch {
          order.push("write:closed");
        }
        order.push("stop:end");
      };
    };
    return { open, onAssembled };
  }

  it("stop()：等 app.stop() resolve 之后才关库；收尾里的写入落库；重复调用只拆一次", async () => {
    const { root, db } = gitRepoWithConfig();
    const order: string[] = [];
    const { open, onAssembled } = slowWindDown(order, db);
    const backend = await startBackend({
      argv: ["node", "app", `--repo=${root}`],
      env: { DEEPSEEK_API_KEY: "sk-test-live" },
      cwd: root,
      pricingPath,
      logger: { warn: () => {} },
      openStorage: open,
      onAssembled,
    });
    expect(backend.status().mode).toBe("live");
    const p1 = backend.stop();
    const p2 = backend.stop();
    expect(p2).toBe(p1);
    await p1;
    expect(order).toEqual(["stop:begin", "lock:held", "write:ok", "stop:end", "close"]);
    expect(backend.status().mode).toBe("readonly");
    const ro = openStorageReadonly({ path: db, logger: { warn: () => {} } });
    try {
      expect(ro.listDecisions("p-t105").map((d) => d.content)).toEqual(["收尾时写入"]);
    } finally {
      ro.close();
    }
    // 拆完写锁已放：能再拿到
    const again = acquireWriterLock(db);
    expect("heldBy" in again).toBe(false);
    if (!("heldBy" in again)) again.release();
  });

  it("启动中途失败（cleanupPartial）：同样先等 app.stop() 收尾再关库，startBackend 等拆完才返回只读", async () => {
    const { root, db } = gitRepoWithConfig();
    const order: string[] = [];
    const { open, onAssembled } = slowWindDown(order, db);
    const backend = await startBackend({
      argv: ["node", "app", `--repo=${root}`],
      env: { DEEPSEEK_API_KEY: "sk-test-live" },
      cwd: root,
      pricingPath,
      logger: { warn: () => {} },
      openStorage: open,
      onAssembled: (app) => {
        onAssembled(app);
        throw new Error("组装后钩子失败");
      },
    });
    expect(backend.status().mode).toBe("readonly");
    expect(order).toEqual(["stop:begin", "lock:held", "write:ok", "stop:end", "close"]);
    const ro = openStorageReadonly({ path: db, logger: { warn: () => {} } });
    try {
      expect(ro.listDecisions("p-t105")).toHaveLength(1);
    } finally {
      ro.close();
    }
    await backend.stop();
  });
});

/** UI-03：没准备好的仓库（没有提交 / 没有 main / 不是 git 仓库），带好配置 */
function unpreparedRepo(kind: "no_commits" | "no_main" | "not_git"): string {
  const root = mkdtempSync(join(tmpdir(), "bc-ui03-"));
  dirs.push(root);
  if (kind !== "not_git") {
    execFileSync("git", ["init", "-q", "-b", kind === "no_main" ? "master" : "main"], {
      cwd: root,
    });
    execFileSync("git", ["config", "user.email", "t@test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "t"], { cwd: root });
    if (kind === "no_main") {
      writeFileSync(join(root, "README.md"), "x\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-qm", "init"], { cwd: root });
    }
  }
  mkdirSync(join(root, "config"), { recursive: true });
  copyFileSync(examplePath, join(root, "config", "models.json"));
  return root;
}

describe("UI-03：只读原因按 RepoNotReadyError 的 message / 不是 Git 仓库给明确提示", () => {
  const start = (root: string, logs: string[] = []) =>
    startBackend({
      argv: [`--repo=${root}`],
      env: { DEEPSEEK_API_KEY: "sk-ui03-test" },
      cwd: root,
      pricingPath,
      logger: { warn: (m, d) => logs.push(d === undefined ? m : `${m} ${String(d)}`) },
    });

  it("没有提交：横幅原因就是 message，详情带 code no_commits", async () => {
    const root = unpreparedRepo("no_commits");
    const be = await start(root);
    const st = be.status();
    expect(st.mode).toBe("readonly");
    expect(st.reason).toBe("仓库没有任何提交，请先提交一次再启动");
    expect(st.error).toMatchObject({ name: "RepoNotReadyError", code: "no_commits" });
    expect(JSON.stringify(st)).not.toContain(root);
    await be.stop();
  });

  it("没有 main：原因带当前分支名，code no_main", async () => {
    const root = unpreparedRepo("no_main");
    const be = await start(root);
    const st = be.status();
    expect(st.reason).toBe("仓库里没有 main 分支（当前是 master），这一版只支持 main");
    expect(st.error).toMatchObject({ name: "RepoNotReadyError", code: "no_main" });
    await be.stop();
  });

  it("不是 Git 仓库：固定中文提示 + code not_git，git 原始报错不进状态和日志", async () => {
    const root = unpreparedRepo("not_git");
    const logs: string[] = [];
    const be = await start(root, logs);
    const st = be.status();
    expect(st.mode).toBe("readonly");
    expect(st.reason).toBe(NOT_GIT_REASON);
    expect(st.error).toEqual({ name: "Error", message: NOT_GIT_REASON, code: "not_git" });
    const all = JSON.stringify(st) + logs.join("\n");
    expect(all).not.toContain(root);
    expect(all).not.toMatch(/fatal|not a git repository/i);
    await be.stop();
  });

  it("checkRepo 说是仓库（或查不了）时，未知错误照旧只写错误名", async () => {
    const root = unpreparedRepo("not_git");
    for (const checkRepo of [
      async () => ({ items: [{ id: "git", ok: true }] }),
      async () => {
        throw new Error("boom");
      },
    ]) {
      const be = await startBackend({
        argv: [`--repo=${root}`],
        env: { DEEPSEEK_API_KEY: "sk-ui03-test" },
        cwd: root,
        pricingPath,
        logger: { warn: () => {} },
        checkRepo,
      });
      expect(be.status().reason).toBe("启动失败（Error）");
      await be.stop();
    }
  });

  it("readonlyReasonFromError：RepoNotReadyError 的 message 仍过路径 / 密钥脱敏；别的错误不透出 message", () => {
    const e = Object.assign(
      new Error("仓库里没有 main 分支（当前是 /home/u/x），sk-abcdefghijklmnopqrstu"),
      {
        name: "RepoNotReadyError",
        code: "no_main",
      },
    );
    const r = readonlyReasonFromError(e, "/home/u", {
      DEEPSEEK_API_KEY: "sk-abcdefghijklmnopqrstu",
    });
    expect(r).not.toContain("/home/u");
    expect(r).not.toContain("sk-abcdefghijklmnopqrstu");
    // 名字对了但 code 不认识：不当 RepoNotReadyError，只写错误名
    const fake = Object.assign(new Error("/secret/path"), { name: "RepoNotReadyError", code: "x" });
    expect(readonlyReasonFromError(fake)).toBe("启动失败（RepoNotReadyError）");
  });
});

describe("UI-03：日志里的错误与 backendErrorDetail 同一套脱敏", () => {
  const ROOT = "/home/eva/proj";
  const KEY = "sk-ui03logkeyvalue1234567";
  const env = { DEEPSEEK_API_KEY: KEY };

  it("backendLogDetail：仓库根、其他绝对路径、密钥值都换掉；对象也转成字符串", () => {
    const t = backendLogDetail(new Error(`open ${ROOT}/a and /var/lib/b with ${KEY}`), ROOT, env);
    expect(t).toContain("<仓库>/a");
    expect(t).toContain("<路径>");
    expect(t).not.toContain(ROOT);
    expect(t).not.toContain("/var/lib/b");
    expect(t).not.toContain(KEY);
    const o = backendLogDetail({ path: `${ROOT}/x` }, ROOT, env);
    expect(o).not.toContain(ROOT);
  });

  it("sanitizedDepsLogging：logger.warn 和 onError 只写一行脱敏后的字符串，不交原始错误对象", () => {
    const calls: unknown[][] = [];
    const { logger, onError } = sanitizedDepsLogging(
      { warn: (...a: unknown[]) => void calls.push(a) },
      ROOT,
      env,
    );
    onError(new Error(`git failed in ${ROOT} ${KEY}`), "scheduler.sync");
    logger.warn(`清理 ${ROOT}/w 失败`, new Error(`rm ${ROOT}/w`));
    logger.warn("纯文案");
    for (const c of calls) {
      expect(c).toHaveLength(1);
      expect(typeof c[0]).toBe("string");
      expect(String(c[0])).not.toContain(ROOT);
      expect(String(c[0])).not.toContain(KEY);
    }
    expect(String(calls[0]![0])).toContain("scheduler.sync：");
  });

  it("写 exclude 抛错带路径：warn 里只有占位符", async () => {
    const { root } = gitRepoWithConfig();
    const logs: string[] = [];
    const be = await startBackend({
      argv: [`--repo=${root}`],
      env: { DEEPSEEK_API_KEY: "sk-t078" },
      cwd: root,
      pricingPath,
      logger: { warn: (m) => logs.push(m) },
      ensureIgnored: async () => {
        throw new Error(`EACCES: open '${root}/.git/info/exclude'`);
      },
    });
    const mine = logs.filter((m) => m.includes("写 .git/info/exclude 失败"));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain("<仓库>");
    expect(mine[0]).not.toContain(root);
    await be.stop();
  });

  it("pendingHighRisk 抛错：warn 只有一行脱敏字符串", async () => {
    const { root } = gitRepoWithConfig();
    const calls: unknown[][] = [];
    const be = await startBackend({
      argv: [`--repo=${root}`],
      env: { DEEPSEEK_API_KEY: "sk-t078" },
      cwd: root,
      pricingPath,
      logger: { warn: (...a: unknown[]) => void calls.push(a) },
      onAssembled: (app) => {
        app.supervisor.pendingHighRisk = () => {
          throw new Error(`read ${root}/.bakacoding/x failed`);
        };
      },
    });
    expect(be.pendingHighRisk()).toEqual([]);
    const mine = calls.filter((c) => String(c[0]).startsWith("pendingHighRisk 失败"));
    expect(mine.length).toBeGreaterThan(0);
    for (const c of mine) {
      expect(c).toHaveLength(1);
      expect(String(c[0])).not.toContain(root);
    }
    await be.stop();
  });
});
