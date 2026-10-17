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
import { openStorage, openStorageReadonly, StorageLeaseError } from "@bakacoding/storage";
import { afterEach, describe, expect, it } from "vitest";
import {
  NotifyBuffer,
  resolveConfigPath,
  resolveRepoDbPath,
  resolveRepoPath,
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
