import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryPrStore, INTEGRATION_BRANCH, LocalPrProvider, type PrRecord } from "./index.js";
import { git } from "./git.js";

// T-103：merge 写完 target、记 merged 之前中断，重启后重合要幂等：不再产生提交、target 不动、记 merged。

const ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
let root: string;
let repo: string;
let store: CrashingStore;

/** 记 merged 时抛一次错，模拟「target 已写、merged 没记」时进程中断。 */
class CrashingStore extends InMemoryPrStore {
  crashOnMerged = false;
  override put(record: PrRecord): Promise<void> {
    if (this.crashOnMerged && record.status === "merged") {
      this.crashOnMerged = false;
      return Promise.reject(new Error("模拟中断"));
    }
    return super.put(record);
  }
}

const provider = () => new LocalPrProvider({ store, repo, author: { name: "t", email: "t@t" } });
const rev = async (r: string) => (await git(repo, ["rev-parse", r])).stdout.trim();
const count = async () => Number((await git(repo, ["rev-list", "--all", "--count"])).stdout.trim());

async function commitAll(cwd: string, msg: string) {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", msg], { env: ENV });
}
async function ticket(id: string, base: string) {
  const branch = `feat/${id}`;
  const wt = join(root, `wt-${id}`);
  await git(repo, ["worktree", "add", "-q", "-b", branch, wt, base]);
  await writeFile(join(wt, `${id}.txt`), `${id}\n`);
  await commitAll(wt, id);
  return { wt, branch, head: await rev(branch) };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bc-pr-idem-test-"));
  repo = join(root, "repo");
  await git(root, ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "a.txt"), "1\n");
  await commitAll(repo, "init");
  store = new CrashingStore();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("本地 merge 重试幂等（T-103）", () => {
  it("非快进：已写 target 未记 merged，重启后重合不产生新提交、target 不变、记 merged", async () => {
    const p1 = provider();
    await p1.openIntegration();
    const t = await ticket("T-1", INTEGRATION_BRANCH);
    const id = await p1.open("T-1", t.wt, t.branch);
    // 让 target 前进一步，合入必须是非快进
    const other = await ticket("T-0", "main");
    await git(repo, ["update-ref", `refs/heads/${INTEGRATION_BRANCH}`, other.head]);

    store.crashOnMerged = true;
    await expect(p1.merge(id, INTEGRATION_BRANCH)).rejects.toThrow("模拟中断");
    const landed = await rev(INTEGRATION_BRANCH);
    expect(landed).not.toBe(t.head);
    expect((await store.get(id))?.status).toBe("open");
    const n = await count();

    const r = await provider().merge(id, INTEGRATION_BRANCH);
    expect(r).toEqual({ merged: true, sha: landed, fast_forward: false });
    expect(await rev(INTEGRATION_BRANCH)).toBe(landed);
    expect(await count()).toBe(n);
    expect(await store.get(id)).toMatchObject({
      status: "merged",
      merged_into: INTEGRATION_BRANCH,
      merge_sha: landed,
      head_sha: t.head,
    });
    // merge_sha 与正常路径同义：第一父是合入前的 target，第二父是本单 head
    expect(await rev(`${landed}^1`)).toBe(other.head);
    expect(await rev(`${landed}^2`)).toBe(t.head);
  });

  it("非快进中断后又有别的单合入：重试记的 merge_sha 是当时那个合并提交，不是 target 最新提交", async () => {
    const p1 = provider();
    await p1.openIntegration();
    const t1 = await ticket("T-1", INTEGRATION_BRANCH);
    const t2 = await ticket("T-2", INTEGRATION_BRANCH);
    const id1 = await p1.open("T-1", t1.wt, t1.branch);
    const id2 = await p1.open("T-2", t2.wt, t2.branch);
    const other = await ticket("T-0", "main");
    await git(repo, ["update-ref", `refs/heads/${INTEGRATION_BRANCH}`, other.head]);

    store.crashOnMerged = true;
    await expect(p1.merge(id1, INTEGRATION_BRANCH)).rejects.toThrow("模拟中断");
    const m1 = await rev(INTEGRATION_BRANCH);
    const p2 = provider();
    expect(await p2.merge(id2, INTEGRATION_BRANCH)).toMatchObject({ merged: true });
    const tip = await rev(INTEGRATION_BRANCH);
    const n = await count();

    expect(await p2.merge(id1, INTEGRATION_BRANCH)).toEqual({
      merged: true,
      sha: m1,
      fast_forward: false,
    });
    expect(await rev(INTEGRATION_BRANCH)).toBe(tip);
    expect(await count()).toBe(n);
    expect(await store.get(id1)).toMatchObject({ status: "merged", merge_sha: m1 });
  });

  it("快进（target 在 worktree 里 checkout）：重试不产生新提交、target 不变、记 merged，merge_sha 是 head", async () => {
    const p1 = provider();
    const t = await ticket("T-3", "main");
    const id = await p1.open("T-3", t.wt, t.branch);

    store.crashOnMerged = true;
    await expect(p1.merge(id, "main")).rejects.toThrow("模拟中断");
    expect(await rev("main")).toBe(t.head);
    const n = await count();

    const r = await provider().merge(id, "main");
    expect(r).toEqual({ merged: true, sha: t.head, fast_forward: true });
    expect(await rev("main")).toBe(t.head);
    expect(await count()).toBe(n);
    expect(await store.get(id)).toMatchObject({
      status: "merged",
      merged_into: "main",
      merge_sha: t.head,
    });
    expect((await git(repo, ["status", "--porcelain"])).stdout).toBe("");
  });
});
