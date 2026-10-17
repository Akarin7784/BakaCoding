// T-063：写入锁。锁文件 `<库所在目录>/writer.lock`，用 wx 创建，避免两个主进程同时拿写入连接。
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";

export const WRITER_LOCK_FILENAME = "writer.lock";

export interface WriterLockPayload {
  pid: number;
  hostname: string;
  /** ISO 8601 UTC */
  started_at: string;
  /** 释放时校验，避免误删别人的锁 */
  token: string;
}

export type WriterLock = { release(): void } | { heldBy: number };

function lockPathFor(dbPath: string): string {
  return join(dirname(dbPath), WRITER_LOCK_FILENAME);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM：进程在、但当前用户没权发信号 → 仍算活着
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPayload(lockPath: string): WriterLockPayload | undefined {
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<WriterLockPayload>;
    if (
      typeof raw.pid !== "number" ||
      typeof raw.hostname !== "string" ||
      typeof raw.started_at !== "string" ||
      typeof raw.token !== "string"
    ) {
      return undefined;
    }
    return raw as WriterLockPayload;
  } catch {
    return undefined;
  }
}

function makeRelease(lockPath: string, token: string): { release(): void } {
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      const cur = readPayload(lockPath);
      if (!cur || cur.token !== token) return;
      try {
        unlinkSync(lockPath);
      } catch {
        // 已不在或被别人接管：忽略
      }
    },
  };
}

/**
 * 拿写入锁。成功返回 `{ release }`；已被占用返回 `{ heldBy: pid }`（调用方退回只读）。
 *
 * - 锁文件：`<db 所在目录>/writer.lock`，内容为 JSON：`pid` / `hostname` / `started_at` / `token`
 * - 用 `wx` 创建，已存在时检查：不同主机名绝不接管；同机且 `kill(pid,0)` 失败（非 EPERM）视为陈旧，删掉后重试一次 wx
 * - `release()` 只在文件里的 token 与自己一致时删除
 */
export function acquireWriterLock(dbPath: string): WriterLock {
  const lockPath = lockPathFor(dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const token = randomBytes(16).toString("hex");
  const payload: WriterLockPayload = {
    pid: process.pid,
    hostname: osHostname(),
    started_at: new Date().toISOString(),
    token,
  };
  const body = `${JSON.stringify(payload)}\n`;

  const tryCreate = (): boolean => {
    try {
      writeFileSync(lockPath, body, { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  };

  if (tryCreate()) return makeRelease(lockPath, token);

  const existing = readPayload(lockPath);
  if (!existing) {
    // 损坏或空文件：试一次接管
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
    if (tryCreate()) return makeRelease(lockPath, token);
    const again = readPayload(lockPath);
    return { heldBy: again?.pid ?? -1 };
  }

  // 不同主机：pid 无法核实，绝不接管
  if (existing.hostname !== osHostname()) {
    return { heldBy: existing.pid };
  }

  if (isProcessAlive(existing.pid)) {
    return { heldBy: existing.pid };
  }

  // 陈旧锁：删掉再 wx 一次；两个进程同时接管时只有一个能赢
  try {
    unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
  if (tryCreate()) return makeRelease(lockPath, token);
  const again = readPayload(lockPath);
  return { heldBy: again?.pid ?? -1 };
}
