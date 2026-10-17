import { randomUUID } from "node:crypto";
import { EscalatedSchema, type Diff, type EventOf, type PrStatus } from "@bakacoding/types";
import { git, GitError } from "./git.js";
import { LocalPrProvider, PrNotFoundError, type LocalPrProviderOptions } from "./local.js";
import {
  INTEGRATION_BRANCH,
  type CheckResult,
  type Logger,
  type MergeResult,
  type PrProvider,
  type SyncChange,
} from "./provider.js";
import { assertPrRecord, type PrRecord, type PrStore } from "./store.js";

export type EscalatedEvent = EventOf<"escalated">;
/** 发布入参：seq 由总线分配（与模块 0 的 PublishInput 兼容）。 */
export type EscalatedInput = Omit<EscalatedEvent, "seq" | "event_id" | "ts"> & {
  event_id: string;
  ts: string;
};
/** 发布函数，由调用方注入（通常是事件总线的 publish）。 */
export type PublishEscalated = (event: EscalatedInput) => unknown;

/** 事件公共字段里 6 自己不知道的部分，由调用方按单号 / pr_id 提供。 */
export interface EventContext {
  requirement_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
}
export type EventContextFn = (info: {
  pr_id: string;
  ticket_id: string | null;
}) => EventContext | Promise<EventContext>;

export type FetchFn = typeof fetch;

export interface GithubRepoRef {
  owner: string;
  name: string;
}

export interface GithubPrProviderOptions extends LocalPrProviderOptions {
  /** 集成分支所在仓库，必填（push、fetch、merge-tree 都在这里跑） */
  repo: string;
  github: GithubRepoRef;
  /** 只用于 REST API 的 Authorization 头；git push 用用户自己的 git 凭据 */
  token: string;
  publish: PublishEscalated;
  eventContext: EventContextFn;
  /** 默认全局 fetch */
  fetch?: FetchFn;
  /** 默认 https://api.github.com */
  apiBase?: string;
  /** 默认 console */
  logger?: Logger;
  /** git 远程名，默认 origin */
  remote?: string;
}

/** 响应头里既没有 retry-after 也没有可用的 x-ratelimit-reset 时建议的等待时间 */
export const RATE_LIMIT_DEFAULT_WAIT_MS = 60_000;

/** GitHub 鉴权失败（401/403）。已发 escalated(github_manual)。 */
export class GithubAuthError extends Error {
  constructor(
    readonly status: number,
    readonly op: string,
  ) {
    super(`GitHub 鉴权失败（HTTP ${status}，${op}）`);
    this.name = "GithubAuthError";
  }
}

/**
 * GitHub API 限流（429，或 403 且 x-ratelimit-remaining 为 0 / 带 retry-after）。可重试：
 * 6 不重试、不等待、不上报；重试和连续超限后上报 rate_limit 由 9 负责。
 */
export class GithubRateLimitError extends Error {
  readonly retryable = true as const;
  constructor(
    readonly status: number,
    readonly op: string,
    /** 建议等待毫秒数：取 retry-after，其次 x-ratelimit-reset，都没有用 RATE_LIMIT_DEFAULT_WAIT_MS */
    readonly retry_after_ms: number,
  ) {
    super(`GitHub API 限流（HTTP ${status}，${op}），建议 ${retry_after_ms} ms 后重试`);
    this.name = "GithubRateLimitError";
  }
}

/** 远程工作分支已分叉，不能快进推送（不会强推）。已发 escalated(github_manual)。 */
export class GithubBranchDivergedError extends Error {
  constructor(readonly branch: string) {
    super(`远程分支 ${branch} 已分叉，push 被拒（非快进），未合并`);
    this.name = "GithubBranchDivergedError";
  }
}

export class GithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly op: string,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

/** 解析 github.com 的远程地址（https / ssh / scp 形式）；不是 github.com 返回 null。 */
export function parseGithubRemote(url: string): GithubRepoRef | null {
  const u = url.trim();
  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?(?:www\.)?github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    /^ssh:\/\/(?:[^@/]+@)?(?:ssh\.)?github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    /^(?:[^@/:]+@)?github\.com:\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  ];
  for (const re of patterns) {
    const m = re.exec(u);
    if (m && m[1] && m[2]) return { owner: m[1], name: m[2] };
  }
  return null;
}

const STATUS_MAP: Record<string, CheckResult["status"]> = {
  queued: "queued",
  in_progress: "in_progress",
  completed: "completed",
  waiting: "queued",
  requested: "queued",
  pending: "queued",
};
const CONCLUSION_MAP: Record<string, CheckResult["conclusion"]> = {
  success: "success",
  failure: "failure",
  neutral: "neutral",
  cancelled: "cancelled",
  skipped: "skipped",
  timed_out: "timed_out",
  action_required: "failure",
  stale: "cancelled",
};

interface GhPull {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  base?: { ref: string };
}

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" };

/**
 * GitHub 版 PR 抽象：内部包一个 LocalPrProvider，本地记录为准；
 * GitHub 只是同步展示和合并通道。token 只放在 REST 请求头里。
 */
export class GithubPrProvider implements PrProvider {
  readonly kind = "github" as const;
  private readonly local: LocalPrProvider;
  private readonly store: PrStore;
  private readonly repo: string;
  private readonly gh: GithubRepoRef;
  private readonly token: string;
  private readonly publish: PublishEscalated;
  private readonly eventContext: EventContextFn;
  private readonly fetchFn: FetchFn;
  private readonly apiBase: string;
  private readonly logger: Logger;
  private readonly remote: string;
  private readonly now: () => Date;

  constructor(opts: GithubPrProviderOptions) {
    this.local = new LocalPrProvider(opts);
    this.store = opts.store;
    this.repo = opts.repo;
    this.gh = opts.github;
    this.token = opts.token;
    this.publish = opts.publish;
    this.eventContext = opts.eventContext;
    this.fetchFn = opts.fetch ?? fetch;
    this.apiBase = (opts.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
    this.logger = opts.logger ?? console;
    this.remote = opts.remote ?? "origin";
    this.now = opts.now ?? (() => new Date());
  }

  commitPatch(ticket_id: string, worktree_path: string, patch: string): Promise<string> {
    return this.local.commitPatch(ticket_id, worktree_path, patch);
  }

  diff(pr_id: string): Promise<Diff> {
    return this.local.diff(pr_id);
  }

  async open(ticket_id: string, worktree_path: string, branch: string): Promise<string> {
    const pr_id = await this.local.open(ticket_id, worktree_path, branch);
    await this.ensureRemoteIntegration();
    await this.push(worktree_path, branch);
    await this.attachPull(pr_id, branch, INTEGRATION_BRANCH, ticket_id);
    return pr_id;
  }

  async openIntegration(
    branch: string = INTEGRATION_BRANCH,
    target: string = "main",
  ): Promise<string> {
    const pr_id = await this.local.openIntegration(branch, target);
    const rec = await this.mustGet(pr_id);
    if (rec.remote) return pr_id;
    await this.push(this.repo, branch);
    await this.attachPull(pr_id, branch, target, `集成分支 ${branch} → ${target}`);
    return pr_id;
  }

  async merge(pr_id: string, target: string): Promise<MergeResult> {
    let rec = await this.mustGet(pr_id);
    if (rec.status === "merged" || rec.status === "closed")
      throw new Error(`PR 已${rec.status === "merged" ? "合并" : "关闭"}：${pr_id}`);
    if (!rec.remote) rec = await this.backfillRemote(rec);
    if (!rec.remote) throw new Error(`PR 没有对应的 GitHub PR：${pr_id}`);
    const base = rec.kind === "ticket" ? INTEGRATION_BRANCH : rec.base_branch;
    if (target !== base)
      throw new Error(`GitHub PR #${rec.remote.number} 的 base 是 ${base}，不能合入 ${target}`);
    const cwd = cwdOf(rec);
    const head = await revParse(cwd, rec.branch);
    // 原地复投的新提交只在本地：合并前先推上去（只推本单分支，不强推），再用 sha 校验
    await this.pushForMerge(rec, cwd);

    const op = "PUT /pulls/{n}/merge";
    const res = await this.request(op, rec, "PUT", `/pulls/${rec.remote.number}/merge`, {
      sha: head,
      merge_method: "merge",
    });
    if (res.status === 405 || res.status === 409) {
      const message = await this.responseMessage(res);
      await this.fetchRemote();
      const conflicted_files = await this.conflictedFiles(
        this.repo,
        `${this.remote}/${target}`,
        head,
      );
      if (conflicted_files.length > 0) {
        await this.store.put({ ...rec, status: "conflict", updated_ts: this.now().toISOString() });
        return { merged: false, conflict: true, conflicted_files };
      }
      // 没有文本冲突却被拒：分支保护 / 必需的 check 未通过等，复投解决不了；6 不上报，由 9 上报
      const detail = `GitHub 拒绝合并 PR #${rec.remote.number}（HTTP ${res.status}，${op}），本地无文本冲突，可能是分支保护或必需的 check 未通过${message ? `：${message}` : ""}`;
      return {
        merged: false,
        conflict: false,
        reason: "merge_blocked",
        detail: this.scrub(detail),
      };
    }
    if (!res.ok) throw await this.apiError(op, res);
    const body = (await res.json()) as { sha?: string };
    const oldTarget = await revParse(this.repo, target).catch(() => undefined);
    await this.fetchRemote();
    const sha = body.sha ?? (await revParse(this.repo, `${this.remote}/${target}`));
    await this.advanceLocal(target, `${this.remote}/${target}`);
    const base_sha =
      rec.kind === "integration" && oldTarget
        ? (await git(this.repo, ["merge-base", oldTarget, head])).stdout.trim()
        : rec.base_sha;
    await this.store.put({
      ...rec,
      base_sha,
      head_sha: head,
      status: "merged",
      merged_into: target,
      merge_sha: sha,
      updated_ts: this.now().toISOString(),
    });
    return { merged: true, sha, fast_forward: sha === head };
  }

  async checks(pr_id: string): Promise<CheckResult[]> {
    const rec = await this.mustGet(pr_id);
    const live = rec.status === "open" || rec.status === "conflict";
    const sha = live ? await revParse(cwdOf(rec), rec.branch) : rec.head_sha;
    const op = "GET /commits/{sha}/check-runs";
    const res = await this.request(op, rec, "GET", `/commits/${sha}/check-runs?per_page=100`);
    if (!res.ok) throw await this.apiError(op, res);
    const body = (await res.json()) as {
      check_runs?: { name: string; status: string; conclusion: string | null; html_url?: string }[];
    };
    return (body.check_runs ?? []).map((c) => {
      const r: CheckResult = {
        name: c.name,
        status: STATUS_MAP[c.status] ?? "queued",
        conclusion: c.conclusion === null ? null : (CONCLUSION_MAP[c.conclusion] ?? "neutral"),
      };
      if (c.html_url) r.url = c.html_url;
      return r;
    });
  }

  async sync(): Promise<SyncChange[]> {
    const changes: SyncChange[] = [];
    const records = (await this.store.list()).map(assertPrRecord);
    for (const rec of records) {
      if (!rec.remote || (rec.status !== "open" && rec.status !== "conflict")) continue;
      const op = "GET /pulls/{n}";
      const res = await this.request(op, rec, "GET", `/pulls/${rec.remote.number}`);
      if (!res.ok) throw await this.apiError(op, res);
      const pull = (await res.json()) as GhPull;
      if (pull.state !== "closed") continue;
      const from: PrStatus = rec.status;
      const ts = this.now().toISOString();
      if (pull.merged || pull.merged_at) {
        const merged_into = pull.base?.ref ?? rec.base_branch;
        const next: PrRecord = { ...rec, status: "merged", merged_into, updated_ts: ts };
        if (pull.merge_commit_sha) next.merge_sha = pull.merge_commit_sha;
        await this.store.put(next);
        this.logger.warn(
          `[bakacoding/pr] 同步差异：${rec.pr_id}（GitHub PR #${rec.remote.number}）在 GitHub 上被手动合并，本地 ${from} → merged`,
        );
        changes.push({ pr_id: rec.pr_id, from, to: "merged" });
      } else {
        await this.store.put({ ...rec, status: "closed", updated_ts: ts });
        await this.escalate(rec, `GitHub PR #${rec.remote.number}：用户在 GitHub 手动关闭`);
        changes.push({ pr_id: rec.pr_id, from, to: "closed" });
      }
    }
    return changes;
  }

  // ---- 内部 ----

  /**
   * open / openIntegration 中途失败（push 或开 PR 出错）留下的无 remote 记录：按 open 的逻辑补做
   * push 和开 PR（先查同名 open PR，有就复用），写回 remote。
   */
  private async backfillRemote(rec: PrRecord): Promise<PrRecord> {
    if (rec.kind === "ticket") {
      await this.ensureRemoteIntegration();
      await this.push(rec.worktree_path, rec.branch);
      await this.attachPull(rec.pr_id, rec.branch, INTEGRATION_BRANCH, rec.ticket_id);
    } else {
      await this.push(rec.repo_path, rec.branch);
      await this.attachPull(
        rec.pr_id,
        rec.branch,
        rec.base_branch,
        `集成分支 ${rec.branch} → ${rec.base_branch}`,
      );
    }
    return this.mustGet(rec.pr_id);
  }

  private async attachPull(pr_id: string, head: string, base: string, title: string) {
    const rec = await this.mustGet(pr_id);
    const listOp = "GET /pulls";
    const q = `/pulls?state=open&head=${encodeURIComponent(`${this.gh.owner}:${head}`)}&base=${encodeURIComponent(base)}`;
    const found = await this.request(listOp, rec, "GET", q);
    if (!found.ok) throw await this.apiError(listOp, found);
    let pull = ((await found.json()) as GhPull[])[0];
    if (!pull) {
      const op = "POST /pulls";
      const res = await this.request(op, rec, "POST", "/pulls", {
        title,
        head,
        base,
        body: `由 BakaCoding 创建（${pr_id}）。`,
      });
      if (!res.ok) throw await this.apiError(op, res);
      pull = (await res.json()) as GhPull;
    }
    await this.store.put({
      ...rec,
      remote: { number: pull.number, url: pull.html_url },
      updated_ts: this.now().toISOString(),
    });
  }

  /** 远程没有集成分支时先推上去；本地也没有则按 openIntegration 的规则从 main 建出。 */
  private async ensureRemoteIntegration(): Promise<void> {
    const ref = `refs/heads/${INTEGRATION_BRANCH}`;
    const out = (await git(this.repo, ["ls-remote", "--heads", this.remote, ref], { env: GIT_ENV }))
      .stdout;
    if (out.trim()) return;
    await this.local.ensureBranch(this.repo, INTEGRATION_BRANCH, "main");
    await this.push(this.repo, INTEGRATION_BRANCH);
  }

  /** 合并前推本单分支；远程已分叉（非快进被拒）时上报并抛错，绝不强推。 */
  private async pushForMerge(rec: PrRecord, cwd: string): Promise<void> {
    try {
      await this.push(cwd, rec.branch);
    } catch (err) {
      if (
        err instanceof GitError &&
        /\[rejected\]|non-fast-forward|fetch first|\(stale info\)/i.test(err.stderr)
      ) {
        await this.escalate(
          rec,
          `远程分支 ${rec.branch} 已分叉：合并前 push 被拒（非快进），未强推，未合并 GitHub PR #${rec.remote?.number ?? "?"}`,
        );
        throw new GithubBranchDivergedError(rec.branch);
      }
      throw err;
    }
  }

  private async push(cwd: string, branch: string): Promise<void> {
    await git(cwd, ["push", "-q", this.remote, `refs/heads/${branch}:refs/heads/${branch}`], {
      env: GIT_ENV,
    });
  }

  private async fetchRemote(): Promise<void> {
    await git(this.repo, ["fetch", "-q", this.remote], { env: GIT_ENV });
  }

  /** 把本地分支快进到远端；被 checkout 时只在干净的 worktree 里 ff-only，否则记日志不动。 */
  private async advanceLocal(branch: string, remoteRef: string): Promise<void> {
    const ref = `refs/heads/${branch}`;
    const to = await revParse(this.repo, remoteRef);
    const from = await revParse(this.repo, branch).catch(() => undefined);
    if (from === to) return;
    if (from) {
      const ff =
        (await git(this.repo, ["merge-base", "--is-ancestor", from, to], { allowCodes: [1] }))
          .code === 0;
      if (!ff) {
        this.logger.warn(`[bakacoding/pr] 本地 ${branch} 与远端分叉，未更新本地分支`);
        return;
      }
    }
    const wt = await findCheckout(this.repo, ref);
    if (wt) {
      const dirty = (await git(wt, ["status", "--porcelain", "--untracked-files=no"])).stdout;
      const ok =
        !dirty.trim() &&
        (await git(wt, ["merge", "--ff-only", "-q", to], { allowCodes: [1, 128] })).code === 0;
      if (!ok) this.logger.warn(`[bakacoding/pr] ${branch} 所在 worktree 不干净，未快进本地分支`);
      return;
    }
    await git(this.repo, from ? ["update-ref", ref, to, from] : ["update-ref", ref, to, ""]);
  }

  private async conflictedFiles(cwd: string, target: string, head: string): Promise<string[]> {
    const mt = await git(
      cwd,
      ["merge-tree", "--write-tree", "--name-only", "--no-messages", target, head],
      { allowCodes: [1] },
    );
    return mt.code === 1 ? mt.stdout.split("\n").filter(Boolean).slice(1) : [];
  }

  private async request(
    op: string,
    rec: PrRecord,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = `${this.apiBase}/repos/${encodeURIComponent(this.gh.owner)}/${encodeURIComponent(this.gh.name)}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "bakacoding",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    let res: Response;
    try {
      res = await this.fetchFn(url, init);
    } catch (err) {
      throw new GithubApiError(
        `GitHub API 请求失败（${op}）：${this.scrub(String((err as Error)?.message ?? err))}`,
        null,
        op,
      );
    }
    const wait = this.rateLimitWait(res);
    if (wait !== undefined) throw new GithubRateLimitError(res.status, op, Math.ceil(wait));
    if (res.status === 401 || res.status === 403) {
      await this.escalate(rec, `GitHub API 鉴权失败：HTTP ${res.status}，接口 ${op}`);
      throw new GithubAuthError(res.status, op);
    }
    return res;
  }

  /**
   * 限流判定：429，或 403 且 x-ratelimit-remaining 为 0 / 带 retry-after。
   * 返回等待毫秒数；不是限流返回 undefined。
   */
  private rateLimitWait(res: Response): number | undefined {
    if (res.status !== 403 && res.status !== 429) return undefined;
    const h = res.headers;
    const retryAfter = h.get("retry-after");
    const remaining = h.get("x-ratelimit-remaining");
    const limited = res.status === 429 || remaining?.trim() === "0" || retryAfter !== null;
    if (!limited) return undefined;
    const ra = retryAfter === null ? NaN : Number(retryAfter);
    if (Number.isFinite(ra) && ra >= 0) return ra * 1000;
    const reset = Number(h.get("x-ratelimit-reset"));
    if (h.get("x-ratelimit-reset") !== null && Number.isFinite(reset)) {
      const ms = reset * 1000 - this.now().getTime();
      if (ms > 0) return ms + 1000; // 多等 1 秒，避开时钟误差
    }
    return RATE_LIMIT_DEFAULT_WAIT_MS;
  }

  /** 读 GitHub 响应里的 message（已脱 token，截断到 200 字）；不是 JSON 返回空串。 */
  private async responseMessage(res: Response): Promise<string> {
    try {
      const j = (await res.json()) as { message?: unknown };
      if (typeof j.message === "string") return this.scrub(j.message).slice(0, 200);
    } catch {
      // 响应不是 JSON
    }
    return "";
  }

  private async apiError(op: string, res: Response): Promise<GithubApiError> {
    const m = await this.responseMessage(res);
    const msg = m ? `：${m}` : "";
    return new GithubApiError(`GitHub API 出错（HTTP ${res.status}，${op}）${msg}`, res.status, op);
  }

  private async escalate(rec: PrRecord, detail: string): Promise<void> {
    const ticket_id = rec.kind === "ticket" ? rec.ticket_id : null;
    const ctx = await this.eventContext({ pr_id: rec.pr_id, ticket_id });
    const event = EscalatedSchema.omit({ seq: true }).parse({
      ...ctx,
      event_id: randomUUID(),
      ts: this.now().toISOString(),
      ticket_id,
      type: "escalated",
      payload: { reason: "github_manual", detail: this.scrub(detail) },
    }) as EscalatedInput;
    await this.publish(event);
  }

  private scrub(s: string): string {
    return this.token ? s.split(this.token).join("***") : s;
  }

  private async mustGet(pr_id: string): Promise<PrRecord> {
    const r = await this.store.get(pr_id);
    if (!r) throw new PrNotFoundError(pr_id);
    return assertPrRecord(r);
  }
}

function cwdOf(rec: PrRecord): string {
  return rec.kind === "ticket" ? rec.worktree_path : rec.repo_path;
}

async function revParse(cwd: string, rev: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--verify", `${rev}^{commit}`])).stdout.trim();
}

async function findCheckout(cwd: string, ref: string): Promise<string | undefined> {
  const out = (await git(cwd, ["worktree", "list", "--porcelain"])).stdout;
  let path: string | undefined;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9);
    else if (line === `branch ${ref}`) return path;
  }
  return undefined;
}
