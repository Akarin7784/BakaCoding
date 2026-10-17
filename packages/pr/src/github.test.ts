import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EscalatedSchema } from "@bakacoding/types";
import {
  createPrProvider,
  ExpectedHeadMismatchError,
  GithubAuthError,
  GithubBranchDivergedError,
  GithubRateLimitError,
  GithubPrProvider,
  InMemoryPrStore,
  InvalidPrRecordError,
  INTEGRATION_BRANCH,
  LocalPrProvider,
  parseGithubRemote,
  PrAlreadyMergedError,
  SyncPartialError,
  type EscalatedInput,
  type PrRecord,
} from "./index.js";
import { git } from "./git.js";

const TOKEN = "fake-token-for-tests-0123456789";
const ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const CTX = { requirement_id: "R-1", trace_id: "tr", span_id: "sp", parent_span_id: null };

let root: string;
let repo: string;
let bare: string;
let store: InMemoryPrStore;
let events: EscalatedInput[];
let logs: string[];
let gh: FakeGithub;
let pr: GithubPrProvider;

async function commitAll(cwd: string, msg: string) {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", msg], { env: ENV });
}
const rev = async (cwd: string, r: string) => (await git(cwd, ["rev-parse", r])).stdout.trim();
const remoteHas = async (ref: string) =>
  (await git(bare, ["show-ref", "--verify", "--quiet", ref], { allowCodes: [1] })).code === 0;

/** 只在内存里模拟 GitHub REST；合并真的落到本地 bare 仓库，方便 fetch 验证。 */
class FakeGithub {
  pulls: {
    number: number;
    head: string;
    base: string;
    state: "open" | "closed";
    merged: boolean;
    merge_commit_sha: string | null;
  }[] = [];
  calls: { method: string; path: string; auth: string | null; body: unknown }[] = [];
  /** 按 "METHOD path 前缀" 覆盖响应 */
  override: ((method: string, path: string) => Response | undefined) | undefined;
  checkRuns: unknown[] = [];
  /** commit status API 的 statuses 列表（T-066） */
  commitStatuses: {
    context: string;
    state: string;
    target_url?: string | null;
  }[] = [];
  /** check-runs 每页上限（同真 GitHub：不带 per_page 默认 30，最多 100）；测翻页时可改小 */
  checkRunsPageSize = 100;
  /** commit status 每页上限（同真 GitHub：不带 per_page 默认 30，最多 100）；测翻页时可改小 */
  statusPageSize = 100;
  /** 覆盖 combined status 顶层 state；不设时按 statuses 推出（同真 GitHub） */
  commitCombinedState: string | undefined;

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname.replace(/^\/repos\/acme\/widget/, "");
    this.calls.push({ method, path: path + url.search, auth: headers.get("authorization"), body });
    const o = this.override?.(method, path);
    if (o) return o;
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    const view = (p: FakeGithub["pulls"][number]) => ({
      number: p.number,
      html_url: `https://github.com/acme/widget/pull/${p.number}`,
      state: p.state,
      merged: p.merged,
      merge_commit_sha: p.merge_commit_sha,
      base: { ref: p.base },
    });
    if (method === "GET" && path === "/pulls") {
      const head = url.searchParams.get("head")?.replace(/^acme:/, "");
      const base = url.searchParams.get("base");
      return json(
        this.pulls
          .filter((p) => p.state === "open" && p.head === head && p.base === base)
          .map(view),
      );
    }
    if (method === "POST" && path === "/pulls") {
      const b = body as { head: string; base: string };
      if (!(await remoteHas(`refs/heads/${b.base}`)) || !(await remoteHas(`refs/heads/${b.head}`)))
        return json({ message: "Validation Failed" }, 422);
      // 同真 GitHub：head 比 base 没有新提交时不能开 PR
      const ahead = await git(bare, [
        "rev-list",
        "--count",
        `refs/heads/${b.base}..refs/heads/${b.head}`,
      ]);
      if (Number(ahead.stdout.trim()) === 0)
        return json({ message: `No commits between ${b.base} and ${b.head}` }, 422);
      const p = {
        number: this.pulls.length + 1,
        head: b.head,
        base: b.base,
        state: "open" as const,
        merged: false,
        merge_commit_sha: null,
      };
      this.pulls.push(p);
      return json(view(p), 201);
    }
    let m = /^\/pulls\/(\d+)\/merge$/.exec(path);
    if (m && method === "PUT") {
      const p = this.pulls[Number(m[1]) - 1]!;
      const b = body as { sha: string; merge_method: string };
      const head = await rev(bare, `refs/heads/${p.head}`);
      if (b.sha !== head) return json({ message: "Head branch was modified" }, 409);
      const base = await rev(bare, `refs/heads/${p.base}`);
      const mt = await git(bare, ["merge-tree", "--write-tree", base, head], { allowCodes: [1] });
      if (mt.code === 1) return json({ message: "Pull Request is not mergeable" }, 405);
      const tree = mt.stdout.split("\n")[0]!;
      const sha = (
        await git(bare, ["commit-tree", tree, "-p", base, "-p", head, "-m", `Merge #${p.number}`], {
          env: ENV,
        })
      ).stdout.trim();
      await git(bare, ["update-ref", `refs/heads/${p.base}`, sha, base]);
      p.state = "closed";
      p.merged = true;
      p.merge_commit_sha = sha;
      return json({ sha, merged: true, message: "Pull Request successfully merged" });
    }
    m = /^\/pulls\/(\d+)$/.exec(path);
    if (m && method === "GET") return json(view(this.pulls[Number(m[1]) - 1]!));
    if (m && method === "PATCH") {
      const p = this.pulls[Number(m[1]) - 1]!;
      const b = body as { state?: string };
      if (p.merged) return json({ message: "Validation Failed" }, 422);
      if (b.state === "closed") p.state = "closed";
      return json(view(p));
    }
    if (method === "GET" && /^\/commits\/[0-9a-f]+\/check-runs$/.test(path)) {
      const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
      const per = Math.min(
        this.checkRunsPageSize,
        100,
        Math.max(1, Number(url.searchParams.get("per_page") ?? "30") || 30),
      );
      const start = (page - 1) * per;
      const slice = this.checkRuns.slice(start, start + per);
      return json({ total_count: this.checkRuns.length, check_runs: slice });
    }
    if (method === "GET" && /^\/commits\/[0-9a-f]+\/status$/.test(path)) {
      const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
      const per = Math.min(
        this.statusPageSize,
        100,
        Math.max(1, Number(url.searchParams.get("per_page") ?? "30") || 30),
      );
      const start = (page - 1) * per;
      const all = this.commitStatuses;
      const derived = all.some((x) => x.state === "failure" || x.state === "error")
        ? "failure"
        : all.length === 0 || all.some((x) => x.state === "pending")
          ? "pending"
          : "success";
      return json({
        state: this.commitCombinedState ?? derived,
        total_count: all.length,
        statuses: all.slice(start, start + per),
      });
    }
    return json({ message: "Not Found" }, 404);
  };
}

function provider(over: Partial<ConstructorParameters<typeof GithubPrProvider>[0]> = {}) {
  return new GithubPrProvider({
    store,
    repo,
    github: { owner: "acme", name: "widget" },
    token: TOKEN,
    fetch: gh.fetch,
    publish: (e) => {
      events.push(e);
    },
    eventContext: () => CTX,
    logger: { warn: (m) => logs.push(m) },
    author: { name: "t", email: "t@t" },
    ...over,
  });
}

/** 从本地集成分支拉一个单张 PR 分支并提交一个文件。 */
async function ticketBranch(ticket: string, file = `${ticket}.txt`, content = `${ticket}\n`) {
  const branch = `feat/${ticket}`;
  const wt = join(root, `wt-${ticket}`);
  await git(repo, ["worktree", "add", "-q", "-b", branch, wt, INTEGRATION_BRANCH]);
  await writeFile(join(wt, file), content);
  await commitAll(wt, ticket);
  return { wt, branch };
}

/** 本地集成分支比 main 多一个提交（让 openIntegration 能开出远程 PR）。 */
async function integrationAhead() {
  const wt = join(root, "wt-integration");
  await git(repo, ["branch", INTEGRATION_BRANCH, "main"]);
  await git(repo, ["worktree", "add", "-q", wt, INTEGRATION_BRANCH]);
  await writeFile(join(wt, "integration.txt"), "i\n");
  await commitAll(wt, "integration");
}

/** 按 8 的真实顺序：建 worktree → open（还没有提交）→ 写文件 → commitWorktree（push 并开 PR）。 */
async function ticketPr(
  ticket: string,
  opts: { file?: string; content?: string; from?: string } = {},
) {
  const branch = `feat/${ticket}`;
  const wt = join(root, `wt-${ticket}`);
  await git(repo, ["worktree", "add", "-q", "-b", branch, wt, opts.from ?? INTEGRATION_BRANCH]);
  const id = await pr.open(ticket, wt, branch);
  await writeFile(join(wt, opts.file ?? `${ticket}.txt`), opts.content ?? `${ticket}\n`);
  const sha = await pr.commitWorktree(ticket, wt);
  return { wt, branch, id, sha };
}
const pullOf = (branch: string) => gh.pulls.find((p) => p.head === branch);
const posts = () => gh.calls.filter((c) => c.method === "POST" && c.path === "/pulls");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bc-pr-gh-test-"));
  repo = join(root, "repo");
  bare = join(root, "origin.git");
  await git(root, ["init", "-q", "--bare", "-b", "main", bare]);
  await git(root, ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "a.txt"), "1\n2\n3\n");
  await commitAll(repo, "init");
  await git(repo, ["remote", "add", "origin", bare]);
  await git(repo, ["push", "-q", "origin", "main"]);
  store = new InMemoryPrStore();
  events = [];
  logs = [];
  gh = new FakeGithub();
  pr = provider();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("parseGithubRemote", () => {
  it("https / ssh / scp 形式；非 github.com 返回 null", () => {
    const want = { owner: "acme", name: "widget" };
    expect(parseGithubRemote("https://github.com/acme/widget.git")).toEqual(want);
    expect(parseGithubRemote("https://github.com/acme/widget")).toEqual(want);
    expect(parseGithubRemote("git@github.com:acme/widget.git")).toEqual(want);
    expect(parseGithubRemote("ssh://git@github.com/acme/widget.git")).toEqual(want);
    expect(parseGithubRemote("ssh://git@ssh.github.com:443/acme/widget.git")).toEqual(want);
    expect(parseGithubRemote("https://gitlab.com/acme/widget.git")).toBeNull();
    expect(parseGithubRemote("git@github.example.com:acme/widget.git")).toBeNull();
    expect(parseGithubRemote("/tmp/origin.git")).toBeNull();
  });
});

describe("createPrProvider 选择", () => {
  const base = () => ({
    store,
    repo,
    getSecret: () => TOKEN,
    publish: () => undefined,
    eventContext: () => CTX,
    fetch: gh.fetch,
  });
  it("有 token 且 origin 是 GitHub → GitHub 实现", async () => {
    const p = await createPrProvider({ ...base(), remoteUrl: "git@github.com:acme/widget.git" });
    expect(p).toBeInstanceOf(GithubPrProvider);
    expect(p.kind).toBe("github");
  });
  it("origin 不是 github.com → 本地实现（真实 origin 为本地路径）", async () => {
    const p = await createPrProvider(base());
    expect(p).toBeInstanceOf(LocalPrProvider);
  });
  it("没有 token → 本地实现", async () => {
    const p = await createPrProvider({
      ...base(),
      getSecret: () => undefined,
      remoteUrl: "https://github.com/acme/widget.git",
    });
    expect(p.kind).toBe("local");
  });
  it("选中 GitHub 但缺 publish / eventContext → 抛错", async () => {
    await expect(
      createPrProvider({
        store,
        repo,
        getSecret: () => TOKEN,
        remoteUrl: "https://github.com/acme/widget.git",
      }),
    ).rejects.toThrow(/publish/);
  });
});

describe("open（远程 PR 在第一次 commitWorktree 之后才有）", () => {
  it("open 只建本地记录并确保远程有集成分支：不推工作分支、不调 POST /pulls", async () => {
    expect(await remoteHas(`refs/heads/${INTEGRATION_BRANCH}`)).toBe(false);
    // 工作分支从 main 拉（本地此时还没有集成分支），还没有任何提交
    const wt = join(root, "wt-T-1");
    await git(repo, ["worktree", "add", "-q", "-b", "feat/T-1", wt, "main"]);
    const id = await pr.open("T-1", wt, "feat/T-1");

    expect(await rev(repo, INTEGRATION_BRANCH)).toBe(await rev(repo, "main"));
    expect(await remoteHas(`refs/heads/${INTEGRATION_BRANCH}`)).toBe(true);
    expect(await remoteHas("refs/heads/feat/T-1")).toBe(false);
    expect(gh.calls).toEqual([]);
    const rec = await store.get(id);
    expect(rec).toMatchObject({ kind: "ticket", status: "open" });
    expect(rec?.remote).toBeUndefined();
  });

  it("第一次 commitWorktree：只推本单分支、开 PR（base=集成分支）；再次 commitWorktree 复用 PR、推新提交", async () => {
    await pr.openIntegration();
    const { wt, branch, id, sha } = await ticketPr("T-2");
    expect(sha).toBe(await rev(wt, "HEAD"));
    expect(await rev(bare, `refs/heads/${branch}`)).toBe(sha);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.body).toMatchObject({ head: branch, base: INTEGRATION_BRANCH });
    expect(posts()[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(await store.get(id)).toMatchObject({
      status: "open",
      remote: { number: 1, url: "https://github.com/acme/widget/pull/1" },
    });

    // 复投：原地再提交一次
    await writeFile(join(wt, "T-2b.txt"), "again\n");
    const sha2 = await pr.commitWorktree("T-2", wt);
    expect(sha2).not.toBe(sha);
    expect(await rev(bare, `refs/heads/${branch}`)).toBe(sha2);
    expect(posts()).toHaveLength(1);
    expect(gh.pulls).toHaveLength(1);
    expect((await store.get(id))?.remote?.number).toBe(1);
  });

  it("push 的 refspec 只有本单分支：不碰集成分支和 main", async () => {
    await pr.openIntegration();
    const { wt } = await ticketPr("T-3");
    const intBefore = await rev(bare, `refs/heads/${INTEGRATION_BRANCH}`);
    const mainBefore = await rev(bare, "refs/heads/main");
    // 本地集成分支和 main 都往前走了，但 commitWorktree 不应把它们推上去
    await writeFile(join(repo, "local-main.txt"), "m\n");
    await commitAll(repo, "local main");
    await git(repo, ["branch", "-f", INTEGRATION_BRANCH, "main"]);
    const pushes: string[][] = [];
    const real = await import("./git.js");
    const spy = vi.spyOn(real, "git");
    await writeFile(join(wt, "T-3b.txt"), "b\n");
    await pr.commitWorktree("T-3", wt);
    for (const c of spy.mock.calls) if (c[1][0] === "push") pushes.push([...c[1]]);
    spy.mockRestore();
    expect(await rev(bare, `refs/heads/${INTEGRATION_BRANCH}`)).toBe(intBefore);
    expect(await rev(bare, "refs/heads/main")).toBe(mainBefore);
    expect(await rev(bare, "refs/heads/feat/T-3")).toBe(await rev(wt, "HEAD"));
    expect(pushes.length).toBeGreaterThan(0);
    for (const args of pushes) {
      expect(args.filter((a) => a.startsWith("refs/"))).toEqual([
        "refs/heads/feat/T-3:refs/heads/feat/T-3",
      ]);
      expect(args.some((a) => a.startsWith("--force") || a.startsWith("+"))).toBe(false);
    }
  });

  it("openIntegration：集成分支比 main 没有新提交时只推分支、不开 PR；有提交时开 base=main 的 PR 且幂等", async () => {
    const iid = await pr.openIntegration();
    expect(await remoteHas(`refs/heads/${INTEGRATION_BRANCH}`)).toBe(true);
    expect(posts()).toHaveLength(0);
    expect((await store.get(iid))?.remote).toBeUndefined();

    await rm(root, { recursive: true, force: true });
    root = await mkdtemp(join(tmpdir(), "bc-pr-gh-test-"));
    repo = join(root, "repo");
    bare = join(root, "origin.git");
    await git(root, ["init", "-q", "--bare", "-b", "main", bare]);
    await git(root, ["init", "-q", "-b", "main", repo]);
    await writeFile(join(repo, "a.txt"), "1\n");
    await commitAll(repo, "init");
    await git(repo, ["remote", "add", "origin", bare]);
    await git(repo, ["push", "-q", "origin", "main"]);
    store = new InMemoryPrStore();
    pr = provider();
    await integrationAhead();
    const iid2 = await pr.openIntegration();
    expect(gh.pulls.at(-1)).toMatchObject({ head: INTEGRATION_BRANCH, base: "main" });
    expect((await store.get(iid2))?.remote).toBeDefined();
    const n = gh.pulls.length;
    expect(await pr.openIntegration()).toBe(iid2);
    expect(gh.pulls).toHaveLength(n);
  });
});

describe("merge", () => {
  it("成功：PUT 带 head sha 与 merge_method=merge，fetch 后本地集成分支和记录同步", async () => {
    await pr.openIntegration();
    const { wt, branch } = await ticketBranch("T-3");
    const id = await pr.open("T-3", wt, branch);
    const head = await rev(wt, "HEAD");
    const r = await pr.merge(id, INTEGRATION_BRANCH);
    const put = gh.calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe("/pulls/1/merge");
    expect(put.body).toEqual({ sha: head, merge_method: "merge" });
    const remoteInt = await rev(bare, `refs/heads/${INTEGRATION_BRANCH}`);
    expect(r).toEqual({ merged: true, sha: remoteInt, fast_forward: false });
    expect(await rev(repo, INTEGRATION_BRANCH)).toBe(remoteInt);
    expect(await store.get(id)).toMatchObject({
      status: "merged",
      merged_into: INTEGRATION_BRANCH,
      merge_sha: remoteInt,
      head_sha: head,
    });
    await expect(pr.merge(id, INTEGRATION_BRANCH)).rejects.toThrow();
  });

  it("复投后本地有新提交：合并前先推，sha 校验通过", async () => {
    await pr.openIntegration();
    const { wt, branch } = await ticketBranch("T-4");
    const id = await pr.open("T-4", wt, branch);
    await writeFile(join(wt, "T-4b.txt"), "again\n");
    await commitAll(wt, "resubmit");
    expect(await pr.merge(id, INTEGRATION_BRANCH)).toMatchObject({ merged: true });
    expect(await rev(bare, `refs/heads/${branch}`)).toBe(await rev(wt, "HEAD"));
  });

  it("GitHub 405：返回 conflict，conflicted_files 由本地 merge-tree 算；不上报", async () => {
    await pr.openIntegration();
    const a = await ticketBranch("T-5", "a.txt", "A\n");
    const b = await ticketBranch("T-6", "a.txt", "B\n");
    const idA = await pr.open("T-5", a.wt, a.branch);
    const idB = await pr.open("T-6", b.wt, b.branch);
    await pr.merge(idA, INTEGRATION_BRANCH);
    const before = await rev(bare, `refs/heads/${INTEGRATION_BRANCH}`);
    const r = await pr.merge(idB, INTEGRATION_BRANCH);
    expect(r).toEqual({ merged: false, conflict: true, conflicted_files: ["a.txt"] });
    expect(await rev(bare, `refs/heads/${INTEGRATION_BRANCH}`)).toBe(before);
    expect((await store.get(idB))?.status).toBe("conflict");
    expect(events).toEqual([]);
  });

  it("target 与 GitHub PR 的 base 不一致时抛错", async () => {
    await pr.openIntegration();
    const { wt, branch } = await ticketBranch("T-7");
    const id = await pr.open("T-7", wt, branch);
    await expect(pr.merge(id, "main")).rejects.toThrow(/base/);
  });
});

describe("checks", () => {
  it("check-runs 映射为 CheckResult，按当前 head 查询", async () => {
    await integrationAhead();
    const iid = await pr.openIntegration();
    gh.checkRuns = [
      { name: "build", status: "completed", conclusion: "success", html_url: "https://x/1" },
      { name: "lint", status: "in_progress", conclusion: null },
      { name: "e2e", status: "waiting", conclusion: null },
      { name: "deploy", status: "completed", conclusion: "action_required" },
    ];
    const res = await pr.checks(iid);
    expect(res).toEqual([
      { name: "build", status: "completed", conclusion: "success", url: "https://x/1" },
      { name: "lint", status: "in_progress", conclusion: null },
      { name: "e2e", status: "queued", conclusion: null },
      { name: "deploy", status: "completed", conclusion: "failure" },
    ]);
    const head = await rev(repo, INTEGRATION_BRANCH);
    expect(gh.calls.at(-1)!.path).toBe(`/commits/${head}/status?per_page=100&page=1`);
    expect(gh.calls.some((c) => c.path === `/commits/${head}/check-runs?per_page=100&page=1`)).toBe(
      true,
    );
  });
});

describe("sync", () => {
  it("用户在 GitHub 手动合并：同步为 merged，记差异日志，不上报", async () => {
    await integrationAhead();
    const iid = await pr.openIntegration();
    gh.pulls[0]!.state = "closed";
    gh.pulls[0]!.merged = true;
    gh.pulls[0]!.merge_commit_sha = "abc1234";
    expect(await pr.sync()).toEqual([
      { pr_id: iid, from: "open", to: "merged", merge_sha: "abc1234" },
    ]);
    expect(await store.get(iid)).toMatchObject({
      status: "merged",
      merged_into: "main",
      merge_sha: "abc1234",
    });
    expect(logs.some((l) => l.includes(iid) && l.includes("手动合并"))).toBe(true);
    expect(events).toEqual([]);
    expect(await pr.sync()).toEqual([]);
  });

  it("手动合并但 GitHub 没给 merge_commit_sha：SyncChange 不带 merge_sha（T-046）", async () => {
    await integrationAhead();
    const iid = await pr.openIntegration();
    gh.pulls[0]!.state = "closed";
    gh.pulls[0]!.merged = true;
    gh.pulls[0]!.merge_commit_sha = null;
    const changes = await pr.sync();
    expect(changes).toEqual([{ pr_id: iid, from: "open", to: "merged" }]);
    expect("merge_sha" in changes[0]!).toBe(false);
  });

  it("用户在 GitHub 手动关闭未合并：同步为 closed，发 escalated(github_manual)", async () => {
    const { branch, id } = await ticketPr("T-8", { from: "main" });
    gh.pulls.find((p) => p.head === branch)!.state = "closed";
    expect(await pr.sync()).toEqual([{ pr_id: id, from: "open", to: "closed" }]);
    expect((await store.get(id))?.status).toBe("closed");
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(EscalatedSchema.omit({ seq: true }).safeParse(e).success).toBe(true);
    expect(e).toMatchObject({
      type: "escalated",
      requirement_id: "R-1",
      ticket_id: "T-8",
      payload: { reason: "github_manual" },
    });
    expect(e.payload.detail).toContain("#");
    expect(e.payload.detail).toContain("用户在 GitHub 手动关闭");
    expect(e.payload).not.toHaveProperty("resubmit_counts");
  });
});

describe("鉴权失败与 token 不泄露", () => {
  it("401：发 escalated(github_manual)，detail 带状态和接口名，抛 GithubAuthError，不退回本地", async () => {
    gh.override = (method, path) =>
      method === "GET" && path === "/pulls"
        ? new Response(JSON.stringify({ message: `Bad credentials ${TOKEN}` }), { status: 401 })
        : undefined;
    await integrationAhead();
    const err = await pr.openIntegration().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubAuthError);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ reason: "github_manual" });
    expect(events[0]!.payload.detail).toContain("401");
    expect(events[0]!.payload.detail).toContain("GET /pulls");
    expect(events[0]!.ticket_id).toBeNull();
    expect(gh.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("错误消息、日志、事件、git 配置里都不含 token", async () => {
    const seen: string[] = [];
    // 500 响应把 token 回显到 message 里
    gh.override = (method, path) =>
      method === "POST" && path === "/pulls"
        ? new Response(JSON.stringify({ message: `boom ${TOKEN}` }), { status: 500 })
        : undefined;
    await integrationAhead();
    const e1 = await pr.openIntegration().catch((e: unknown) => e as Error);
    seen.push(String(e1), e1 instanceof Error ? (e1.stack ?? "") : "");
    // 网络错误里带 token
    const p2 = provider({
      fetch: () => Promise.reject(new Error(`ECONNRESET ${TOKEN}`)),
    });
    const e2 = await p2.checks((await store.list())[0]!.pr_id).catch((e: unknown) => e as Error);
    seen.push(String(e2));
    // 403：给记录挂上 remote，让 sync 真的去请求
    const rec = (await store.list())[0]!;
    await store.put({
      ...rec,
      remote: { number: 9, url: "https://github.com/acme/widget/pull/9" },
    });
    gh.override = () => new Response("{}", { status: 403 });
    const e3 = await pr.sync().catch((e: unknown) => e as Error);
    expect(e3).toBeInstanceOf(GithubAuthError);
    seen.push(String(e3));
    expect(seen.join("\n")).toMatch(/HTTP 500/);
    expect(seen.join("\n")).toMatch(/ECONNRESET/);
    seen.push(JSON.stringify(events), logs.join("\n"), JSON.stringify(await store.list()));
    seen.push(await readFile(join(repo, ".git", "config"), "utf8"));
    seen.push(await readFile(join(bare, "config"), "utf8"));
    for (const s of seen) expect(s).not.toContain(TOKEN);
  });
});

describe("记录缺 kind", () => {
  it("store 里读到没有 kind 的记录直接抛 InvalidPrRecordError（本地和 GitHub 实现）", async () => {
    const bad = {
      pr_id: "legacy-1",
      branch: "b",
      base_branch: "main",
      base_sha: "x",
      head_sha: "y",
      status: "open",
      created_ts: "t",
      updated_ts: "t",
      repo_path: repo,
    } as unknown as PrRecord;
    await store.put(bad);
    const local = new LocalPrProvider({ store, repo });
    await expect(local.diff("legacy-1")).rejects.toBeInstanceOf(InvalidPrRecordError);
    await expect(local.merge("legacy-1", "main")).rejects.toBeInstanceOf(InvalidPrRecordError);
    await expect(local.openIntegration()).rejects.toBeInstanceOf(InvalidPrRecordError);
    await expect(pr.checks("legacy-1")).rejects.toBeInstanceOf(InvalidPrRecordError);
    await expect(pr.sync()).rejects.toBeInstanceOf(InvalidPrRecordError);
  });
});

vi.setConfig({ testTimeout: 20_000 });

describe("merge 前推送：只推本单分支，不强推", () => {
  it("远程分支已分叉：发 escalated(github_manual)，抛 GithubBranchDivergedError，不调合并接口", async () => {
    await pr.openIntegration();
    const { wt, branch, id } = await ticketPr("T-20");
    // 有人直接往远程工作分支推了别的提交
    const remoteHead = await rev(bare, `refs/heads/${branch}`);
    const tree = await rev(bare, `${remoteHead}^{tree}`);
    const other = (
      await git(bare, ["commit-tree", tree, "-p", remoteHead, "-m", "someone else"], { env: ENV })
    ).stdout.trim();
    await git(bare, ["update-ref", `refs/heads/${branch}`, other, remoteHead]);
    await writeFile(join(wt, "local.txt"), "local\n");
    await commitAll(wt, "local resubmit");

    await expect(pr.merge(id, INTEGRATION_BRANCH)).rejects.toBeInstanceOf(
      GithubBranchDivergedError,
    );
    expect(await rev(bare, `refs/heads/${branch}`)).toBe(other);
    expect(gh.calls.some((c) => c.method === "PUT")).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.reason).toBe("github_manual");
    expect(events[0]!.payload.detail).toContain("分叉");
    expect(events[0]!.payload.detail).toContain(branch);
    expect((await store.get(id))?.status).toBe("open");
  });
});

describe("405 区分冲突与 merge_blocked", () => {
  it("本地无冲突文件：返回 merge_blocked，6 不上报，记录状态不变，detail 带脱敏后的 message", async () => {
    await pr.openIntegration();
    const { wt, branch } = await ticketBranch("T-21");
    const id = await pr.open("T-21", wt, branch);
    gh.override = (method, path) =>
      method === "PUT" && path.endsWith("/merge")
        ? new Response(
            JSON.stringify({ message: `Required status check "ci" is expected. ${TOKEN}` }),
            { status: 405 },
          )
        : undefined;
    const r = await pr.merge(id, INTEGRATION_BRANCH);
    expect(r).toMatchObject({ merged: false, conflict: false, reason: "merge_blocked" });
    if (r.merged || r.conflict || r.reason !== "merge_blocked") throw new Error("unreachable");
    expect(r.detail).toContain('Required status check "ci" is expected.');
    expect(r.detail).not.toContain(TOKEN);
    expect(r).not.toHaveProperty("conflicted_files");
    expect(events).toEqual([]);
    expect((await store.get(id))?.status).toBe("open");
  });
});

describe("限流", () => {
  const NOW = new Date("2026-10-17T06:00:00.000Z");
  it("403 + x-ratelimit-remaining: 0：抛可重试的 GithubRateLimitError（按 reset 算等待），不重试不上报", async () => {
    const p = provider({ now: () => NOW });
    await integrationAhead();
    const reset = Math.floor(NOW.getTime() / 1000) + 30;
    gh.override = () =>
      new Response("{}", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
      });
    const err = (await p.openIntegration().catch((e: unknown) => e)) as GithubRateLimitError;
    expect(err).toBeInstanceOf(GithubRateLimitError);
    expect(err).not.toBeInstanceOf(GithubAuthError);
    expect(err.retryable).toBe(true);
    expect(err.retry_after_ms).toBe(31_000);
    expect(gh.calls).toHaveLength(1);
    expect(events).toEqual([]);
  });
  it("retry-after 优先；没有可用头时用默认值", async () => {
    await integrationAhead();
    gh.override = () => new Response("{}", { status: 403, headers: { "retry-after": "7" } });
    const e1 = (await pr.openIntegration().catch((e: unknown) => e)) as GithubRateLimitError;
    expect(e1.retry_after_ms).toBe(7_000);
    gh.override = () => new Response("{}", { status: 429 });
    const e2 = (await pr.openIntegration().catch((e: unknown) => e)) as GithubRateLimitError;
    expect(e2).toBeInstanceOf(GithubRateLimitError);
    expect(e2.retry_after_ms).toBe(60_000);
    expect(events).toEqual([]);
  });
  it("不是限流的 403（remaining 非 0、无 retry-after）：按鉴权失败上报", async () => {
    await integrationAhead();
    gh.override = () =>
      new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "4999" } });
    const err = await pr.openIntegration().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubAuthError);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.detail).toContain("鉴权失败");
    expect(events[0]!.payload.detail).not.toContain("rate_limit");
  });
});

describe("push / 开 PR 失败后补做", () => {
  it("commitWorktree 时 push 失败：本地提交保留、抛错；下一次 commitWorktree 补推并开 PR", async () => {
    await pr.openIntegration();
    const branch = "feat/T-22";
    const wt = join(root, "wt-T-22");
    await git(repo, ["worktree", "add", "-q", "-b", branch, wt, INTEGRATION_BRANCH]);
    const id = await pr.open("T-22", wt, branch);
    await writeFile(join(wt, "T-22.txt"), "x\n");
    await git(repo, ["remote", "set-url", "origin", join(root, "nope.git")]);
    await expect(pr.commitWorktree("T-22", wt)).rejects.toThrow();
    await git(repo, ["remote", "set-url", "origin", bare]);
    const first = await rev(wt, "HEAD");
    expect((await git(wt, ["log", "-1", "--format=%s"])).stdout).toContain("T-22");
    expect(await remoteHas(`refs/heads/${branch}`)).toBe(false);
    expect((await store.get(id))?.remote).toBeUndefined();

    await writeFile(join(wt, "T-22b.txt"), "y\n");
    const second = await pr.commitWorktree("T-22", wt);
    expect((await git(wt, ["rev-parse", `${second}^`])).stdout.trim()).toBe(first);
    expect(await rev(bare, `refs/heads/${branch}`)).toBe(second);
    expect((await store.get(id))?.remote?.number).toBe(pullOf(branch)!.number);
  });

  it("commitWorktree 时 push 失败：merge 时补推、补开 PR 后合并", async () => {
    await pr.openIntegration();
    const branch = "feat/T-25";
    const wt = join(root, "wt-T-25");
    await git(repo, ["worktree", "add", "-q", "-b", branch, wt, INTEGRATION_BRANCH]);
    const id = await pr.open("T-25", wt, branch);
    await writeFile(join(wt, "T-25.txt"), "x\n");
    await git(repo, ["remote", "set-url", "origin", join(root, "nope.git")]);
    await expect(pr.commitWorktree("T-25", wt)).rejects.toThrow();
    await git(repo, ["remote", "set-url", "origin", bare]);
    expect(await pr.merge(id, INTEGRATION_BRANCH)).toMatchObject({ merged: true });
    expect(gh.pulls.filter((p) => p.head === branch)).toHaveLength(1);
  });

  it("开 PR 失败（GitHub 其实已建好）：本地提交和远程分支都在；补开时复用同名 PR，不开第二个", async () => {
    await pr.openIntegration();
    const branch = "feat/T-23";
    const wt = join(root, "wt-T-23");
    await git(repo, ["worktree", "add", "-q", "-b", branch, wt, INTEGRATION_BRANCH]);
    const id = await pr.open("T-23", wt, branch);
    let n = 0;
    gh.override = (method, path) => {
      if (method === "POST" && path === "/pulls" && n++ === 0) {
        // GitHub 建好了 PR，但客户端拿到的是 502
        gh.pulls.push({
          number: gh.pulls.length + 1,
          head: branch,
          base: INTEGRATION_BRANCH,
          state: "open",
          merged: false,
          merge_commit_sha: null,
        });
        return new Response("{}", { status: 502 });
      }
      // 第一次补开后的合并也失败一次，逼出第二次补开路径
      if (method === "PUT" && path.endsWith("/merge") && n === 1) {
        n++;
        return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
      }
      return undefined;
    };
    await writeFile(join(wt, "T-23.txt"), "x\n");
    await expect(pr.commitWorktree("T-23", wt)).rejects.toThrow(/502/);
    expect(await rev(bare, `refs/heads/${branch}`)).toBe(await rev(wt, "HEAD"));
    await expect(pr.merge(id, INTEGRATION_BRANCH)).rejects.toThrow(/500/);
    expect(await pr.merge(id, INTEGRATION_BRANCH)).toMatchObject({ merged: true });
    expect(gh.pulls.filter((p) => p.head === branch)).toHaveLength(1);
    expect(posts().filter((c) => (c.body as { head?: string }).head === branch)).toHaveLength(1);
  });

  it("开 PR 失败（GitHub 没建）：下一次 commitWorktree 补开新建一个 PR", async () => {
    await pr.openIntegration();
    const branch = "feat/T-24";
    const wt = join(root, "wt-T-24");
    await git(repo, ["worktree", "add", "-q", "-b", branch, wt, INTEGRATION_BRANCH]);
    const id = await pr.open("T-24", wt, branch);
    let failed = false;
    gh.override = (method, path) => {
      if (method === "POST" && path === "/pulls" && !failed) {
        failed = true;
        return new Response(JSON.stringify({ message: "Server Error" }), { status: 500 });
      }
      return undefined;
    };
    await writeFile(join(wt, "T-24.txt"), "x\n");
    await expect(pr.commitWorktree("T-24", wt)).rejects.toThrow(/500/);
    await writeFile(join(wt, "T-24b.txt"), "y\n");
    await pr.commitWorktree("T-24", wt);
    expect(gh.pulls.filter((p) => p.head === branch)).toHaveLength(1);
    expect((await store.get(id))?.remote?.number).toBe(pullOf(branch)!.number);
    expect(await pr.merge(id, INTEGRATION_BRANCH)).toMatchObject({ merged: true });
  });

  it("还没有任何提交的记录：merge / checks 不开 PR、不会 422，merge 报清楚的错", async () => {
    const iid = await pr.openIntegration();
    const branch = "feat/T-26";
    const wt = join(root, "wt-T-26");
    await git(repo, ["worktree", "add", "-q", "-b", branch, wt, INTEGRATION_BRANCH]);
    const id = await pr.open("T-26", wt, branch);
    await expect(pr.merge(id, INTEGRATION_BRANCH)).rejects.toThrow(/没有新提交/);
    await expect(pr.merge(iid, "main")).rejects.toThrow(/没有新提交/);
    expect(await pr.checks(id)).toEqual([]);
    expect(posts()).toEqual([]);
    expect(await remoteHas(`refs/heads/${branch}`)).toBe(false);
    expect(gh.calls.some((c) => c.method === "PUT")).toBe(false);
  });
});

describe("评审读 CI 用 push 之后的 head sha", () => {
  it("commitWorktree 推上去的提交就是 checks 查询的 sha；复投后查新 sha", async () => {
    await pr.openIntegration();
    const { wt, id, sha, branch } = await ticketPr("T-27");
    await pr.checks(id);
    expect(gh.calls.some((c) => c.path === `/commits/${sha}/check-runs?per_page=100&page=1`)).toBe(
      true,
    );
    expect(gh.calls.at(-1)!.path).toBe(`/commits/${sha}/status?per_page=100&page=1`);
    expect(await rev(bare, `refs/heads/${branch}`)).toBe(sha);

    await writeFile(join(wt, "T-27b.txt"), "b\n");
    const sha2 = await pr.commitWorktree("T-27", wt);
    await pr.checks(id);
    expect(gh.calls.some((c) => c.path === `/commits/${sha2}/check-runs?per_page=100&page=1`)).toBe(
      true,
    );
    expect(gh.calls.at(-1)!.path).toBe(`/commits/${sha2}/status?per_page=100&page=1`);
  });

  it("上次 push 失败、远程落后：checks 先补推本单分支（并补开 PR）再按新 sha 查；补推失败就抛错，不拿远程没有的 sha 去查", async () => {
    await pr.openIntegration();
    const branch = "feat/T-28";
    const wt = join(root, "wt-T-28");
    await git(repo, ["worktree", "add", "-q", "-b", branch, wt, INTEGRATION_BRANCH]);
    const id = await pr.open("T-28", wt, branch);
    await writeFile(join(wt, "T-28.txt"), "x\n");
    await git(repo, ["remote", "set-url", "origin", join(root, "nope.git")]);
    await expect(pr.commitWorktree("T-28", wt)).rejects.toThrow();
    const local = await rev(wt, "HEAD");
    // 远程还连不上：checks 抛错，不发 check-runs 请求
    await expect(pr.checks(id)).rejects.toThrow();
    expect(gh.calls.some((c) => c.path.includes("/check-runs"))).toBe(false);

    await git(repo, ["remote", "set-url", "origin", bare]);
    await pr.checks(id);
    expect(await rev(bare, `refs/heads/${branch}`)).toBe(local);
    expect(
      gh.calls.some((c) => c.path === `/commits/${local}/check-runs?per_page=100&page=1`),
    ).toBe(true);
    expect(gh.calls.at(-1)!.path).toBe(`/commits/${local}/status?per_page=100&page=1`);
    expect((await store.get(id))?.remote).toBeDefined();
  });
});

describe("close（GitHub）", () => {
  it("有 remote：PATCH state=closed 关远程 PR，本地写 closed_by，不上报；sync 不当成用户关闭", async () => {
    await integrationAhead();
    const iid = await pr.openIntegration();
    const { id } = await ticketPr("T-30");
    await pr.close(id, "需求取消");
    const patch = gh.calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe("/pulls/2");
    expect(patch.body).toEqual({ state: "closed" });
    expect(gh.pulls[1]!.state).toBe("closed");
    expect(await store.get(id)).toMatchObject({
      status: "closed",
      closed_by: "bakacoding",
      close_reason: "需求取消",
    });
    // 用户同时在 GitHub 上手动关了集成 PR：只有这一条上报
    gh.pulls[0]!.state = "closed";
    expect(await pr.sync()).toEqual([{ pr_id: iid, from: "open", to: "closed" }]);
    expect(events).toHaveLength(1);
    expect(events[0]!.ticket_id).toBeNull();
    expect(events[0]!.payload.detail).toContain("用户在 GitHub 手动关闭");
  });

  it("sync 请求期间 close() 已把记录关掉：不上报", async () => {
    const { branch, id } = await ticketPr("T-31", { from: "main" });
    const real = gh.fetch;
    const p = provider({
      fetch: async (input, init) => {
        const res = await real(input, init);
        if ((init?.method ?? "GET") === "GET" && /\/pulls\/\d+$/.test(String(input))) {
          // 模拟：sync 拿到「已关闭」之前，BakaCoding 刚刚 close 了它
          const rec = (await store.get(id))!;
          await store.put({ ...rec, status: "closed", closed_by: "bakacoding", close_reason: "x" });
          gh.pulls.find((q) => q.head === branch)!.state = "closed";
          return real(input, init);
        }
        return res;
      },
    });
    expect(await p.sync()).toEqual([]);
    expect(events).toEqual([]);
  });

  it("重复 close 幂等；远程关闭失败后重试会再 PATCH；用户关的不再 PATCH", async () => {
    const { branch, id } = await ticketPr("T-32", { from: "main" });
    let fail = true;
    gh.override = (method) =>
      method === "PATCH" && fail ? new Response("{}", { status: 500 }) : undefined;
    await expect(pr.close(id, "r")).rejects.toThrow(/500/);
    expect(await store.get(id)).toMatchObject({ status: "closed", closed_by: "bakacoding" });
    fail = false;
    await pr.close(id, "r");
    expect(gh.pulls.find((q) => q.head === branch)!.state).toBe("closed");
    expect(events).toEqual([]);

    // 用户在 GitHub 手动关的记录：close 幂等、不发请求
    const other = await ticketPr("T-33", { from: "main" });
    const id2 = other.id;
    gh.pulls.find((q) => q.head === other.branch)!.state = "closed";
    await pr.sync();
    const n = gh.calls.length;
    await pr.close(id2, "r");
    expect(gh.calls.length).toBe(n);
    expect((await store.get(id2))?.closed_by).toBeUndefined();
  });

  it("没有 remote 的记录只改本地；已 merged 抛错；限流照旧抛 GithubRateLimitError", async () => {
    await integrationAhead();
    const iid = await pr.openIntegration();
    const { id } = await ticketPr("T-34");
    await pr.merge(id, INTEGRATION_BRANCH);
    await expect(pr.close(id, "x")).rejects.toThrow(/已合并/);

    const rec = (await store.get(iid))!;
    const { remote: _r, ...noRemote } = rec;
    void _r;
    await store.put(noRemote as PrRecord);
    const n = gh.calls.length;
    await pr.close(iid, "重建");
    expect(gh.calls.length).toBe(n);
    expect((await store.get(iid))?.status).toBe("closed");

    const { id: id3 } = await ticketPr("T-35", { from: "main" });
    gh.override = () => new Response("{}", { status: 403, headers: { "retry-after": "3" } });
    const err = (await pr.close(id3, "r").catch((e: unknown) => e)) as GithubRateLimitError;
    expect(err).toBeInstanceOf(GithubRateLimitError);
    expect(err.retry_after_ms).toBe(3000);
    expect(events).toEqual([]);
  });

  it("commitWorktree 本地提交交给内部本地实现，返回新 sha", async () => {
    const { wt, sha } = await ticketPr("T-36", { from: "main" });
    expect(sha).toBe(await rev(wt, "HEAD"));
  });
});

describe("GitHub merge 返回 409", () => {
  const resp409 = (method: string, path: string) =>
    method === "PUT" && path.endsWith("/merge")
      ? new Response(JSON.stringify({ message: "Head branch was modified." }), { status: 409 })
      : undefined;
  it("本地 merge-tree 有冲突文件：按冲突返回，不上报", async () => {
    await pr.openIntegration();
    const a = await ticketBranch("T-40", "a.txt", "A\n");
    const b = await ticketBranch("T-41", "a.txt", "B\n");
    await pr.merge(await pr.open("T-40", a.wt, a.branch), INTEGRATION_BRANCH);
    const idB = await pr.open("T-41", b.wt, b.branch);
    gh.override = resp409;
    expect(await pr.merge(idB, INTEGRATION_BRANCH)).toEqual({
      merged: false,
      conflict: true,
      conflicted_files: ["a.txt"],
    });
    expect(events).toEqual([]);
  });
  it("本地无冲突文件：返回 merge_blocked，记录状态不变，不上报", async () => {
    await pr.openIntegration();
    const { wt, branch } = await ticketBranch("T-42");
    const id = await pr.open("T-42", wt, branch);
    gh.override = resp409;
    const r = await pr.merge(id, INTEGRATION_BRANCH);
    expect(r).toMatchObject({ merged: false, conflict: false, reason: "merge_blocked" });
    expect(JSON.stringify(r)).toContain("HTTP 409");
    expect(JSON.stringify(r)).toContain("Head branch was modified.");
    expect((await store.get(id))?.status).toBe("open");
    expect(events).toEqual([]);
  });
});

describe("T-066 sync 中途出错仍带回已收集变化（B1）", () => {
  it("第一条已同步为 merged 后第二条限流：抛 SyncPartialError，带上已收集变化", async () => {
    await integrationAhead();
    const iid = await pr.openIntegration();
    const { id: id2 } = await ticketPr("T-66a");
    gh.pulls[0]!.state = "closed";
    gh.pulls[0]!.merged = true;
    gh.pulls[0]!.merge_commit_sha = "a".repeat(40);
    let n = 0;
    gh.override = (method, path) => {
      if (method === "GET" && /^\/pulls\/\d+$/.test(path)) {
        n++;
        if (n >= 2) return new Response("{}", { status: 403, headers: { "retry-after": "2" } });
      }
      return undefined;
    };
    const err = (await pr.sync().catch((e: unknown) => e)) as SyncPartialError;
    expect(err).toBeInstanceOf(SyncPartialError);
    expect(err.changes).toEqual([
      { pr_id: iid, from: "open", to: "merged", merge_sha: "a".repeat(40) },
    ]);
    expect(err.cause).toBeInstanceOf(GithubRateLimitError);
    expect((await store.get(iid))?.status).toBe("merged");
    // id2 仍 open（第二条请求失败）
    expect((await store.get(id2))?.status).toBe("open");
  });

  it("反向：丢掉已收集变化时本用例失败（changes 必须非空）", async () => {
    await integrationAhead();
    await pr.openIntegration();
    const { id: id2 } = await ticketPr("T-66b");
    void id2;
    gh.pulls[0]!.state = "closed";
    gh.pulls[0]!.merged = true;
    gh.pulls[0]!.merge_commit_sha = "b".repeat(40);
    let n = 0;
    gh.override = (method, path) => {
      if (method === "GET" && /^\/pulls\/\d+$/.test(path)) {
        n++;
        if (n >= 2) return new Response("{}", { status: 500 });
      }
      return undefined;
    };
    const err = (await pr.sync().catch((e: unknown) => e)) as SyncPartialError;
    expect(err).toBeInstanceOf(SyncPartialError);
    expect(err.changes.length).toBeGreaterThan(0);
  });

  it("用户手动关闭后 escalate 抛错：这条 closed 变化仍在 SyncPartialError.changes 里", async () => {
    const boom = new Error("publish 失败");
    pr = provider({
      publish: () => {
        throw boom;
      },
    });
    const { branch, id } = await ticketPr("T-66h", { from: "main" });
    gh.pulls.find((p) => p.head === branch)!.state = "closed";
    const err = (await pr.sync().catch((e: unknown) => e)) as SyncPartialError;
    expect(err).toBeInstanceOf(SyncPartialError);
    expect(err.changes).toEqual([{ pr_id: id, from: "open", to: "closed" }]);
    expect(err.cause).toBe(boom);
    expect((await store.get(id))?.status).toBe("closed");
  });

  it("中途出错但尚未收集到变化：抛原始错误，不是 SyncPartialError", async () => {
    await integrationAhead();
    await pr.openIntegration();
    gh.override = (method, path) =>
      method === "GET" && /^\/pulls\/\d+$/.test(path)
        ? new Response("{}", { status: 403, headers: { "retry-after": "1" } })
        : undefined;
    const err = await pr.sync().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubRateLimitError);
    expect(err).not.toBeInstanceOf(SyncPartialError);
  });
});

describe("T-066 close PATCH 失败时 GET 远程（B4）", () => {
  it("远程已合入：PATCH 失败后 GET，本地改回 merged，抛 PrAlreadyMergedError", async () => {
    const { branch, id } = await ticketPr("T-66c", { from: "main" });
    const pull = gh.pulls.find((p) => p.head === branch)!;
    pull.merged = true;
    pull.state = "closed";
    pull.merge_commit_sha = "c".repeat(40);
    // FakeGithub PATCH on merged returns 422
    await expect(pr.close(id, "拒绝")).rejects.toBeInstanceOf(PrAlreadyMergedError);
    const rec = await store.get(id);
    expect(rec).toMatchObject({ status: "merged", merge_sha: "c".repeat(40) });
    expect(rec).not.toHaveProperty("closed_by");
    expect(gh.calls.some((c) => c.method === "PATCH")).toBe(true);
    expect(gh.calls.some((c) => c.method === "GET" && c.path === `/pulls/${pull.number}`)).toBe(
      true,
    );
  });

  it("远程仍 open：PATCH 500 后本地保持 closed，抛 API 错（可重试）", async () => {
    const { id } = await ticketPr("T-66d", { from: "main" });
    gh.override = (method) =>
      method === "PATCH" ? new Response("{}", { status: 500 }) : undefined;
    await expect(pr.close(id, "r")).rejects.toThrow(/500/);
    expect(await store.get(id)).toMatchObject({ status: "closed", closed_by: "bakacoding" });
  });

  it("远程已关闭但未合入：PATCH 失败后不抛 PrAlreadyMergedError，重抛原错误，本地保持 closed", async () => {
    const { branch, id } = await ticketPr("T-66i", { from: "main" });
    const pull = gh.pulls.find((p) => p.head === branch)!;
    pull.state = "closed";
    pull.merged = false;
    gh.override = (method) =>
      method === "PATCH"
        ? new Response(JSON.stringify({ message: "boom" }), { status: 500 })
        : undefined;
    const err = await pr.close(id, "r").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PrAlreadyMergedError);
    expect(String(err)).toMatch(/500/);
    expect(gh.calls.some((c) => c.method === "GET" && c.path === `/pulls/${pull.number}`)).toBe(
      true,
    );
    const rec = await store.get(id);
    expect(rec).toMatchObject({ status: "closed", closed_by: "bakacoding", close_reason: "r" });
    expect(rec).not.toHaveProperty("merge_sha");
  });

  it("反向：远程已合入却把本地留成 closed 时本用例失败", async () => {
    const { branch, id } = await ticketPr("T-66e", { from: "main" });
    const pull = gh.pulls.find((p) => p.head === branch)!;
    pull.merged = true;
    pull.state = "closed";
    pull.merge_commit_sha = "d".repeat(40);
    await pr.close(id, "x").catch(() => undefined);
    expect((await store.get(id))?.status).not.toBe("closed");
    expect((await store.get(id))?.status).toBe("merged");
  });
});

describe("T-066 merge expected_head（C1）", () => {
  it("expected_head 与当前 HEAD 一致：合并成功，GitHub merge 带该 sha", async () => {
    await pr.openIntegration();
    const { id, sha } = await ticketPr("T-66f");
    const r = await pr.merge(id, INTEGRATION_BRANCH, { expected_head: sha });
    expect(r).toMatchObject({ merged: true });
    const mergeCall = gh.calls.find((c) => c.method === "PUT" && c.path.endsWith("/merge"))!;
    expect(mergeCall.body).toMatchObject({ sha });
  });

  it("expected_head 不一致：抛 ExpectedHeadMismatchError，不调 merge API", async () => {
    await pr.openIntegration();
    const { id } = await ticketPr("T-66g");
    const fake = "e".repeat(40);
    const n = gh.calls.length;
    const err = (await pr
      .merge(id, INTEGRATION_BRANCH, { expected_head: fake })
      .catch((e: unknown) => e)) as ExpectedHeadMismatchError;
    expect(err).toBeInstanceOf(ExpectedHeadMismatchError);
    expect(err.code).toBe("expected_head_mismatch");
    expect(err.expected).toBe(fake);
    expect(err.actual).toMatch(/^[0-9a-f]{40}$/);
    expect(gh.calls.slice(n).some((c) => c.method === "PUT" && c.path.endsWith("/merge"))).toBe(
      false,
    );
    expect((await store.get(id))?.status).toBe("open");
  });
});

describe("T-066 checks 翻页 + commit status（C2）", () => {
  it("check-runs 超过一页（>100）时翻页拉齐，并合并 commit status", async () => {
    await integrationAhead();
    const iid = await pr.openIntegration();
    gh.checkRuns = Array.from({ length: 101 }, (_, i) => ({
      name: `run-${i}`,
      status: "completed",
      conclusion: i === 100 ? "failure" : "success",
    }));
    gh.commitStatuses = [
      { context: "deploy/staging", state: "success", target_url: "https://ci/1" },
      { context: "codecov", state: "pending" },
      { context: "old-ci", state: "error" },
    ];
    const res = await pr.checks(iid);
    expect(res).toHaveLength(104); // 101 check-runs + 3 statuses
    expect(res[100]).toMatchObject({
      name: "run-100",
      status: "completed",
      conclusion: "failure",
    });
    expect(res.find((r) => r.name === "deploy/staging")).toMatchObject({
      status: "completed",
      conclusion: "success",
      url: "https://ci/1",
    });
    expect(res.find((r) => r.name === "codecov")).toMatchObject({
      status: "queued",
      conclusion: null,
    });
    expect(res.find((r) => r.name === "old-ci")).toMatchObject({
      status: "completed",
      conclusion: "failure",
    });
    const head = await rev(repo, INTEGRATION_BRANCH);
    const pages = gh.calls.filter((c) => c.path.startsWith(`/commits/${head}/check-runs`));
    expect(pages.map((c) => c.path)).toEqual([
      `/commits/${head}/check-runs?per_page=100&page=1`,
      `/commits/${head}/check-runs?per_page=100&page=2`,
    ]);
    expect(gh.calls.some((c) => c.path === `/commits/${head}/status?per_page=100&page=1`)).toBe(
      true,
    );
  });

  it("commit status 超过 30 条：按 per_page=100&page=N 翻页取满 total_count，后页的失败不漏", async () => {
    await integrationAhead();
    const iid = await pr.openIntegration();
    gh.commitStatuses = Array.from({ length: 120 }, (_, i) => ({
      context: `ci-${i}`,
      state: i === 110 ? "failure" : "success",
    }));
    const res = await pr.checks(iid);
    expect(res.filter((r) => r.name.startsWith("ci-"))).toHaveLength(120);
    expect(res.find((r) => r.name === "ci-110")).toMatchObject({
      status: "completed",
      conclusion: "failure",
    });
    expect(res.some((r) => r.name === "commit-status (combined)")).toBe(false);
    const head = await rev(repo, INTEGRATION_BRANCH);
    expect(
      gh.calls.filter((c) => c.path.startsWith(`/commits/${head}/status`)).map((c) => c.path),
    ).toEqual([
      `/commits/${head}/status?per_page=100&page=1`,
      `/commits/${head}/status?per_page=100&page=2`,
    ]);
  });

  it("commit status 服务端每页只给 30 条：按 total_count 继续翻页，第 2 页的失败不漏", async () => {
    await integrationAhead();
    const iid = await pr.openIntegration();
    gh.statusPageSize = 30;
    gh.commitStatuses = Array.from({ length: 35 }, (_, i) => ({
      context: `s-${i}`,
      state: i === 33 ? "error" : "success",
    }));
    const res = await pr.checks(iid);
    expect(res.filter((r) => r.name.startsWith("s-"))).toHaveLength(35);
    expect(res.find((r) => r.name === "s-33")).toMatchObject({ conclusion: "failure" });
  });

  it("commit status 超过页数上限仍未取满：抛错，不静默漏掉后面的状态", async () => {
    await integrationAhead();
    const iid = await pr.openIntegration();
    gh.statusPageSize = 1;
    gh.commitStatuses = Array.from({ length: 60 }, (_, i) => ({
      context: `c-${i}`,
      state: "success",
    }));
    await expect(pr.checks(iid)).rejects.toThrow(/超过 50 页/);
  });

  it("顶层 state 为 failure 却没有失败条目：补一条失败结果", async () => {
    await integrationAhead();
    const iid = await pr.openIntegration();
    gh.commitStatuses = [{ context: "ok", state: "success" }];
    gh.commitCombinedState = "failure";
    const res = await pr.checks(iid);
    expect(res.filter((r) => r.conclusion === "failure")).toEqual([
      { name: "commit-status (combined)", status: "completed", conclusion: "failure" },
    ]);
  });

  it("顶层 state 为 success：不补失败结果", async () => {
    await integrationAhead();
    const iid = await pr.openIntegration();
    gh.commitStatuses = [{ context: "ok", state: "success" }];
    const res = await pr.checks(iid);
    expect(res.some((r) => r.conclusion === "failure")).toBe(false);
  });

  it("T-069 check-runs 最后一页正好 100 条：按 total_count 收满即停，只发 2 次请求", async () => {
    await integrationAhead();
    const iid = await pr.openIntegration();
    gh.checkRuns = Array.from({ length: 200 }, (_, i) => ({
      name: `f-${i}`,
      status: "completed",
      conclusion: i === 199 ? "failure" : "success",
    }));
    const res = await pr.checks(iid);
    expect(res.filter((r) => r.name.startsWith("f-"))).toHaveLength(200);
    expect(res.find((r) => r.name === "f-199")).toMatchObject({ conclusion: "failure" });
    const head = await rev(repo, INTEGRATION_BRANCH);
    expect(
      gh.calls.filter((c) => c.path.startsWith(`/commits/${head}/check-runs`)).map((c) => c.path),
    ).toEqual([
      `/commits/${head}/check-runs?per_page=100&page=1`,
      `/commits/${head}/check-runs?per_page=100&page=2`,
    ]);
  });

  it("T-069 check-runs 服务端每页只给 30 条：按 total_count 继续翻页，最后一页的失败不漏", async () => {
    await integrationAhead();
    const iid = await pr.openIntegration();
    gh.checkRunsPageSize = 30;
    gh.checkRuns = Array.from({ length: 75 }, (_, i) => ({
      name: `m-${i}`,
      status: "completed",
      conclusion: i === 74 ? "failure" : "success",
    }));
    const res = await pr.checks(iid);
    expect(res.filter((r) => r.name.startsWith("m-"))).toHaveLength(75);
    expect(res.find((r) => r.name === "m-74")).toMatchObject({
      status: "completed",
      conclusion: "failure",
    });
    const head = await rev(repo, INTEGRATION_BRANCH);
    expect(
      gh.calls.filter((c) => c.path.startsWith(`/commits/${head}/check-runs`)).map((c) => c.path),
    ).toEqual([1, 2, 3].map((n) => `/commits/${head}/check-runs?per_page=100&page=${n}`));
  });

  it("T-069 check-runs 某页为空但没收满 total_count：停止翻页，不死循环", async () => {
    await integrationAhead();
    const iid = await pr.openIntegration();
    // 第 1 页报 total_count 5 却只给 1 条，第 2 页为空（override 在记下本次请求之后调用）
    gh.override = (method, path) => {
      if (method !== "GET" || !path.endsWith("/check-runs")) return undefined;
      const runs = gh.calls.at(-1)!.path.endsWith("page=1")
        ? [{ name: "only", status: "completed", conclusion: "success" }]
        : [];
      return new Response(JSON.stringify({ total_count: 5, check_runs: runs }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const res = await pr.checks(iid);
    expect(res.filter((r) => r.name === "only")).toHaveLength(1);
    const head = await rev(repo, INTEGRATION_BRANCH);
    expect(
      gh.calls.filter((c) => c.path.startsWith(`/commits/${head}/check-runs`)).map((c) => c.path),
    ).toEqual([1, 2].map((n) => `/commits/${head}/check-runs?per_page=100&page=${n}`));
  });

  it("已知缺口 2：check-runs 响应不带 total_count：按已收到的条数算，第 1 页之后不再翻页", async () => {
    await integrationAhead();
    const iid = await pr.openIntegration();
    // 第 1 页不带 total_count；第 2 页若被请求会带一条失败（不该被请求）
    gh.override = (method, path) => {
      if (method !== "GET" || !path.endsWith("/check-runs")) return undefined;
      const runs = gh.calls.at(-1)!.path.endsWith("page=1")
        ? [
            { name: "nt-1", status: "completed", conclusion: "success" },
            { name: "nt-2", status: "in_progress", conclusion: null },
          ]
        : [{ name: "nt-late", status: "completed", conclusion: "failure" }];
      return new Response(JSON.stringify({ check_runs: runs }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const res = await pr.checks(iid);
    expect(res.filter((r) => r.name.startsWith("nt-"))).toEqual([
      { name: "nt-1", status: "completed", conclusion: "success" },
      { name: "nt-2", status: "in_progress", conclusion: null },
    ]);
    const head = await rev(repo, INTEGRATION_BRANCH);
    expect(
      gh.calls.filter((c) => c.path.startsWith(`/commits/${head}/check-runs`)).map((c) => c.path),
    ).toEqual([`/commits/${head}/check-runs?per_page=100&page=1`]);
  });

  it("T-069 check-runs 超过页数上限仍未取满 total_count：抛错", async () => {
    await integrationAhead();
    const iid = await pr.openIntegration();
    gh.checkRunsPageSize = 1;
    gh.checkRuns = Array.from({ length: 60 }, (_, i) => ({
      name: `cap-${i}`,
      status: "completed",
      conclusion: "success",
    }));
    await expect(pr.checks(iid)).rejects.toThrow(/check-runs 超过 50 页/);
  });

  it("反向：只读第一页会漏掉第 101 条 check-run", async () => {
    await integrationAhead();
    const iid = await pr.openIntegration();
    gh.checkRuns = Array.from({ length: 101 }, (_, i) => ({
      name: `p-${i}`,
      status: "completed",
      conclusion: "success",
    }));
    const res = await pr.checks(iid);
    expect(res.filter((r) => r.name.startsWith("p-"))).toHaveLength(101);
    expect(res.some((r) => r.name === "p-100")).toBe(true);
  });
});

describe("merge 重试幂等（T-103）", () => {
  /** 记 merged 时抛一次错，模拟 PUT merge 已成功、merged 还没记时进程中断。 */
  function crashOnceOnMerged() {
    const put = store.put.bind(store);
    let armed = true;
    store.put = (r: PrRecord) => {
      if (armed && r.status === "merged") {
        armed = false;
        return Promise.reject(new Error("模拟中断"));
      }
      return put(r);
    };
  }
  async function crashedMerge(ticket: string) {
    await pr.openIntegration();
    const { wt, branch } = await ticketBranch(ticket);
    const id = await pr.open(ticket, wt, branch);
    const head = await rev(wt, "HEAD");
    crashOnceOnMerged();
    await expect(pr.merge(id, INTEGRATION_BRANCH)).rejects.toThrow("模拟中断");
    const pull = pullOf(branch)!;
    expect(pull.merged).toBe(true);
    expect((await store.get(id))?.status).toBe("open");
    return { id, branch, head, mergeSha: pull.merge_commit_sha! };
  }

  it("远程 PR 已合入：重启后重合直接记已合入，不再推分支、不再 PUT，merge_sha 用 GitHub 的 merge_commit_sha", async () => {
    const { id, branch, head, mergeSha } = await crashedMerge("T-31");
    // GitHub 合入后自动删了 head 分支：重试不能把它推回去
    await git(bare, ["update-ref", "-d", `refs/heads/${branch}`]);
    const remoteInt = await rev(bare, `refs/heads/${INTEGRATION_BRANCH}`);
    expect(remoteInt).toBe(mergeSha);
    const puts = gh.calls.filter((c) => c.method === "PUT").length;

    const r = await provider().merge(id, INTEGRATION_BRANCH);
    expect(r).toEqual({ merged: true, sha: mergeSha, fast_forward: false });
    expect(gh.calls.filter((c) => c.method === "PUT").length).toBe(puts);
    expect(await remoteHas(`refs/heads/${branch}`)).toBe(false);
    expect(await rev(bare, `refs/heads/${INTEGRATION_BRANCH}`)).toBe(remoteInt);
    expect(await rev(repo, INTEGRATION_BRANCH)).toBe(mergeSha);
    expect(await store.get(id)).toMatchObject({
      status: "merged",
      merged_into: INTEGRATION_BRANCH,
      merge_sha: mergeSha,
      head_sha: head,
    });
    expect(events).toEqual([]);
  });

  it("查 PR 时还没合入、PUT 回 405（已合入）：回查后按已合入处理，不返回 merge_blocked", async () => {
    const { id, mergeSha } = await crashedMerge("T-32");
    let gets = 0;
    gh.override = (method, path) => {
      if (method === "GET" && path === "/pulls/1" && gets++ === 0)
        return new Response(
          JSON.stringify({ number: 1, html_url: "u", state: "open", merged: false }),
          { status: 200 },
        );
      if (method === "PUT" && path.endsWith("/merge"))
        return new Response(JSON.stringify({ message: "Pull Request is not mergeable" }), {
          status: 405,
        });
      return undefined;
    };
    const r = await provider().merge(id, INTEGRATION_BRANCH);
    expect(r).toEqual({ merged: true, sha: mergeSha, fast_forward: false });
    expect(gets).toBe(2);
    expect(await rev(repo, INTEGRATION_BRANCH)).toBe(mergeSha);
    expect(await store.get(id)).toMatchObject({ status: "merged", merge_sha: mergeSha });
    expect(events).toEqual([]);
  });
});
