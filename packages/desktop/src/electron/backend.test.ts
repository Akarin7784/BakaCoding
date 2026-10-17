import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStorageReadonly, StorageLeaseError } from "@bakacoding/storage";
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
  execFileSync("git", ["init"], { cwd: root });
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
    const ro = openStorageReadonly({ path: db, logger: { warn: () => {} } });
    expect(typeof ro.maxSeq()).toBe("object"); // null | number
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
    expect(logs.join("\n")).not.toContain(secret);
    await backend.stop();
  });
});
