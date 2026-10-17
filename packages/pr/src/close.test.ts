import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertPrRecord,
  CommitPatchError,
  InMemoryPrStore,
  InvalidPrRecordFieldError,
  LocalPrProvider,
  NoChangesError,
  PrAlreadyMergedError,
  WorktreeMismatchError,
  type PrRecord,
} from "./index.js";
import { git } from "./git.js";

const ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
let root: string;
let repo: string;
let store: InMemoryPrStore;
let pr: LocalPrProvider;

async function worktree(branch: string) {
  const p = join(root, `wt-${branch.replace(/\//g, "-")}`);
  await git(repo, ["worktree", "add", "-q", "-b", branch, p, "main"]);
  return p;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bc-pr-close-test-"));
  repo = join(root, "repo");
  await git(root, ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "a.txt"), "1\n2\n3\n");
  await writeFile(join(repo, "gone.txt"), "x\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "init"], { env: ENV });
  store = new InMemoryPrStore();
  pr = new LocalPrProvider({ store, repo, author: { name: "t", email: "t@t" } });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("commitWorktree", () => {
  it("提交 worktree 里的全部改动（修改、新增、删除），返回新 HEAD，diff 能看到", async () => {
    const wt = await worktree("feat/w1");
    const id = await pr.open("T-1", wt, "feat/w1");
    await writeFile(join(wt, "a.txt"), "1\nTWO\n3\n");
    await writeFile(join(wt, "new.txt"), "n\n");
    await rm(join(wt, "gone.txt"));
    const sha = await pr.commitWorktree("T-1", wt);
    expect(sha).toBe((await git(wt, ["rev-parse", "HEAD"])).stdout.trim());
    expect((await git(wt, ["status", "--porcelain"])).stdout).toBe("");
    expect((await git(wt, ["log", "-1", "--format=%s"])).stdout.trim()).toBe(
      "T-1: apply worktree changes",
    );
    const files = Object.fromEntries((await pr.diff(id)).files.map((f) => [f.path, f.status]));
    expect(files).toEqual({ "a.txt": "modified", "new.txt": "added", "gone.txt": "deleted" });
  });

  it("没有改动：抛 NoChangesError，不产生空提交", async () => {
    const wt = await worktree("feat/w2");
    await pr.open("T-2", wt, "feat/w2");
    const before = (await git(wt, ["rev-parse", "HEAD"])).stdout;
    await expect(pr.commitWorktree("T-2", wt)).rejects.toBeInstanceOf(NoChangesError);
    expect((await git(wt, ["rev-parse", "HEAD"])).stdout).toBe(before);
  });

  it("没有对应记录、单号不对、分支不对、记录已结束：抛 WorktreeMismatchError", async () => {
    const wt = await worktree("feat/w3");
    await writeFile(join(wt, "x.txt"), "x\n");
    await expect(pr.commitWorktree("T-3", wt)).rejects.toBeInstanceOf(WorktreeMismatchError);
    const id = await pr.open("T-3", wt, "feat/w3");
    await expect(pr.commitWorktree("T-999", wt)).rejects.toBeInstanceOf(WorktreeMismatchError);
    await git(wt, ["checkout", "-q", "-b", "other"]);
    await expect(pr.commitWorktree("T-3", wt)).rejects.toThrow(/other/);
    await git(wt, ["checkout", "-q", "feat/w3"]);
    await pr.close(id, "取消");
    await expect(pr.commitWorktree("T-3", wt)).rejects.toBeInstanceOf(WorktreeMismatchError);
  });

  it("hook 拒绝：抛错带 hook 输出，不提交，暂存撤回、文件保留", async () => {
    const wt = await worktree("feat/w4");
    await pr.open("T-4", wt, "feat/w4");
    const hook = join(repo, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\necho HOOK_NO >&2\nexit 1\n");
    await chmod(hook, 0o755);
    await writeFile(join(wt, "new.txt"), "n\n");
    const before = (await git(wt, ["rev-parse", "HEAD"])).stdout;
    await expect(pr.commitWorktree("T-4", wt)).rejects.toThrow(/HOOK_NO/);
    await expect(pr.commitWorktree("T-4", wt)).rejects.toBeInstanceOf(CommitPatchError);
    expect((await git(wt, ["rev-parse", "HEAD"])).stdout).toBe(before);
    expect((await git(wt, ["diff", "--cached", "--name-only"])).stdout).toBe("");
    expect(await readFile(join(wt, "new.txt"), "utf8")).toBe("n\n");
  });
});

describe("close（本地）", () => {
  it("标 closed，写 closed_by / close_reason；重复调用幂等", async () => {
    const wt = await worktree("feat/c1");
    const id = await pr.open("T-5", wt, "feat/c1");
    await pr.close(id, "需求取消");
    const rec = await store.get(id);
    expect(rec).toMatchObject({
      status: "closed",
      closed_by: "bakacoding",
      close_reason: "需求取消",
    });
    await pr.close(id, "另一个原因");
    expect(await store.get(id)).toEqual(rec);
    await expect(pr.merge(id, "main")).rejects.toThrow(/关闭/);
  });

  it("集成记录也能 close；之后 openIntegration 新建一条", async () => {
    const id = await pr.openIntegration();
    await pr.close(id, "重建集成分支");
    expect(await store.get(id)).toMatchObject({ kind: "integration", status: "closed" });
    expect(await pr.openIntegration()).not.toBe(id);
  });

  it("已 merged 的记录不能 close", async () => {
    const wt = await worktree("feat/c2");
    await writeFile(join(wt, "f.txt"), "f\n");
    const id = await pr.open("T-6", wt, "feat/c2");
    await pr.commitWorktree("T-6", wt);
    await pr.merge(id, "main");
    await expect(pr.close(id, "x")).rejects.toBeInstanceOf(PrAlreadyMergedError);
    expect((await store.get(id))?.status).toBe("merged");
  });
});

describe("assertPrRecord 可选字段", () => {
  const base = {
    pr_id: "p",
    kind: "integration",
    repo_path: "/r",
    branch: "b",
    base_branch: "main",
    base_sha: "x",
    head_sha: "y",
    status: "closed",
    created_ts: "t",
    updated_ts: "t",
  };
  it("closed_by 只能是 bakacoding，close_reason 只能是字符串", () => {
    expect(() =>
      assertPrRecord({ ...base, closed_by: "bakacoding", close_reason: "r" } as PrRecord),
    ).not.toThrow();
    expect(() => assertPrRecord({ ...base, closed_by: "user" } as unknown as PrRecord)).toThrow(
      InvalidPrRecordFieldError,
    );
    expect(() => assertPrRecord({ ...base, close_reason: 1 } as unknown as PrRecord)).toThrow(
      InvalidPrRecordFieldError,
    );
  });
});
