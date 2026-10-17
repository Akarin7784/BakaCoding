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

describe("T-076 本地模式：合入默认集成分支前补建（从基线分支建，幂等、并发安全）", () => {
  /** 按 4 的做法（worktree add -b bakacoding/<单号>-r0 <base>）开单、提交、open。 */
  async function freshTicket(ticket: string, base = "main", provider = pr) {
    const branch = `bakacoding/${ticket}-r0`;
    const wt = join(root, `wt-${ticket}`);
    await git(repo, ["worktree", "add", "-q", "-b", branch, wt, base]);
    const pr_id = await provider.open(ticket, wt, branch);
    await writeFile(join(wt, `${ticket}.txt`), `${ticket}\n`);
    const sha = await provider.commitWorktree(ticket, wt);
    return { pr_id, wt, branch, sha };
  }
  async function exists(ref: string) {
    return (
      (await git(repo, ["show-ref", "--verify", "--quiet", ref], { allowCodes: [1] })).code === 0
    );
  }
  async function isAncestor(a: string, b: string) {
    return (await git(repo, ["merge-base", "--is-ancestor", a, b], { allowCodes: [1] })).code === 0;
  }
  /** 集成分支的 reflog，旧的在前（core.logAllRefUpdates 对非裸仓库默认开启）。 */
  async function reflog() {
    const out = (
      await git(repo, ["reflog", "show", "--format=%H", `refs/heads/${INTEGRATION_BRANCH}`])
    ).stdout;
    return out.trim().split("\n").filter(Boolean).reverse();
  }

  it("新仓库没有集成分支：第一张单 open → commit → merge 走通，集成分支从 main 建出并含该提交", async () => {
    expect(await exists(`refs/heads/${INTEGRATION_BRANCH}`)).toBe(false);
    const mainBefore = await rev("main");
    const t = await freshTicket("T-1");
    // open / commit 不建分支，合入前才补建
    expect(await exists(`refs/heads/${INTEGRATION_BRANCH}`)).toBe(false);

    const res = await pr.merge(t.pr_id, INTEGRATION_BRANCH, { expected_head: t.sha });
    expect(res).toEqual({ merged: true, sha: t.sha, fast_forward: true });
    expect(await rev(INTEGRATION_BRANCH)).toBe(t.sha);
    expect((await reflog())[0]).toBe(mainBefore);
    expect(await rev("main")).toBe(mainBefore);
    expect((await git(repo, ["symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe("main");
    expect(await store.get(t.pr_id)).toMatchObject({
      status: "merged",
      merged_into: INTEGRATION_BRANCH,
      merge_sha: t.sha,
    });

    // 第二张单合入已建好的集成分支（不再重建）
    const t2 = await freshTicket("T-2");
    expect(await pr.merge(t2.pr_id, INTEGRATION_BRANCH)).toMatchObject({
      merged: true,
      fast_forward: false,
    });
    for (const s of [t.sha, t2.sha]) expect(await isAncestor(s, INTEGRATION_BRANCH)).toBe(true);
  });

  it("工作树检出在带未合入提交的功能分支上：集成分支指向 main，不含该提交", async () => {
    const mainSha = await rev("main");
    await git(repo, ["checkout", "-q", "-b", "feat/wip"]);
    await writeFile(join(repo, "wip.txt"), "wip\n");
    await commitAll(repo, "wip");
    const wip = await rev("HEAD");
    expect(wip).not.toBe(mainSha);

    const t = await freshTicket("T-1", "main");
    const res = await pr.merge(t.pr_id, INTEGRATION_BRANCH);
    expect(res).toEqual({ merged: true, sha: t.sha, fast_forward: true });
    expect((await reflog())[0]).toBe(mainSha);
    expect(await rev(`${INTEGRATION_BRANCH}~1`)).toBe(mainSha);
    expect(await isAncestor(wip, INTEGRATION_BRANCH)).toBe(false);
    // 功能分支和检出都不动
    expect(await rev("feat/wip")).toBe(wip);
    expect((await git(repo, ["symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe("feat/wip");
  });

  it("配置了别的基线分支（baseBranch）时从它建出", async () => {
    await git(repo, ["branch", "trunk", "main"]);
    const wt = join(root, "wt-trunk");
    await git(repo, ["worktree", "add", "-q", wt, "trunk"]);
    await writeFile(join(wt, "t.txt"), "t\n");
    await commitAll(wt, "trunk moved");
    const trunk = await rev("trunk");
    const p2 = new LocalPrProvider({
      store,
      repo,
      baseBranch: "trunk",
      author: { name: "t", email: "t@t" },
    });
    const t = await freshTicket("T-1", "trunk", p2);
    expect(await p2.merge(t.pr_id, INTEGRATION_BRANCH)).toMatchObject({ merged: true });
    expect((await reflog())[0]).toBe(trunk);
  });

  it("集成分支已存在（落后于 main）：不动它，照常合入", async () => {
    await git(repo, ["branch", INTEGRATION_BRANCH, "main"]);
    const intBefore = await rev(INTEGRATION_BRANCH);
    await writeFile(join(repo, "a.txt"), "main moved\n");
    await commitAll(repo, "main moved");
    const t = await freshTicket("T-1", INTEGRATION_BRANCH);
    expect(await pr.merge(t.pr_id, INTEGRATION_BRANCH)).toMatchObject({
      merged: true,
      fast_forward: true,
    });
    expect(await rev(`${INTEGRATION_BRANCH}~1`)).toBe(intBefore);
    expect(await isAncestor(await rev("main"), INTEGRATION_BRANCH)).toBe(false);
  });

  it("集成分支已存在且领先：补建逻辑不改它的位置", async () => {
    const t0 = await freshTicket("T-0");
    await pr.merge(t0.pr_id, INTEGRATION_BRANCH);
    const before = await rev(INTEGRATION_BRANCH);
    const t = await freshTicket("T-1");
    expect(await pr.merge(t.pr_id, INTEGRATION_BRANCH)).toMatchObject({
      merged: true,
      fast_forward: false,
    });
    const parents = (await git(repo, ["rev-list", "--parents", "-n1", INTEGRATION_BRANCH])).stdout
      .trim()
      .split(" ");
    expect(parents.slice(1)).toEqual([before, t.sha]);
  });

  it("两张单同时合并、同时触发建分支：只建一次，两张单都合入", async () => {
    const mainSha = await rev("main");
    const t1 = await freshTicket("T-1");
    const t2 = await freshTicket("T-2");
    const [r1, r2] = await Promise.all([
      pr.merge(t1.pr_id, INTEGRATION_BRANCH),
      pr.merge(t2.pr_id, INTEGRATION_BRANCH),
    ]);
    expect(r1).toMatchObject({ merged: true });
    expect(r2).toMatchObject({ merged: true });
    // reflog：建一次（指向 main）+ 两次合入
    const log = await reflog();
    expect(log).toHaveLength(3);
    expect(log[0]).toBe(mainSha);
    for (const s of [t1.sha, t2.sha]) expect(await isAncestor(s, INTEGRATION_BRANCH)).toBe(true);
    for (const id of [t1.pr_id, t2.pr_id])
      expect(await store.get(id)).toMatchObject({ status: "merged" });
  });

  it("ensureBranch 并发调用（含不同实例）：都成功，分支只建一次、指向 target", async () => {
    const mainSha = await rev("main");
    const other = new LocalPrProvider({ store, repo });
    const shas = await Promise.all([
      pr.ensureBranch(repo, INTEGRATION_BRANCH, "main"),
      other.ensureBranch(repo, INTEGRATION_BRANCH, "main"),
      pr.ensureBranch(repo, INTEGRATION_BRANCH, "main"),
    ]);
    expect(shas).toEqual([mainSha, mainSha, mainSha]);
    expect(await rev(INTEGRATION_BRANCH)).toBe(mainSha);
    expect(await reflog()).toEqual([mainSha]);
  });

  it("别的 target 不存在时不自动建，照常报错", async () => {
    const t = await freshTicket("T-1");
    await expect(pr.merge(t.pr_id, "no-such-branch")).rejects.toThrow();
    expect(await exists("refs/heads/no-such-branch")).toBe(false);
    expect(await store.get(t.pr_id)).toMatchObject({ status: "open" });
  });
});
