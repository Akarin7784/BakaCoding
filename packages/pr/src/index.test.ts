import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrStatusSchema } from "@bakacoding/types";
import { chmod } from "node:fs/promises";
import {
  createPrProvider,
  ExpectedHeadMismatchError,
  InMemoryPrStore,
  LocalPrProvider,
  PrNotFoundError,
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

async function commitAll(cwd: string, msg: string) {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", msg], { env: ENV });
}
async function worktree(branch: string) {
  const p = join(root, `wt-${branch}`);
  await git(repo, ["worktree", "add", "-q", "-b", branch, p, "main"]);
  return p;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bc-pr-test-"));
  repo = join(root, "repo");
  await git(root, ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "a.txt"), "1\n2\n3\n");
  await writeFile(join(repo, "old.txt"), "line1\nline2\nline3\nline4\nline5\n");
  await writeFile(join(repo, "gone.txt"), "x\ny\n");
  await commitAll(repo, "init");
  store = new InMemoryPrStore();
  pr = new LocalPrProvider({ store, author: { name: "t", email: "t@t" } });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("PrStatus", () => {
  it("四个取值", () => {
    expect(PrStatusSchema.options).toEqual(["open", "merged", "conflict", "closed"]);
    expect(PrStatusSchema.safeParse("queued").success).toBe(false);
  });
});

describe("commitPatch", () => {
  it("apply + commit，返回新 HEAD", async () => {
    const wt = await worktree("feat/a");
    const patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n 1\n-2\n+two\n 3\n";
    const sha = await pr.commitPatch("T-1", wt, patch);
    expect((await git(wt, ["rev-parse", "HEAD"])).stdout.trim()).toBe(sha);
    expect(await readFile(join(wt, "a.txt"), "utf8")).toBe("1\ntwo\n3\n");
    expect((await git(wt, ["log", "-1", "--format=%s"])).stdout.trim()).toBe("T-1: apply patch");
  });
  it("补丁打不上时抛错且不提交", async () => {
    const wt = await worktree("feat/bad");
    const before = (await git(wt, ["rev-parse", "HEAD"])).stdout;
    await expect(
      pr.commitPatch("T-1", wt, "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-nope\n+x\n"),
    ).rejects.toThrow();
    expect((await git(wt, ["rev-parse", "HEAD"])).stdout).toBe(before);
  });
});

describe("open / diff", () => {
  it("记录 base/head，diff 覆盖增删改与重命名", async () => {
    const wt = await worktree("feat/d");
    await writeFile(join(wt, "a.txt"), "1\nTWO\n3\n4\n");
    await writeFile(join(wt, "new.txt"), "n1\nn2\n");
    await rm(join(wt, "gone.txt"));
    await git(wt, ["mv", "old.txt", "renamed.txt"]);
    await commitAll(wt, "change");
    const id = await pr.open("T-2", wt, "feat/d");
    const rec = await store.get(id);
    expect(rec?.status).toBe("open");
    const d = await pr.diff(id);
    expect(d.base_sha).toBe((await git(repo, ["rev-parse", "main"])).stdout.trim());
    const by = Object.fromEntries(d.files.map((f) => [f.path, f]));
    expect(by["a.txt"]).toMatchObject({ status: "modified", additions: 2, deletions: 1 });
    expect(by["new.txt"]).toMatchObject({ status: "added", additions: 2, deletions: 0 });
    expect(by["gone.txt"]).toMatchObject({ status: "deleted", additions: 0, deletions: 2 });
    expect(by["renamed.txt"]).toMatchObject({
      status: "renamed",
      additions: 0,
      deletions: 0,
      old_path: "old.txt",
    });
    expect(by["renamed.txt"]!.patch).toContain("rename from old.txt");
    expect(by["a.txt"]!.patch).toContain("+TWO");
    expect(by["a.txt"]).not.toHaveProperty("old_path");
    expect(by["new.txt"]).not.toHaveProperty("old_path");
    expect(by["gone.txt"]).not.toHaveProperty("old_path");
  });
  it("T-121：改过的源文件复制出的新文件按 added + old_path 报，patch 只含复制块", async () => {
    const wt = await worktree("feat/copy");
    const original = await readFile(join(repo, "a.txt"), "utf8");
    await writeFile(join(wt, "a.txt"), "1\nTWO\n3\n");
    await writeFile(join(wt, "a-copy.txt"), original);
    await commitAll(wt, "copy");
    const id = await pr.open("T-copy", wt, "feat/copy");
    const d = await pr.diff(id);
    const by = Object.fromEntries(d.files.map((f) => [f.path, f]));
    expect(by["a-copy.txt"]).toMatchObject({
      path: "a-copy.txt",
      status: "added",
      additions: 0,
      deletions: 0,
      old_path: "a.txt",
    });
    expect(by["a-copy.txt"]!.patch).toContain("copy from a.txt");
    expect(by["a-copy.txt"]!.patch).toContain("copy to a-copy.txt");
    // 源文件的改动块不能混进复制文件的 patch
    expect(by["a-copy.txt"]!.patch).not.toContain("+TWO");
    expect(by["a.txt"]).toMatchObject({ status: "modified", additions: 1, deletions: 1 });
    expect(by["a.txt"]!.patch).toContain("+TWO");
    expect(by["a.txt"]).not.toHaveProperty("old_path");
  });
  it("T-121：部分复制（复制块带 hunk）也带 old_path，patch 只含复制块、不含源文件改动", async () => {
    const wt = await worktree("feat/copy-partial");
    const lines = (await readFile(join(repo, "old.txt"), "utf8")).split("\n");
    await writeFile(
      join(wt, "old.txt"),
      lines.map((l) => (l === "line1" ? "line1-changed" : l)).join("\n"),
    );
    await writeFile(
      join(wt, "old-partial.txt"),
      lines.map((l) => (l === "line5" ? "line5-changed" : l)).join("\n"),
    );
    await commitAll(wt, "partial copy");
    const id = await pr.open("T-copy3", wt, "feat/copy-partial");
    const d = await pr.diff(id);
    const by = Object.fromEntries(d.files.map((f) => [f.path, f]));
    expect(by["old-partial.txt"]).toMatchObject({
      path: "old-partial.txt",
      status: "added",
      additions: 1,
      deletions: 1,
      old_path: "old.txt",
    });
    expect(by["old-partial.txt"]!.patch).toContain("copy from old.txt");
    expect(by["old-partial.txt"]!.patch).toContain("+line5-changed");
    // 源文件的改动块不能混进复制文件的 patch
    expect(by["old-partial.txt"]!.patch).not.toContain("+line1-changed");
    expect(by["old.txt"]).toMatchObject({ status: "modified", additions: 1, deletions: 1 });
  });
  it("T-121：源文件没改动时复制不检出（不加 --find-copies-harder），仍按 added 报、不带 old_path", async () => {
    const wt = await worktree("feat/copy-harder");
    await writeFile(join(wt, "old-copy.txt"), await readFile(join(repo, "old.txt"), "utf8"));
    await commitAll(wt, "copy unmodified");
    const id = await pr.open("T-copy2", wt, "feat/copy-harder");
    const by = Object.fromEntries((await pr.diff(id)).files.map((f) => [f.path, f]));
    expect(by["old-copy.txt"]).toMatchObject({
      path: "old-copy.txt",
      status: "added",
      additions: 5,
      deletions: 0,
    });
    expect(by["old-copy.txt"]).not.toHaveProperty("old_path");
  });
  it("T-131：中文文件名的复制也按 added + old_path 报，patch 只含复制块（header 被 git 转义）", async () => {
    // 源和目标都带中文：git header 里两段 path 都会写成八进制转义
    await writeFile(join(repo, "中文源.txt"), "1\n2\n3\n");
    await commitAll(repo, "add 中文源");
    const wt = await worktree("feat/copy-cn");
    await writeFile(join(wt, "中文源.txt"), "1\nTWO\n3\n");
    await writeFile(join(wt, "中文副本.txt"), "1\n2\n3\n");
    await commitAll(wt, "copy cn");
    const id = await pr.open("T-copy-cn", wt, "feat/copy-cn");
    const d = await pr.diff(id);
    const by = Object.fromEntries(d.files.map((f) => [f.path, f]));
    expect(by["中文副本.txt"]).toMatchObject({
      path: "中文副本.txt",
      status: "added",
      additions: 0,
      deletions: 0,
      old_path: "中文源.txt",
    });
    expect(by["中文副本.txt"]!.patch).toContain("copy from");
    expect(by["中文副本.txt"]!.patch).not.toContain("+TWO");
    expect(by["中文源.txt"]).toMatchObject({ status: "modified" });
  });
  it("T-131：目标文件名带空格（header 不转义）的复制同样只留复制块", async () => {
    const wt = await worktree("feat/copy-space");
    const original = await readFile(join(repo, "a.txt"), "utf8");
    await writeFile(join(wt, "a.txt"), "1\nTWO\n3\n");
    await writeFile(join(wt, "copy a b.txt"), original);
    await commitAll(wt, "copy space");
    const id = await pr.open("T-copy-space", wt, "feat/copy-space");
    const d = await pr.diff(id);
    const by = Object.fromEntries(d.files.map((f) => [f.path, f]));
    expect(by["copy a b.txt"]).toMatchObject({
      path: "copy a b.txt",
      status: "added",
      old_path: "a.txt",
    });
    expect(by["copy a b.txt"]!.patch).toContain("copy from a.txt");
    expect(by["copy a b.txt"]!.patch).not.toContain("+TWO");
  });
  it("package.json 改名成 x.json 时带 old_path", async () => {
    // package.json 必须先在 base（main）上，相对 base 的 rename 才会被 -M 检出
    await writeFile(join(repo, "package.json"), '{\n  "name": "demo"\n}\n');
    await commitAll(repo, "add package.json");
    const wt = await worktree("feat/pkg-rename");
    await git(wt, ["mv", "package.json", "x.json"]);
    await commitAll(wt, "rename package.json");
    const id = await pr.open("T-pkg", wt, "feat/pkg-rename");
    const d = await pr.diff(id);
    const by = Object.fromEntries(d.files.map((f) => [f.path, f]));
    expect(by["x.json"]).toMatchObject({
      path: "x.json",
      status: "renamed",
      old_path: "package.json",
    });
    expect(by["package.json"]).toBeUndefined();
  });
  it("删掉 package.json 时 path 就是原路径，不带 old_path", async () => {
    await writeFile(join(repo, "package.json"), '{\n  "name": "demo"\n}\n');
    await commitAll(repo, "add package.json");
    const wt = await worktree("feat/pkg-delete");
    await git(wt, ["rm", "package.json"]);
    await commitAll(wt, "delete package.json");
    const id = await pr.open("T-pkg-del", wt, "feat/pkg-delete");
    const d = await pr.diff(id);
    const by = Object.fromEntries(d.files.map((f) => [f.path, f]));
    expect(by["package.json"]).toMatchObject({ path: "package.json", status: "deleted" });
    expect(by["package.json"]).not.toHaveProperty("old_path");
  });
  it("未知 pr_id 抛 PrNotFoundError；checks 为空；sync 无操作", async () => {
    await expect(pr.diff("nope")).rejects.toBeInstanceOf(PrNotFoundError);
    const wt = await worktree("feat/c");
    const id = await pr.open("T-3", wt, "feat/c");
    expect(await pr.checks(id)).toEqual([]);
    await expect(pr.sync()).resolves.toEqual([]);
  });
});

describe("merge", () => {
  it("fast-forward", async () => {
    const wt = await worktree("feat/ff");
    await writeFile(join(wt, "f.txt"), "f\n");
    await commitAll(wt, "f");
    const head = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
    const id = await pr.open("T-4", wt, "feat/ff");
    const r = await pr.merge(id, "main");
    expect(r).toEqual({ merged: true, sha: head, fast_forward: true });
    expect((await git(repo, ["rev-parse", "main"])).stdout.trim()).toBe(head);
    expect((await store.get(id))?.status).toBe("merged");
    await expect(pr.merge(id, "main")).rejects.toThrow();
  });
  it("非 FF 生成合并提交", async () => {
    const wt1 = await worktree("feat/x");
    const wt2 = await worktree("feat/y");
    await writeFile(join(wt1, "x.txt"), "x\n");
    await commitAll(wt1, "x");
    await writeFile(join(wt2, "y.txt"), "y\n");
    await commitAll(wt2, "y");
    await pr.merge(await pr.open("T-5", wt1, "feat/x"), "main");
    const r = await pr.merge(await pr.open("T-6", wt2, "feat/y"), "main");
    expect(r).toMatchObject({ merged: true, fast_forward: false });
    const files = (await git(repo, ["ls-tree", "--name-only", "main"])).stdout;
    expect(files).toContain("x.txt");
    expect(files).toContain("y.txt");
    const parents = (await git(repo, ["rev-list", "--parents", "-n1", "main"])).stdout.split(" ");
    expect(parents).toHaveLength(3);
  });
  it("冲突返回 conflict，不动 target", async () => {
    const wt1 = await worktree("feat/p");
    const wt2 = await worktree("feat/q");
    await writeFile(join(wt1, "a.txt"), "1\nP\n3\n");
    await commitAll(wt1, "p");
    await writeFile(join(wt2, "a.txt"), "1\nQ\n3\n");
    await commitAll(wt2, "q");
    await pr.merge(await pr.open("T-7", wt1, "feat/p"), "main");
    const before = (await git(repo, ["rev-parse", "main"])).stdout;
    const id = await pr.open("T-8", wt2, "feat/q");
    const r = await pr.merge(id, "main");
    expect(r).toEqual({ merged: false, conflict: true, conflicted_files: ["a.txt"] });
    expect((await git(repo, ["rev-parse", "main"])).stdout).toBe(before);
    expect((await store.get(id))?.status).toBe("conflict");
  });
});

describe("merge 落到 target 的三种情况", () => {
  async function ffPr(branch: string, ticket: string) {
    const wt = await worktree(branch);
    await writeFile(join(wt, `${ticket}.txt`), "z\n");
    await commitAll(wt, ticket);
    return { wt, id: await pr.open(ticket, wt, branch) };
  }
  it("checkout 且干净：在该 worktree ff-only，工作目录同步更新", async () => {
    const { id } = await ffPr("feat/clean", "T-9");
    const r = await pr.merge(id, "main");
    expect(r).toMatchObject({ merged: true });
    expect(await readFile(join(repo, "T-9.txt"), "utf8")).toBe("z\n");
    expect((await git(repo, ["status", "--porcelain"])).stdout).toBe("");
  });
  it("checkout 且有未提交改动：返回 target_dirty，状态不变", async () => {
    const { id } = await ffPr("feat/dirty", "T-10");
    await writeFile(join(repo, "a.txt"), "dirty\n");
    const before = (await git(repo, ["rev-parse", "main"])).stdout;
    const r = await pr.merge(id, "main");
    expect(r).toMatchObject({ merged: false, conflict: false, reason: "target_dirty" });
    expect((await git(repo, ["rev-parse", "main"])).stdout).toBe(before);
    expect((await store.get(id))?.status).toBe("open");
  });
  it("checkout 且干净但 ff 会覆盖未跟踪文件：返回 target_dirty，状态不变", async () => {
    const { id } = await ffPr("feat/untracked", "T-13");
    await writeFile(join(repo, "T-13.txt"), "local untracked\n");
    const before = (await git(repo, ["rev-parse", "main"])).stdout;
    const r = await pr.merge(id, "main");
    expect(r).toMatchObject({ merged: false, conflict: false, reason: "target_dirty" });
    // T-134：worktree_path 来自 `git worktree list --porcelain`，Windows 上是正斜杠、POSIX 是原生路径，
    // 生产按原样回传（不改生产代码）；这里统一 resolve 成平台绝对路径再比。
    expect(r.worktree_path).toBeDefined();
    expect(resolve(r.worktree_path!)).toBe(resolve(repo));
    expect((await git(repo, ["rev-parse", "main"])).stdout).toBe(before);
    expect(await readFile(join(repo, "T-13.txt"), "utf8")).toBe("local untracked\n");
    expect((await store.get(id))?.status).toBe("open");
  });
  it("未被 checkout：update-ref", async () => {
    await git(repo, ["branch", "integration", "main"]);
    const { wt, id } = await ffPr("feat/int", "T-11");
    const r = await pr.merge(id, "integration");
    expect(r).toMatchObject({ merged: true, fast_forward: true });
    expect((await git(repo, ["rev-parse", "integration"])).stdout).toBe(
      (await git(wt, ["rev-parse", "HEAD"])).stdout,
    );
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("1\n2\n3\n");
  });
});

describe("commitPatch 与 hook", () => {
  it("pre-commit 失败：抛错带 hook 输出，不提交，补丁撤回", async () => {
    const wt = await worktree("feat/hook");
    const hook = join(repo, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\necho HOOK_SAYS_NO >&2\nexit 1\n");
    await chmod(hook, 0o755);
    const before = (await git(wt, ["rev-parse", "HEAD"])).stdout;
    const patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n 1\n-2\n+two\n 3\n";
    await expect(pr.commitPatch("T-12", wt, patch)).rejects.toThrow(/HOOK_SAYS_NO/);
    expect((await git(wt, ["rev-parse", "HEAD"])).stdout).toBe(before);
    expect((await git(wt, ["status", "--porcelain"])).stdout).toBe("");
  });
});

describe("createPrProvider（本地分支）", () => {
  it("无 GITHUB_TOKEN 返回本地实现，不警告", async () => {
    const logger = { warn: vi.fn() };
    const p = await createPrProvider({ store, repo, getSecret: () => undefined, logger });
    expect(p).toBeInstanceOf(LocalPrProvider);
    expect(logger.warn).not.toHaveBeenCalled();
  });
  it("getSecret 抛错（未设置）按读不到处理", async () => {
    const p = await createPrProvider({
      store,
      repo,
      getSecret: () => {
        throw new Error("缺少环境变量 GITHUB_TOKEN");
      },
    });
    expect(p.kind).toBe("local");
  });
  it("有 token 但没有 origin：本地实现", async () => {
    const p = await createPrProvider({ store, repo, getSecret: () => "x" });
    expect(p.kind).toBe("local");
  });
});

describe("T-066 merge expected_head（本地）", () => {
  it("expected_head 一致：合并成功", async () => {
    const wt = await worktree("feat/eh-ok");
    await writeFile(join(wt, "eh.txt"), "ok\n");
    await commitAll(wt, "eh");
    const head = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
    const id = await pr.open("T-eh1", wt, "feat/eh-ok");
    const r = await pr.merge(id, "main", { expected_head: head });
    expect(r).toMatchObject({ merged: true, sha: head });
  });
  it("expected_head 不一致：抛 ExpectedHeadMismatchError，不动 main", async () => {
    const wt = await worktree("feat/eh-bad");
    await writeFile(join(wt, "eh2.txt"), "bad\n");
    await commitAll(wt, "eh2");
    const mainBefore = (await git(repo, ["rev-parse", "main"])).stdout.trim();
    const id = await pr.open("T-eh2", wt, "feat/eh-bad");
    const err = (await pr
      .merge(id, "main", { expected_head: "f".repeat(40) })
      .catch((e: unknown) => e)) as ExpectedHeadMismatchError;
    expect(err).toBeInstanceOf(ExpectedHeadMismatchError);
    expect(err.code).toBe("expected_head_mismatch");
    expect((await git(repo, ["rev-parse", "main"])).stdout.trim()).toBe(mainBefore);
    expect((await store.get(id))?.status).toBe("open");
  });
});
