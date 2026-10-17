import { realpathSync } from "node:fs";
import { resolve } from "node:path";

// ---------- 进程内 git 写锁（T-094） ----------

const gitWriteLocks = new Map<string, Promise<unknown>>();

function lockKey(repoRoot: string): string {
  const abs = resolve(repoRoot);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/**
 * 同一仓库的 git 写操作在本进程内串行（T-094）：建 / 删 worktree、删分支，以及 T-086 的
 * initRepo / initialCommit / createMainBranch 都应包在里面，避免同时抢 `index.lock`、`packed-refs.lock`
 * 和 `.git/worktrees/`。按仓库真实路径分锁，不同仓库互不等待；fn 抛错不影响后面的人拿锁。
 * 不可重入：fn 里不要再对同一仓库调 withGitWriteLock，否则会死锁。
 */
export function withGitWriteLock<T>(repoRoot: string, fn: () => Promise<T> | T): Promise<T> {
  const key = lockKey(repoRoot);
  const prev = gitWriteLocks.get(key) ?? Promise.resolve();
  const next = prev.then(() => fn());
  const tail = next.catch(() => undefined);
  gitWriteLocks.set(key, tail);
  void tail.then(() => {
    if (gitWriteLocks.get(key) === tail) gitWriteLocks.delete(key);
  });
  return next;
}
