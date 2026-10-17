import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EscalatedSchema } from "@bakacoding/types";
import {
  createPrProvider,
  GithubAuthError,
  GithubBranchDivergedError,
  GithubRateLimitError,
  GithubPrProvider,
  InMemoryPrStore,
  InvalidPrRecordError,
  INTEGRATION_BRANCH,
  LocalPrProvider,
  parseGithubRemote,
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
    if (method === "GET" && /^\/commits\/[0-9a-f]+\/check-runs$/.test(path))
      return json({ total_count: this.checkRuns.length, check_runs: this.checkRuns });
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

describe("open", () => {
  it("远程没有集成分支：本地也没有时从 main 建出并先推上去，再推工作分支、开 PR（base=集成分支）", async () => {
    expect(await remoteHas(`refs/heads/${INTEGRATION_BRANCH}`)).toBe(false);
    // 工作分支从 main 拉（本地此时还没有集成分支）
    const wt = join(root, "wt-T-1");
    await git(repo, ["worktree", "add", "-q", "-b", "feat/T-1", wt, "main"]);
    await writeFile(join(wt, "T-1.txt"), "x\n");
    await commitAll(wt, "T-1");
    const id = await pr.open("T-1", wt, "feat/T-1");

    expect(await rev(repo, INTEGRATION_BRANCH)).toBe(await rev(repo, "main"));
    expect(await remoteHas(`refs/heads/${INTEGRATION_BRANCH}`)).toBe(true);
    expect(await rev(bare, "refs/heads/feat/T-1")).toBe(await rev(wt, "HEAD"));
    const post = gh.calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ head: "feat/T-1", base: INTEGRATION_BRANCH });
    expect(post.auth).toBe(`Bearer ${TOKEN}`);
    expect(await store.get(id)).toMatchObject({
      kind: "ticket",
      status: "open",
      remote: { number: 1, url: "https://github.com/acme/widget/pull/1" },
    });
    // 推送集成分支发生在开 PR 之前（假 GitHub 在 base 不存在时返回 422）
  });

  it("远程已有集成分支：不重复推；openIntegration 开 base=main 的 PR 且幂等", async () => {
    const iid = await pr.openIntegration();
    expect(await remoteHas(`refs/heads/${INTEGRATION_BRANCH}`)).toBe(true);
    expect(gh.pulls[0]).toMatchObject({ head: INTEGRATION_BRANCH, base: "main" });
    expect((await store.get(iid))?.remote?.number).toBe(1);
    expect(await pr.openIntegration()).toBe(iid);
    expect(gh.pulls).toHaveLength(1);

    const { wt, branch } = await ticketBranch("T-2");
    await pr.open("T-2", wt, branch);
    expect(gh.pulls[1]).toMatchObject({ head: branch, base: INTEGRATION_BRANCH });
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
    expect(put.path).toBe("/pulls/2/merge");
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
    expect(gh.calls.at(-1)!.path).toBe(`/commits/${head}/check-runs?per_page=100`);
  });
});

describe("sync", () => {
  it("用户在 GitHub 手动合并：同步为 merged，记差异日志，不上报", async () => {
    const iid = await pr.openIntegration();
    gh.pulls[0]!.state = "closed";
    gh.pulls[0]!.merged = true;
    gh.pulls[0]!.merge_commit_sha = "abc1234";
    expect(await pr.sync()).toEqual([{ pr_id: iid, from: "open", to: "merged" }]);
    expect(await store.get(iid)).toMatchObject({
      status: "merged",
      merged_into: "main",
      merge_sha: "abc1234",
    });
    expect(logs.some((l) => l.includes(iid) && l.includes("手动合并"))).toBe(true);
    expect(events).toEqual([]);
    expect(await pr.sync()).toEqual([]);
  });

  it("用户在 GitHub 手动关闭未合并：同步为 closed，发 escalated(github_manual)", async () => {
    const { wt, branch } = await ticketBranch2("T-8");
    const id = await pr.open("T-8", wt, branch);
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

/** 不预先建集成分支：由 open 负责。 */
async function ticketBranch2(ticket: string) {
  const branch = `feat/${ticket}`;
  const wt = join(root, `wt-${ticket}`);
  await git(repo, ["worktree", "add", "-q", "-b", branch, wt, "main"]);
  await writeFile(join(wt, `${ticket}.txt`), "x\n");
  await commitAll(wt, ticket);
  return { wt, branch };
}

describe("鉴权失败与 token 不泄露", () => {
  it("401：发 escalated(github_manual)，detail 带状态和接口名，抛 GithubAuthError，不退回本地", async () => {
    gh.override = (method, path) =>
      method === "GET" && path === "/pulls"
        ? new Response(JSON.stringify({ message: `Bad credentials ${TOKEN}` }), { status: 401 })
        : undefined;
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
    const { wt, branch } = await ticketBranch("T-20");
    const id = await pr.open("T-20", wt, branch);
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
    gh.override = () =>
      new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "4999" } });
    const err = await pr.openIntegration().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubAuthError);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.detail).toContain("鉴权失败");
    expect(events[0]!.payload.detail).not.toContain("rate_limit");
  });
});

describe("merge 补开中途失败的 PR", () => {
  it("open 时 push 失败：merge 补推、补开 PR、写回 remote 后合并", async () => {
    await pr.openIntegration();
    const { wt, branch } = await ticketBranch("T-22");
    await git(repo, ["remote", "set-url", "origin", join(root, "nope.git")]);
    await expect(pr.open("T-22", wt, branch)).rejects.toThrow();
    await git(repo, ["remote", "set-url", "origin", bare]);
    const id = (await store.list()).find((r) => r.kind === "ticket")!.pr_id;
    expect((await store.get(id))?.remote).toBeUndefined();

    expect(await pr.merge(id, INTEGRATION_BRANCH)).toMatchObject({ merged: true });
    expect(gh.pulls.filter((p) => p.head === branch)).toHaveLength(1);
    expect((await store.get(id))?.remote?.number).toBe(gh.pulls.at(-1)!.number);
  });

  it("开 PR 失败（GitHub 其实已建好）：补开时复用同名 PR，重复补开不开第二个", async () => {
    await pr.openIntegration();
    const { wt, branch } = await ticketBranch("T-23");
    let posts = 0;
    gh.override = (method, path) => {
      if (method === "POST" && path === "/pulls" && posts++ === 0) {
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
      if (method === "PUT" && path.endsWith("/merge") && posts === 1) {
        posts++;
        return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
      }
      return undefined;
    };
    await expect(pr.open("T-23", wt, branch)).rejects.toThrow(/502/);
    const id = (await store.list()).find((r) => r.kind === "ticket")!.pr_id;
    await expect(pr.merge(id, INTEGRATION_BRANCH)).rejects.toThrow(/500/);
    expect(await pr.merge(id, INTEGRATION_BRANCH)).toMatchObject({ merged: true });
    expect(gh.pulls.filter((p) => p.head === branch)).toHaveLength(1);
    const posts23 = gh.calls.filter(
      (c) => c.method === "POST" && (c.body as { head?: string })?.head === branch,
    );
    expect(posts23).toHaveLength(1);
  });

  it("开 PR 失败（GitHub 没建）：补开新建一个 PR", async () => {
    await pr.openIntegration();
    const { wt, branch } = await ticketBranch("T-24");
    let failed = false;
    gh.override = (method, path) => {
      if (method === "POST" && path === "/pulls" && !failed) {
        failed = true;
        return new Response(JSON.stringify({ message: "Server Error" }), { status: 500 });
      }
      return undefined;
    };
    await expect(pr.open("T-24", wt, branch)).rejects.toThrow();
    const id = (await store.list()).find((r) => r.kind === "ticket")!.pr_id;
    expect(await pr.merge(id, INTEGRATION_BRANCH)).toMatchObject({ merged: true });
    expect(gh.pulls.filter((p) => p.head === branch)).toHaveLength(1);
  });
});

describe("close（GitHub）", () => {
  it("有 remote：PATCH state=closed 关远程 PR，本地写 closed_by，不上报；sync 不当成用户关闭", async () => {
    const iid = await pr.openIntegration();
    const { wt, branch } = await ticketBranch("T-30");
    const id = await pr.open("T-30", wt, branch);
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
    const { wt, branch } = await ticketBranch2("T-31");
    const id = await pr.open("T-31", wt, branch);
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
    const { wt, branch } = await ticketBranch2("T-32");
    const id = await pr.open("T-32", wt, branch);
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
    const other = await ticketBranch2("T-33");
    const id2 = await pr.open("T-33", other.wt, other.branch);
    gh.pulls.find((q) => q.head === other.branch)!.state = "closed";
    await pr.sync();
    const n = gh.calls.length;
    await pr.close(id2, "r");
    expect(gh.calls.length).toBe(n);
    expect((await store.get(id2))?.closed_by).toBeUndefined();
  });

  it("没有 remote 的记录只改本地；已 merged 抛错；限流照旧抛 GithubRateLimitError", async () => {
    const iid = await pr.openIntegration();
    const { wt, branch } = await ticketBranch("T-34");
    const id = await pr.open("T-34", wt, branch);
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

    const c = await ticketBranch2("T-35");
    const id3 = await pr.open("T-35", c.wt, c.branch);
    gh.override = () => new Response("{}", { status: 403, headers: { "retry-after": "3" } });
    const err = (await pr.close(id3, "r").catch((e: unknown) => e)) as GithubRateLimitError;
    expect(err).toBeInstanceOf(GithubRateLimitError);
    expect(err.retry_after_ms).toBe(3000);
    expect(events).toEqual([]);
  });

  it("commitWorktree 交给内部本地实现", async () => {
    const { wt, branch } = await ticketBranch2("T-36");
    await pr.open("T-36", wt, branch);
    await writeFile(join(wt, "more.txt"), "m\n");
    const sha = await pr.commitWorktree("T-36", wt);
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
