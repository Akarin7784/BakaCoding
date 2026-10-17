import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireWriterLock, WRITER_LOCK_FILENAME, type WriterLockPayload } from "./writer-lock.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmpDb(): string {
  const root = mkdtempSync(join(tmpdir(), "bc-wlock-"));
  dirs.push(root);
  const dir = join(root, ".bakacoding");
  mkdirSync(dir, { recursive: true });
  return join(dir, "bakacoding.db");
}

function lockPath(db: string): string {
  return join(dirname(db), WRITER_LOCK_FILENAME);
}

/** 选一个当前几乎肯定不存在的 pid；若碰巧活着则返回 undefined。 */
function deadPid(candidate: number): number | undefined {
  try {
    process.kill(candidate, 0);
    return undefined; // 活着或 EPERM
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") return undefined;
    return candidate;
  }
}

describe("acquireWriterLock（T-063）", () => {
  it("单个进程拿到锁；release 后别人能再拿", () => {
    const db = tmpDb();
    const a = acquireWriterLock(db);
    expect("release" in a).toBe(true);
    if (!("release" in a)) return;
    const raw = JSON.parse(readFileSync(lockPath(db), "utf8")) as WriterLockPayload;
    expect(raw.pid).toBe(process.pid);
    expect(raw.token.length).toBeGreaterThan(8);
    expect(raw.hostname.length).toBeGreaterThan(0);

    expect(acquireWriterLock(db)).toEqual({ heldBy: process.pid });

    a.release();
    const b = acquireWriterLock(db);
    expect("release" in b).toBe(true);
    if ("release" in b) b.release();
  });

  it("活着的进程占着锁 → 返回 heldBy，不接管", () => {
    const db = tmpDb();
    const a = acquireWriterLock(db);
    expect("release" in a).toBe(true);
    expect(acquireWriterLock(db)).toEqual({ heldBy: process.pid });
    if ("release" in a) a.release();
  });

  it("陈旧锁（同主机、pid 已死）会被接管", () => {
    const pid = deadPid(2_147_483_647);
    if (pid === undefined) return;
    const db = tmpDb();
    writeFileSync(
      lockPath(db),
      `${JSON.stringify({
        pid,
        hostname: hostname(),
        started_at: new Date(0).toISOString(),
        token: "stale-token",
      })}\n`,
    );
    const lock = acquireWriterLock(db);
    expect("release" in lock).toBe(true);
    if (!("release" in lock)) return;
    const raw = JSON.parse(readFileSync(lockPath(db), "utf8")) as WriterLockPayload;
    expect(raw.pid).toBe(process.pid);
    expect(raw.token).not.toBe("stale-token");
    lock.release();
  });

  it("两个进程同时接管陈旧锁，只有一个赢", () => {
    const pid = deadPid(2_147_483_646);
    if (pid === undefined) return;
    const db = tmpDb();
    writeFileSync(
      lockPath(db),
      `${JSON.stringify({
        pid,
        hostname: hostname(),
        started_at: new Date(0).toISOString(),
        token: "race-stale",
      })}\n`,
    );
    const a = acquireWriterLock(db);
    const b = acquireWriterLock(db);
    const winners = [a, b].filter((x) => "release" in x);
    const losers = [a, b].filter((x) => "heldBy" in x);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    if ("release" in winners[0]!) winners[0].release();
  });

  it("release 只删自己的 token；别人的锁不动", () => {
    const db = tmpDb();
    const a = acquireWriterLock(db);
    expect("release" in a).toBe(true);
    if (!("release" in a)) return;
    writeFileSync(
      lockPath(db),
      `${JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        started_at: new Date().toISOString(),
        token: "other-token",
      })}\n`,
    );
    a.release();
    expect(readFileSync(lockPath(db), "utf8")).toContain("other-token");
  });

  it("不同主机名的锁绝不接管", () => {
    const db = tmpDb();
    writeFileSync(
      lockPath(db),
      `${JSON.stringify({
        pid: 1,
        hostname: "other-host-never-local",
        started_at: new Date(0).toISOString(),
        token: "remote",
      })}\n`,
    );
    expect(acquireWriterLock(db)).toEqual({ heldBy: 1 });
  });
});
