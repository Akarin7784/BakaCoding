import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INTEGRATION_BRANCH, InMemoryPrStore, LocalPrProvider } from "./index.js";
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
async function rev(r: string) {
  return (await git(repo, ["rev-parse", r])).stdout.trim();
}
/** 从 base 拉一个单张 PR 分支，提交一个文件，返回 open 后的 pr_id。 */
async function ticketPr(ticket: string, base = INTEGRATION_BRANCH, file = `${ticket}.txt`) {
  const branch = `feat/${ticket}`;
  const wt = join(root, `wt-${ticket}`);
  await git(repo, ["worktree", "add", "-q", "-b", branch, wt, base]);
  await writeFile(join(wt, file), `${ticket}\n`);
  await commitAll(wt, ticket);
  return pr.open(ticket, wt, branch);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bc-pr-int-test-"));
  repo = join(root, "repo");
  await git(root, ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "a.txt"), "1\n2\n3\n");
  await commitAll(repo, "init");
  store = new InMemoryPrStore();
  pr = new LocalPrProvider({ store, repo, author: { name: "t", email: "t@t" } });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("openIntegration", () => {
  it("默认分支名；分支不存在时从 target 建出，不 checkout", async () => {
    expect(INTEGRATION_BRANCH).toBe("bakacoding/integration");
    const id = await pr.openIntegration();
    expect(id).toBe("local-integration-1");
    expect(await rev(INTEGRATION_BRANCH)).toBe(await rev("main"));
    expect((await git(repo, ["symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe("main");
    const rec = await store.get(id);
    expect(rec).toMatchObject({
      kind: "integration",
      branch: INTEGRATION_BRANCH,
      base_branch: "main",
      repo_path: repo,
      status: "open",
    });
    expect(rec).not.toHaveProperty("ticket_id");
    expect(rec).not.toHaveProperty("worktree_path");
    expect(await pr.checks(id)).toEqual([]);
  });

  it("分支已存在时不改动它", async () => {
    await git(repo, ["branch", "int2", "main"]);
    await writeFile(join(repo, "a.txt"), "main moved\n");
    await commitAll(repo, "main moved");
    const before = await rev("int2");
    await pr.openIntegration("int2", "main");
    expect(await rev("int2")).toBe(before);
  });

  it("同一对 (branch, target) 幂等，含并发调用；不同 branch 各自一条", async () => {
    const [a, b] = await Promise.all([pr.openIntegration(), pr.openIntegration()]);
    expect(a).toBe(b);
    expect(await pr.openIntegration(INTEGRATION_BRANCH, "main")).toBe(a);
    const other = await pr.openIntegration("other-int");
    expect(other).not.toBe(a);
    expect((await store.list()).filter((r) => r.kind === "integration")).toHaveLength(2);
  });

  it("没配 repo 时抛错", async () => {
    const p = new LocalPrProvider({ store });
    await expect(p.openIntegration()).rejects.toThrow(/repo/);
  });
});

describe("集成记录 diff 现算", () => {
  it("随集成分支前进而更新，base 取当前 merge-base", async () => {
    const id = await pr.openIntegration();
    const d0 = await pr.diff(id);
    expect(d0.files).toEqual([]);
    expect(d0.head_sha).toBe(await rev("main"));

    // 单张 PR 合入集成分支（未被 checkout：update-ref）
    const t1 = await ticketPr("T-1");
    expect(await pr.merge(t1, INTEGRATION_BRANCH)).toMatchObject({ merged: true });
    const d1 = await pr.diff(id);
    expect(d1.head_sha).toBe(await rev(INTEGRATION_BRANCH));
    expect(d1.files.map((f) => f.path)).toEqual(["T-1.txt"]);

    const t2 = await ticketPr("T-2");
    await pr.merge(t2, INTEGRATION_BRANCH);
    const d2 = await pr.diff(id);
    expect(d2.head_sha).toBe(await rev(INTEGRATION_BRANCH));
    expect(d2.files.map((f) => f.path).sort()).toEqual(["T-1.txt", "T-2.txt"]);

    // main 另行前进：base 跟着 merge-base 走，不沿用 open 时的值
    await writeFile(join(repo, "m.txt"), "m\n");
    await commitAll(repo, "main only");
    await git(repo, ["merge", "-q", "--no-edit", INTEGRATION_BRANCH], { env: ENV });
    await writeFile(join(repo, "m2.txt"), "m2\n");
    await commitAll(repo, "main only 2");
    const t3 = await ticketPr("T-3");
    await pr.merge(t3, INTEGRATION_BRANCH);
    const d3 = await pr.diff(id);
    expect(d3.base_sha).toBe(
      (await git(repo, ["merge-base", "main", INTEGRATION_BRANCH])).stdout.trim(),
    );
    expect(d3.base_sha).not.toBe(d0.base_sha);
    expect(d3.files.map((f) => f.path)).toEqual(["T-3.txt"]);
  });
});

describe("集成记录 merge", () => {
  it("快进合入 main，记录 merged；再 open 得到新 pr_id", async () => {
    const id = await pr.openIntegration();
    await pr.merge(await ticketPr("T-4"), INTEGRATION_BRANCH);
    await pr.merge(await ticketPr("T-5"), INTEGRATION_BRANCH);
    const head = await rev(INTEGRATION_BRANCH);
    const r = await pr.merge(id, "main");
    expect(r).toEqual({ merged: true, sha: head, fast_forward: true });
    expect(await rev("main")).toBe(head);
    expect(await store.get(id)).toMatchObject({ status: "merged", merged_into: "main" });

    // 合并后冻结：diff 用记录值，不随集成分支再前进
    const frozen = await pr.diff(id);
    expect(frozen.files.map((f) => f.path).sort()).toEqual(["T-4.txt", "T-5.txt"]);
    await expect(pr.merge(id, "main")).rejects.toThrow();

    const next = await pr.openIntegration();
    expect(next).toBe("local-integration-2");
    expect((await pr.diff(next)).files).toEqual([]);
    await pr.merge(await ticketPr("T-6"), INTEGRATION_BRANCH);
    expect((await pr.diff(next)).files.map((f) => f.path)).toEqual(["T-6.txt"]);
    expect((await pr.diff(id)).files.map((f) => f.path).sort()).toEqual(["T-4.txt", "T-5.txt"]);
  });

  it("main 已前进：生成合并提交（非 FF）", async () => {
    const id = await pr.openIntegration();
    await pr.merge(await ticketPr("T-7"), INTEGRATION_BRANCH);
    await writeFile(join(repo, "hotfix.txt"), "h\n");
    await commitAll(repo, "hotfix on main");
    const r = await pr.merge(id, "main");
    expect(r).toMatchObject({ merged: true, fast_forward: false });
    const files = (await git(repo, ["ls-tree", "--name-only", "main"])).stdout;
    expect(files).toContain("T-7.txt");
    expect(files).toContain("hotfix.txt");
    const parents = (await git(repo, ["rev-list", "--parents", "-n1", "main"])).stdout.split(" ");
    expect(parents).toHaveLength(3);
    expect((await git(repo, ["log", "-1", "--format=%s", "main"])).stdout.trim()).toBe(
      `Merge ${id} (${INTEGRATION_BRANCH}) into main`,
    );
  });

  it("冲突返回 conflicted_files，main 不动；冲突中的记录仍算未结束，open 返回同一条", async () => {
    const id = await pr.openIntegration();
    await pr.merge(await ticketPr("T-8", INTEGRATION_BRANCH, "a.txt"), INTEGRATION_BRANCH);
    await writeFile(join(repo, "a.txt"), "main side\n");
    await commitAll(repo, "main edits a");
    const before = await rev("main");
    const r = await pr.merge(id, "main");
    expect(r).toEqual({ merged: false, conflict: true, conflicted_files: ["a.txt"] });
    expect(await rev("main")).toBe(before);
    expect((await store.get(id))?.status).toBe("conflict");
    expect(await pr.openIntegration()).toBe(id);
  });
});

describe("PrRecord 类型按 kind 区分", () => {
  it("ticket 记录必填 ticket_id / worktree_path；集成记录不带这两个字段", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const storeTs = resolve(here, "store.ts").replace(/\\/g, "/");
    const src = `
import type { PrRecord, TicketPrRecord, IntegrationPrRecord } from ${JSON.stringify(storeTs.replace(/\.ts$/, ".js"))};
const base = { pr_id: "p", branch: "b", base_branch: "main", base_sha: "x", head_sha: "y",
  status: "open", created_ts: "t", updated_ts: "t" } as const;
export const ok1: TicketPrRecord = { ...base, kind: "ticket", ticket_id: "T-1", worktree_path: "/w" };
export const ok2: IntegrationPrRecord = { ...base, kind: "integration", repo_path: "/r" };
// @ts-expect-error ticket 记录缺 ticket_id
export const bad1: PrRecord = { ...base, kind: "ticket", worktree_path: "/w" };
// @ts-expect-error ticket 记录缺 worktree_path
export const bad2: PrRecord = { ...base, kind: "ticket", ticket_id: "T-1" };
// @ts-expect-error 集成记录不能带 ticket_id
export const bad3: PrRecord = { ...base, kind: "integration", repo_path: "/r", ticket_id: "T-1" };
export function f(r: PrRecord) {
  // @ts-expect-error 未收窄时不能读 ticket_id
  void r.ticket_id;
  if (r.kind === "ticket") return r.ticket_id + r.worktree_path;
  // @ts-expect-error 集成记录上不存在 worktree_path
  return r.worktree_path;
}
`;
    const file = resolve(here, "__kind_check__.ts");
    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      types: [],
      baseUrl: here,
      paths: { "@bakacoding/types": [resolve(here, "../../types/src/index.ts")] },
    };
    const host = ts.createCompilerHost(options);
    const read = host.readFile.bind(host);
    host.readFile = (p) => (resolve(p) === file ? src : read(p));
    const exists = host.fileExists.bind(host);
    host.fileExists = (p) => resolve(p) === file || exists(p);
    const program = ts.createProgram([file], options, host);
    const diags = ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(diags).toEqual([]);
  }, 30_000);
});
