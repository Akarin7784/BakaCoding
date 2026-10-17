import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { EscalatedSchema, type Diff, type EventOf, type PrStatus } from "@bakacoding/types";
import { git, GitError } from "./git.js";
import {
  LocalPrProvider,
  PrAlreadyMergedError,
  PrNotFoundError,
  type GitWriteLock,
  type LocalPrProviderOptions,
} from "./local.js";
import {
  INTEGRATION_BRANCH,
  ExpectedHeadMismatchError,
  SyncPartialError,
  type CheckResult,
  type Logger,
  type MergeResult,
  type PrProvider,
  type SyncChange,
} from "./provider.js";
import { assertPrRecord, type PrRecord, type PrStore, type TicketPrRecord } from "./store.js";

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
/** commit status API 的 state → CheckResult（T-066 C2）。 */
const STATUS_STATE_MAP: Record<
  string,
  { status: CheckResult["status"]; conclusion: CheckResult["conclusion"] }
> = {
  pending: { status: "queued", conclusion: null },
  success: { status: "completed", conclusion: "success" },
  failure: { status: "completed", conclusion: "failure" },
  error: { status: "completed", conclusion: "failure" },
};

/** check-runs / commit status 翻页上限（每页 100 条） */
const MAX_CHECK_PAGES = 50;
/** 顶层 state 为失败但没有失败条目时补的那条结果的名字 */
const COMBINED_STATUS_NAME = "commit-status (combined)";

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
  /** T-094：本地快进 target 那段持 git 写锁（见 LocalPrProviderOptions.gitWriteLock） */
  private readonly gitWriteLock: GitWriteLock;

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
    this.gitWriteLock = opts.gitWriteLock ?? ((fn) => fn());
  }

  commitPatch(ticket_id: string, worktree_path: string, patch: string): Promise<string> {
    return this.local.commitPatch(ticket_id, worktree_path, patch);
  }

  /**
   * 本地提交后只推本单分支（快进，不强推），再开远程 PR（已有就复用）；复投时推新提交，PR 自动更新。
   * push 或开 PR 失败：本地提交保留，抛错；下次 commitWorktree / merge / checks 时补做。
   */
  async commitWorktree(ticket_id: string, worktree_path: string): Promise<string> {
    const sha = await this.local.commitWorktree(ticket_id, worktree_path);
    const rec = await this.openTicketRecord(ticket_id, worktree_path);
    if (rec) await this.publishTicket(rec);
    return sha;
  }

  /**
   * 先把本地记录标成 closed（closed_by: bakacoding），再关远程 PR，这样并发的 sync 不会误报为用户手动关闭。
   * 远程关闭失败时本地已是 closed，重复调用会再试一次 PATCH（GitHub 上关闭已关闭的 PR 无副作用）。
   * T-066 B4：PATCH 失败时 GET 远程；若已合入则改回 merged（清 closed_by），抛 PrAlreadyMergedError，不把合入记成 closed。
   */
  async close(pr_id: string, reason: string): Promise<void> {
    const rec = await this.mustGet(pr_id);
    if (rec.status === "merged") throw new PrAlreadyMergedError(pr_id);
    // 用户在 GitHub 上关的（sync 同步来的）：已是 closed，幂等
    if (rec.status === "closed" && rec.closed_by !== "bakacoding") return;
    let cur = rec;
    if (rec.status !== "closed") {
      cur = {
        ...rec,
        status: "closed",
        closed_by: "bakacoding",
        close_reason: reason,
        updated_ts: this.now().toISOString(),
      };
      await this.store.put(cur);
    }
    if (!cur.remote) return;
    const op = "PATCH /pulls/{n}";
    const res = await this.request(op, cur, "PATCH", `/pulls/${cur.remote.number}`, {
      state: "closed",
    });
    if (!res.ok) {
      await this.recoverMergedAfterCloseFail(cur);
      throw await this.apiError(op, res);
    }
  }

  /** PATCH close 失败后 GET 远程：已合入则本地改回 merged，抛 PrAlreadyMergedError。 */
  private async recoverMergedAfterCloseFail(cur: PrRecord): Promise<void> {
    if (!cur.remote) return;
    const getOp = "GET /pulls/{n}";
    let getRes: Response;
    try {
      getRes = await this.request(getOp, cur, "GET", `/pulls/${cur.remote.number}`);
    } catch {
      return; // GET 也失败（限流等）：保留 closed，让调用方按原错误重试
    }
    if (!getRes.ok) return;
    const pull = (await getRes.json()) as GhPull;
    if (!(pull.merged || pull.merged_at)) return;
    const latest = await this.mustGet(cur.pr_id);
    const {
      closed_by: _cb,
      close_reason: _cr,
      ...rest
    } = latest as PrRecord & {
      closed_by?: string;
      close_reason?: string;
    };
    void _cb;
    void _cr;
    const merged_into = pull.base?.ref ?? latest.base_branch;
    const next: PrRecord = {
      ...rest,
      status: "merged",
      merged_into,
      updated_ts: this.now().toISOString(),
    };
    if (pull.merge_commit_sha) next.merge_sha = pull.merge_commit_sha;
    await this.store.put(next);
    throw new PrAlreadyMergedError(cur.pr_id);
  }

  diff(pr_id: string): Promise<Diff> {
    return this.local.diff(pr_id);
  }

  /**
   * 只建本地记录并确保远程有集成分支；不推工作分支、不开远程 PR（此时分支还没有提交，
   * GitHub 会回 422 No commits between）。远程 PR 在第一次 commitWorktree 之后才有。
   */
  async open(ticket_id: string, worktree_path: string, branch: string): Promise<string> {
    const pr_id = await this.local.open(ticket_id, worktree_path, branch);
    await this.ensureRemoteIntegration();
    return pr_id;
  }

  async openIntegration(
    branch: string = INTEGRATION_BRANCH,
    target: string = "main",
  ): Promise<string> {
    const pr_id = await this.local.openIntegration(branch, target);
    const rec = await this.mustGet(pr_id);
    if (rec.remote) return pr_id;
    // 集成分支要先在远程存在（单张 PR 以它为 base）；比 target 没有新提交时先不开 PR，merge 时补开
    await this.push(this.repo, branch);
    if (await this.hasCommits(this.repo, branch, target))
      await this.attachPull(pr_id, branch, target, `集成分支 ${branch} → ${target}`);
    return pr_id;
  }

  async merge(
    pr_id: string,
    target: string,
    opts?: { expected_head?: string },
  ): Promise<MergeResult> {
    let rec = await this.mustGet(pr_id);
    if (rec.status === "merged" || rec.status === "closed")
      throw new Error(`PR 已${rec.status === "merged" ? "合并" : "关闭"}：${pr_id}`);
    if (!rec.remote) rec = await this.backfillRemote(rec);
    if (!rec.remote)
      throw new Error(
        `PR 还没有对应的 GitHub PR（分支 ${rec.branch} 比 base 没有新提交）：${pr_id}`,
      );
    const base = rec.kind === "ticket" ? INTEGRATION_BRANCH : rec.base_branch;
    if (target !== base)
      throw new Error(`GitHub PR #${rec.remote.number} 的 base 是 ${base}，不能合入 ${target}`);
    const cwd = cwdOf(rec);
    const head = await revParse(cwd, rec.branch);
    if (opts?.expected_head !== undefined && opts.expected_head !== head)
      throw new ExpectedHeadMismatchError(pr_id, opts.expected_head, head);
    // T-103：重试幂等。上次 PUT merge 已成功、但没来得及记 merged（中断、重启后重合）：先查远程 PR，
    // 已合入就直接记已合入，不再推分支（GitHub 可能已自动删了分支，再推会把它建回来）、不再 PUT
    const already = await this.mergedPull(rec);
    if (already) return this.finishMerged(rec, already, target, head);
    // 原地复投的新提交只在本地：合并前先推上去（只推本单分支，不强推），再用 sha 校验
    await this.pushForMerge(rec, cwd);
    // T-066 C1：有 expected_head 时把它作为 GitHub merge 的 sha；否则用当前 HEAD
    const mergeSha = opts?.expected_head ?? head;

    const op = "PUT /pulls/{n}/merge";
    const res = await this.request(op, rec, "PUT", `/pulls/${rec.remote.number}/merge`, {
      sha: mergeSha,
      merge_method: "merge",
    });
    if (res.status === 405 || res.status === 409) {
      const message = await this.responseMessage(res);
      // T-103：GitHub 对已合入的 PR 再 PUT merge 回 405；回查一次，已合入（含查完 PR 到 PUT 之间被合入）按已合入处理
      const merged = await this.mergedPull(rec);
      if (merged) return this.finishMerged(rec, merged, target, head);
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

  /** GET 远程 PR；已合入返回它，未合入（或没有 remote）返回 undefined。限流 / 鉴权照旧抛错。 */
  private async mergedPull(rec: PrRecord): Promise<GhPull | undefined> {
    if (!rec.remote) return undefined;
    const op = "GET /pulls/{n}";
    const res = await this.request(op, rec, "GET", `/pulls/${rec.remote.number}`);
    if (!res.ok) throw await this.apiError(op, res);
    const pull = (await res.json()) as GhPull;
    return pull.merged || pull.merged_at ? pull : undefined;
  }

  /**
   * 远程 PR 已合入（T-103）：fetch、把本地 target 快进到远端（advanceLocal 本身幂等：已一致不动、分叉只记日志），
   * 记 merged。merge_sha 用 GitHub 的 merge_commit_sha，缺省时取远端 target 的 tip。
   */
  private async finishMerged(
    rec: PrRecord,
    pull: GhPull,
    target: string,
    head: string,
  ): Promise<MergeResult> {
    await this.fetchRemote();
    const sha = pull.merge_commit_sha || (await revParse(this.repo, `${this.remote}/${target}`));
    await this.advanceLocal(target, `${this.remote}/${target}`);
    let base_sha = rec.base_sha;
    if (rec.kind === "integration" && sha !== head) {
      const r = await git(this.repo, ["merge-base", `${sha}^1`, head], { allowCodes: [1, 128] });
      if (r.code === 0 && r.stdout.trim()) base_sha = r.stdout.trim();
    }
    await this.store.put({
      ...rec,
      base_sha,
      head_sha: head,
      status: "merged",
      merged_into: pull.base?.ref ?? target,
      merge_sha: sha,
      updated_ts: this.now().toISOString(),
    });
    return { merged: true, sha, fast_forward: sha === head };
  }

  async checks(pr_id: string): Promise<CheckResult[]> {
    const rec = await this.mustGet(pr_id);
    const live = rec.status === "open" || rec.status === "conflict";
    const sha = live ? await revParse(cwdOf(rec), rec.branch) : rec.head_sha;
    // 评审读 CI 要用已推上去的 head：本单分支的本地 HEAD 还没推（上次 push / 开 PR 失败）就先补做，
    // 补做失败直接抛错，不拿远程没有的 sha 去查（查到空结果会被当成没配 CI）
    if (
      live &&
      rec.kind === "ticket" &&
      (!rec.remote || (await this.remoteHead(rec.branch)) !== sha)
    )
      await this.publishTicket(rec);
    const runs = await this.fetchAllCheckRuns(rec, sha);
    const statuses = await this.fetchCommitStatuses(rec, sha);
    return [...runs, ...statuses];
  }

  /**
   * 翻页拉齐全部 check-runs（T-066 C2）。按 per_page=100&page=N 翻页，直到收满 total_count（或某页为空，
   * T-069：不再以「本页不足 100 条」为止，服务端每页给得少时也不漏后页）；最多 MAX_CHECK_PAGES 页，
   * 超出抛错（不静默漏掉后面的失败）。
   */
  private async fetchAllCheckRuns(rec: PrRecord, sha: string): Promise<CheckResult[]> {
    const op = "GET /commits/{sha}/check-runs";
    const out: CheckResult[] = [];
    for (let page = 1; ; page++) {
      if (page > MAX_CHECK_PAGES)
        throw new Error(`${op} 超过 ${MAX_CHECK_PAGES} 页仍未取完：${sha}`);
      const res = await this.request(
        op,
        rec,
        "GET",
        `/commits/${sha}/check-runs?per_page=100&page=${page}`,
      );
      if (!res.ok) throw await this.apiError(op, res);
      const body = (await res.json()) as {
        total_count?: number;
        check_runs?: {
          name: string;
          status: string;
          conclusion: string | null;
          html_url?: string;
        }[];
      };
      const batch = body.check_runs ?? [];
      for (const c of batch) {
        const r: CheckResult = {
          name: c.name,
          status: STATUS_MAP[c.status] ?? "queued",
          conclusion: c.conclusion === null ? null : (CONCLUSION_MAP[c.conclusion] ?? "neutral"),
        };
        if (c.html_url) r.url = c.html_url;
        out.push(r);
      }
      const total = typeof body.total_count === "number" ? body.total_count : out.length;
      if (batch.length === 0 || out.length >= total) break;
    }
    return out;
  }

  /**
   * 读 combined commit status，映射为 CheckResult（T-066 C2）。按 per_page=100&page=N 翻页，直到收满
   * total_count（或某页为空）；最多 MAX_CHECK_PAGES 页，超出抛错。顶层 state 为 failure / error
   * 却没收集到任何失败条目时，补一条失败结果，不让评审绕过 CI。
   */
  private async fetchCommitStatuses(rec: PrRecord, sha: string): Promise<CheckResult[]> {
    const op = "GET /commits/{sha}/status";
    const out: CheckResult[] = [];
    let state: string | undefined;
    for (let page = 1; ; page++) {
      if (page > MAX_CHECK_PAGES)
        throw new Error(`${op} 超过 ${MAX_CHECK_PAGES} 页仍未取完：${sha}`);
      const res = await this.request(
        op,
        rec,
        "GET",
        `/commits/${sha}/status?per_page=100&page=${page}`,
      );
      if (!res.ok) throw await this.apiError(op, res);
      const body = (await res.json()) as {
        state?: string;
        total_count?: number;
        statuses?: { context: string; state: string; target_url?: string | null }[];
      };
      if (page === 1) state = body.state;
      const batch = body.statuses ?? [];
      for (const s of batch) {
        const mapped = STATUS_STATE_MAP[s.state] ?? {
          status: "queued" as const,
          conclusion: null,
        };
        const r: CheckResult = { name: s.context, ...mapped };
        if (s.target_url) r.url = s.target_url;
        out.push(r);
      }
      const total = typeof body.total_count === "number" ? body.total_count : out.length;
      if (batch.length === 0 || out.length >= total) break;
    }
    if ((state === "failure" || state === "error") && !out.some((r) => r.conclusion === "failure"))
      out.push({ name: COMBINED_STATUS_NAME, status: "completed", conclusion: "failure" });
    return out;
  }

  /**
   * T-066 B1：中途出错时，若已收集到变化，抛 SyncPartialError（带 changes）；否则抛原始错误。
   * 已落库的变化不会在下次 sync 再报（记录已非 open），调用方须先应用 error.changes。
   */
  async sync(): Promise<SyncChange[]> {
    const changes: SyncChange[] = [];
    try {
      const records = (await this.store.list()).map(assertPrRecord);
      for (const rec of records) {
        if (rec.closed_by === "bakacoding") continue;
        if (!rec.remote || (rec.status !== "open" && rec.status !== "conflict")) continue;
        const op = "GET /pulls/{n}";
        const res = await this.request(op, rec, "GET", `/pulls/${rec.remote.number}`);
        if (!res.ok) throw await this.apiError(op, res);
        const pull = (await res.json()) as GhPull;
        if (pull.state !== "closed") continue;
        // 请求期间可能被 close() 改过：以最新记录为准，BakaCoding 自己关的不当成用户手动关闭
        const latest = await this.mustGet(rec.pr_id);
        if (latest.closed_by === "bakacoding") continue;
        if (latest.status !== "open" && latest.status !== "conflict") continue;
        const from: PrStatus = latest.status;
        const ts = this.now().toISOString();
        if (pull.merged || pull.merged_at) {
          const merged_into = pull.base?.ref ?? rec.base_branch;
          const next: PrRecord = { ...latest, status: "merged", merged_into, updated_ts: ts };
          if (pull.merge_commit_sha) next.merge_sha = pull.merge_commit_sha;
          await this.store.put(next);
          this.logger.warn(
            `[bakacoding/pr] 同步差异：${rec.pr_id}（GitHub PR #${rec.remote.number}）在 GitHub 上被手动合并，本地 ${from} → merged`,
          );
          const change: SyncChange = { pr_id: rec.pr_id, from, to: "merged" };
          if (pull.merge_commit_sha) change.merge_sha = pull.merge_commit_sha;
          changes.push(change);
        } else {
          await this.store.put({ ...latest, status: "closed", updated_ts: ts });
          // 先记变化再上报：escalate 抛错时这条变化仍随 SyncPartialError.changes 带出
          changes.push({ pr_id: rec.pr_id, from, to: "closed" });
          await this.escalate(rec, `GitHub PR #${rec.remote.number}：用户在 GitHub 手动关闭`);
        }
      }
      return changes;
    } catch (err) {
      if (err instanceof SyncPartialError) throw err;
      if (changes.length > 0) throw new SyncPartialError(changes, err);
      throw err;
    }
  }

  // ---- 内部 ----

  /**
   * 没有 remote 的记录（还没提交过，或 commitWorktree / openIntegration 的 push、开 PR 失败）：补做
   * push 和开 PR（先查同名 open PR，有就复用），写回 remote。分支比 base 没有新提交时什么都不做
   * （不推工作分支、不开 PR，避免 422），返回的记录仍没有 remote。
   */
  private async backfillRemote(rec: PrRecord): Promise<PrRecord> {
    if (rec.kind === "ticket") {
      await this.publishTicket(rec);
    } else {
      await this.push(rec.repo_path, rec.branch);
      if (await this.hasCommits(rec.repo_path, rec.branch, rec.base_branch))
        await this.attachPull(
          rec.pr_id,
          rec.branch,
          rec.base_branch,
          `集成分支 ${rec.branch} → ${rec.base_branch}`,
        );
    }
    return this.mustGet(rec.pr_id);
  }

  /**
   * 单张 PR 上远程：确保集成分支在远程；分支有新提交才推本单分支（只推 refs/heads/<branch>，快进，
   * 远程已分叉时上报并抛 GithubBranchDivergedError，不强推），没有 remote 时开 PR（有同名 PR 就复用）。
   */
  private async publishTicket(rec: TicketPrRecord): Promise<void> {
    await this.ensureRemoteIntegration();
    if (!(await this.hasCommits(rec.worktree_path, rec.branch, INTEGRATION_BRANCH))) return;
    await this.pushTicket(rec, rec.worktree_path);
    if (!rec.remote)
      await this.attachPull(rec.pr_id, rec.branch, INTEGRATION_BRANCH, rec.ticket_id);
  }

  /** commitWorktree 刚提交的那条记录（与本地实现同样的匹配规则）。 */
  private async openTicketRecord(
    ticket_id: string,
    worktree_path: string,
  ): Promise<TicketPrRecord | undefined> {
    const wt = resolve(worktree_path);
    return (await this.store.list())
      .map(assertPrRecord)
      .filter(
        (r): r is TicketPrRecord =>
          r.kind === "ticket" &&
          r.ticket_id === ticket_id &&
          resolve(r.worktree_path) === wt &&
          (r.status === "open" || r.status === "conflict"),
      )
      .at(-1);
  }

  /** branch 上有没有 base 没有的提交（没有时 GitHub 开 PR 会回 422 No commits between）。 */
  private async hasCommits(cwd: string, branch: string, base: string): Promise<boolean> {
    const out = await git(cwd, ["rev-list", "--count", `refs/heads/${base}..refs/heads/${branch}`]);
    return Number(out.stdout.trim()) > 0;
  }

  /** 远程上本单分支的 sha；远程没有这个分支返回 undefined。 */
  private async remoteHead(branch: string): Promise<string | undefined> {
    const out = (
      await git(this.repo, ["ls-remote", this.remote, `refs/heads/${branch}`], {
        env: GIT_ENV,
        remote: true,
      })
    ).stdout;
    return out.trim().split(/\s+/)[0] || undefined;
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
    const out = (
      await git(this.repo, ["ls-remote", "--heads", this.remote, ref], {
        env: GIT_ENV,
        remote: true,
      })
    ).stdout;
    if (out.trim()) return;
    await this.local.ensureBranch(this.repo, INTEGRATION_BRANCH, "main");
    await this.push(this.repo, INTEGRATION_BRANCH);
  }

  /** 合并前推本单分支（兜底，正常已在 commitWorktree 推过）；远程已分叉时上报并抛错，绝不强推。 */
  private async pushForMerge(rec: PrRecord, cwd: string): Promise<void> {
    await this.pushTicket(rec, cwd);
  }

  /** 只推 refs/heads/<branch>（快进）；非快进被拒时上报并抛 GithubBranchDivergedError，绝不强推。 */
  private async pushTicket(rec: PrRecord, cwd: string): Promise<void> {
    try {
      await this.push(cwd, rec.branch);
    } catch (err) {
      if (
        err instanceof GitError &&
        /\[rejected\]|non-fast-forward|fetch first|\(stale info\)/i.test(err.stderr)
      ) {
        await this.escalate(
          rec,
          `远程分支 ${rec.branch} 已分叉：push 被拒（非快进），未强推，未合并 GitHub PR #${rec.remote?.number ?? "?"}`,
        );
        throw new GithubBranchDivergedError(rec.branch);
      }
      throw err;
    }
  }

  private async push(cwd: string, branch: string): Promise<void> {
    await git(cwd, ["push", "-q", this.remote, `refs/heads/${branch}:refs/heads/${branch}`], {
      env: GIT_ENV,
      remote: true,
    });
  }

  private async fetchRemote(): Promise<void> {
    await git(this.repo, ["fetch", "-q", this.remote], { env: GIT_ENV, remote: true });
  }

  /** 把本地分支快进到远端；被 checkout 时只在干净的 worktree 里 ff-only，否则记日志不动。 */
  private advanceLocal(branch: string, remoteRef: string): Promise<void> {
    return this.gitWriteLock(() => this.advanceLocalLocked(branch, remoteRef));
  }

  private async advanceLocalLocked(branch: string, remoteRef: string): Promise<void> {
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
