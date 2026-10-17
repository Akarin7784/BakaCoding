// T-041a：组合根。真实的 0 总线、2 存储（SQLite）、8 / 9 / 10；5 / 7 / 6 / 4 的 worktree 用替身。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "@bakacoding/config-budget";
import type { CoderPool } from "@bakacoding/coder-pool";
import { GithubRateLimitError, type PrProvider, type TicketPrRecord } from "@bakacoding/pr";
import { openStorage, type Storage, type TicketFields } from "@bakacoding/storage";
import type { BakaEvent, TicketStatus } from "@bakacoding/types";
import { requestWriteScope } from "@bakacoding/workspace";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assemble, type App, type AppDeps } from "./index.js";
import {
  closeTicketPrs,
  currentTicketPr,
  judgeHighRiskOnTakeover,
  lastEscalationFrom,
} from "./assemble.js";

const examplePath = fileURLToPath(new URL("../../../config/models.example.json", import.meta.url));
const HEAD = "a".repeat(40);
const MERGE_SHA = "b".repeat(40);
const PROJECT = "proj-1";

let dirs: string[] = [];
let opened: Storage[] = [];
let apps: App[] = [];
afterEach(() => {
  for (const a of apps) a.stop();
  for (const s of opened) {
    try {
      s.close();
    } catch {
      // 已关
    }
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  opened = [];
  apps = [];
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "bc-app-"));
  dirs.push(root);
  const worktreeRoot = join(root, "repo", ".bakacoding", "worktrees");
  mkdirSync(worktreeRoot, { recursive: true });
  const storage = openStorage({ path: join(root, "db.sqlite"), logger: { warn: () => {} } });
  opened.push(storage);
  return { root, worktreeRoot, storage };
}

/** 6 的替身：记下调用；合并总是成功。 */
function fakePr() {
  let n = 0;
  const calls = {
    open: [] as string[],
    commit: [] as Array<{ ticket_id: string; worktree_path: string }>,
    merge: [] as string[],
  };
  const pr: PrProvider = {
    kind: "local",
    commitPatch: async () => HEAD,
    commitWorktree: async (ticket_id, worktree_path) => {
      calls.commit.push({ ticket_id, worktree_path });
      return "c".repeat(40);
    },
    open: async (ticket_id) => {
      calls.open.push(ticket_id);
      return `local-new-${++n}`;
    },
    openIntegration: async () => "local-integration-1",
    diff: async () => ({
      base_sha: HEAD,
      head_sha: "c".repeat(40),
      files: [{ path: "lib/a/x.ts", status: "added", additions: 1, deletions: 0, patch: "+x" }],
    }),
    merge: async (pr_id) => {
      calls.merge.push(pr_id);
      return { merged: true, sha: MERGE_SHA, fast_forward: false };
    },
    checks: async () => [],
    close: async () => {},
    sync: async () => [],
  };
  return { pr, calls };
}

interface Opts {
  storage: Storage;
  worktreeRoot: string;
  pr: PrProvider;
  runTicket?: CoderPool["runTicket"];
  notifyUser?: AppDeps["notifyUser"];
  /** 改配置（T-041c：pending_pr_limit） */
  config?: (c: AppDeps["config"]) => AppDeps["config"];
  /** 额外的 9 选项（T-041c：验证 holdHighRisk 关不掉） */
  scheduler?: Record<string, unknown>;
}

async function start(o: Opts) {
  const created: string[] = [];
  const runTicket =
    o.runTicket ??
    (async () => ({ status: "done" as const, summary: "写好了", changed_files: ["lib/a/x.ts"] }));
  const app = await assemble({
    config: o.config ? o.config(getConfig(examplePath)) : getConfig(examplePath),
    storage: o.storage,
    call: async () => {
      throw new Error("本测试不调主管模型");
    },
    promptTemplate: async () => "桩模板",
    coder: { runTicket },
    review: async () => ({ verdict: "pass", reasons: [], reviewer: "m1" }),
    budget: {
      budgetState: async () =>
        ({
          daily_exhausted: false,
          offpeak_now: false,
          offpeak_preference: false,
          ticket: { exhausted: false },
        }) as never,
    },
    createPr: () => o.pr,
    worktrees: {
      create: (ticket_id, _base, round) => {
        const path = join(o.worktreeRoot, `${ticket_id}-r${round}`);
        mkdirSync(path, { recursive: true });
        created.push(path);
        return { path, branch: `bakacoding/${ticket_id}-r${round}` };
      },
      cleanup: () => {},
    },
    worktreeRoot: o.worktreeRoot,
    targetHead: () => HEAD,
    notifyUser: o.notifyUser ?? (() => {}),
    scheduler: { dispatch_poll_ms: 0, ...o.scheduler },
    logger: { warn: () => {} },
  });
  apps.push(app);
  return { app, created };
}

const statusOf = (s: Storage, id: string): TicketStatus | undefined => s.getTicket(id)?.status;

async function createProject(app: App) {
  await app.bus.publish({
    type: "project_created",
    trace_id: "tr-p",
    span_id: "sp-p",
    parent_span_id: null,
    requirement_id: null,
    ticket_id: null,
    payload: {
      project_id: PROJECT,
      name: "demo",
      language: "typescript",
      has_github_remote: false,
    },
  });
}

function fields(over: Partial<Record<string, unknown>> = {}): TicketFields {
  return {
    write_scope: ["lib/a/**"],
    interfaces: [],
    depends_on: [],
    priority: "normal",
    kind: null,
    origin: "split",
    trace: { trace_id: "tr-r", span_id: "sp-t", parent_span_id: "sp-r" },
    ...over,
  } as TicketFields;
}

function saveTicket(
  s: Storage,
  id: string,
  status: TicketStatus,
  f: TicketFields | undefined,
  requirement_id = "req-1",
) {
  s.saveTicket({
    ticket_id: id,
    project_id: PROJECT,
    requirement_id,
    created_at: "2026-10-17T08:00:00Z",
    ticket_text: `做 ${id}`,
    status,
    base_commit: HEAD,
    permission_list: [],
    context_snippets: [],
    ...(f ? { fields: f } : {}),
  });
}

describe("组合根：同一条总线", () => {
  it("8 / 9 / 10 / 4 / 2 用的是同一条总线：各自发的事件都在它上面、落库 seq 不重复，越界写申请经它被 8 答复", async () => {
    const { storage, worktreeRoot } = setup();
    const { pr } = fakePr();
    const notified: string[] = [];
    const scopeDecisions: unknown[] = [];
    const { app } = await start({
      storage,
      worktreeRoot,
      pr,
      notifyUser: (m) => {
        notified.push(m.text);
      },
      // 5 的替身：像 4 的工具那样经 scope_requests 申请写本单范围内的新文件，8 应在同一条总线上直接批
      runTicket: async (input) => {
        if (input.scope_requests)
          scopeDecisions.push(
            await requestWriteScope(
              input.scope_requests,
              input.ticket.ticket_id,
              ["lib/a/new.ts"],
              "要新建文件",
            ),
          );
        return { status: "done", summary: "写好了", changed_files: ["lib/a/x.ts"] };
      },
    });
    const seen: BakaEvent[] = [];
    app.bus.subscribe("*", (e) => {
      seen.push(e);
    });

    // 0 → 10、2：project_created 经总线到 10（告知用户）和 2（建项目）
    await createProject(app);
    expect(notified).toHaveLength(1);
    expect(storage.listProjects().map((p) => p.project_id)).toEqual([PROJECT]);

    // 0 → 9：review_backlog 经总线到 9 的反压
    await app.bus.publish({
      type: "review_backlog",
      trace_id: "tr-b",
      span_id: "sp-b",
      parent_span_id: null,
      requirement_id: "req-b",
      ticket_id: null,
      payload: { pending: 3, capacity: 7 },
    });
    expect((await app.scheduler.backpressureState()).review_backlog).toEqual({
      pending: 3,
      capacity: 7,
    });

    // 10 建单 → 9 派单 → 8 编码（4 的越界写申请经同一条总线由 8 批复）→ 9 合并 → interface_changed
    const t = await app.supervisor.createManualTicket({
      project_id: PROJECT,
      ticket_text: "在 lib/a 下加 x",
      origin: "manual",
      write_scope: ["lib/a/**"],
      interfaces: [{ file: "lib/a/x.ts", symbol: "x" }],
    });
    await vi.waitFor(() => expect(statusOf(storage, t.ticket_id)).toBe("merged"), {
      timeout: 5000,
    });
    await app.scheduler.idle();

    expect(scopeDecisions).toEqual([{ granted: true, granted_scope: ["lib/a/new.ts"] }]);
    const types = (sender: string) =>
      seen
        .filter(
          (e) => e.type === "group_message" && (e.payload as { sender: string }).sender === sender,
        )
        .map((e) => (e.payload as { kind: string }).kind);
    expect(types("supervisor")).toContain("dispatch"); // 10 发的
    expect(types("sub_agent")).toContain("review_verdict"); // 8 发的
    const kinds = seen.map((e) => e.type);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "write_scope_requested", // 4 发的（经 8 的 scopeRequests.bus）
        "write_scope_granted", // 8 答复的
        "interface_changed", // 9 发的
      ]),
    );

    // 只有一条总线：所有事件都落了库，seq 连续不重复（两条总线会撞号，2 拒写）
    expect(storage.health().ingest_failures ?? 0).toBe(0);
    const stored = storage.queryEvents();
    const seqs = stored.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    // start() 可能在订阅前已发 supervisor_backlog，库里可多、seen 里的都必须在库里
    const storedIds = new Set(stored.map((e) => e.event_id));
    for (const e of seen) expect(storedIds.has(e.event_id)).toBe(true);
  });
});

describe("组合根：重启接管", () => {
  it("编码中途停下的单重启后沿用已开的 PR（不再 open），依赖里已合入的单不挡派单", async () => {
    const { storage, worktreeRoot } = setup();
    // 上一次进程留下的状态：A 已合入；B 依赖 A，编码中途停下，已有 PR 和 worktree
    storage.ingest({
      type: "project_created",
      trace_id: "tr-p",
      span_id: "sp-p",
      parent_span_id: null,
      requirement_id: null,
      ticket_id: null,
      event_id: "ev-p",
      ts: "2026-10-17T07:00:00Z",
      seq: storage.nextSeq(),
      payload: {
        project_id: PROJECT,
        name: "demo",
        language: "typescript",
        has_github_remote: false,
      },
    });
    saveTicket(storage, "req-1-1", "merged", fields({ write_scope: ["lib/b/**"] }));
    saveTicket(storage, "req-1-2", "coding", fields({ depends_on: ["req-1-1"] }));
    const wt = join(worktreeRoot, "req-1-2-r0");
    mkdirSync(wt, { recursive: true });
    const rec: TicketPrRecord = {
      kind: "ticket",
      pr_id: "local-7",
      ticket_id: "req-1-2",
      worktree_path: wt,
      branch: "bakacoding/req-1-2-r0",
      base_branch: "bakacoding/integration",
      base_sha: HEAD,
      head_sha: HEAD,
      status: "open",
      created_ts: "2026-10-17T08:00:01Z",
      updated_ts: "2026-10-17T08:00:01Z",
    };
    await storage.prStore<TicketPrRecord>().put(rec);

    const { pr, calls } = fakePr();
    const { app, created } = await start({ storage, worktreeRoot, pr });

    expect(app.takeOver.enqueued).toEqual(["req-1-2"]);
    expect(app.takeOver.merged).toEqual(["req-1-1"]);
    await vi.waitFor(() => expect(statusOf(storage, "req-1-2")).toBe("merged"), {
      timeout: 5000,
    });
    await app.scheduler.idle();
    expect(calls.open).toEqual([]); // 没有重复开 PR
    expect(created).toEqual([]); // 没有另建 r0
    expect(calls.commit).toEqual([{ ticket_id: "req-1-2", worktree_path: wt }]);
    expect(calls.merge).toEqual(["local-7"]);
  });

  it("fields 无效的单不接回、只发一次 ticket_warning(fields_invalid)，不重拆、不上报；已上报、查不到原因的单补跑一次只交用户；没有 PR 记录的不 adopt", async () => {
    const { storage, worktreeRoot } = setup();
    saveTicket(storage, "req-1-1", "pending", undefined); // fields 为 null（旧单）
    saveTicket(storage, "req-1-2", "coding", fields({ write_scope: ["**"] })); // split 单存了 **，复查不过
    saveTicket(storage, "req-1-3", "merge_queued", fields());
    saveTicket(storage, "req-1-4", "escalated", fields());
    const { pr, calls } = fakePr();
    const { app } = await start({ storage, worktreeRoot, pr });

    expect(app.takeOver).toMatchObject({
      enqueued: [],
      adopted: [],
      skipped_invalid: ["req-1-1", "req-1-2"],
      awaiting_adopt: [],
      escalated: ["req-1-4"],
      escalations: [{ ticket_id: "req-1-4", action: "notify_user" }],
      merged: [],
    });
    // merge_queued 但 2 里没有 PR 记录：adopt 拒绝，记进 failed，不派单、不开 PR
    expect(app.takeOver.failed).toEqual([
      { ticket_id: "req-1-3", error: expect.stringMatching(/没有未结束的 PR 记录/) },
    ]);
    // 再接管一次（同一进程）不重复警告
    const again = await app.supervisor.takeOver();
    expect(again.skipped_invalid).toEqual([]);
    await app.scheduler.idle();

    const events = storage.queryEvents();
    const warnings = events.filter((e) => e.type === "ticket_warning");
    expect(warnings.map((e) => [e.ticket_id, (e.payload as { code: string }).code])).toEqual([
      ["req-1-1", "fields_invalid"],
      ["req-1-2", "fields_invalid"],
    ]);
    for (const w of warnings)
      expect((w.payload as { detail: string }).detail.length).toBeLessThanOrEqual(500);
    expect(events.filter((e) => e.type === "escalated")).toEqual([]);
    for (const id of ["req-1-1", "req-1-2", "req-1-3", "req-1-4"])
      expect(app.scheduler.status(id)).toBeUndefined();
    expect(statusOf(storage, "req-1-1")).toBe("pending");
    expect(statusOf(storage, "req-1-2")).toBe("coding");
    expect(calls.open).toEqual([]);
  });

  it("已在合并队列里的单（merge_queued / conflict / re_reviewing）经 9 的 adopt 直接接回并合入，不派单、不编码", async () => {
    const { storage, worktreeRoot } = setup();
    const ids = [
      ["req-1-1", "merge_queued", "lib/a/**"],
      ["req-1-2", "conflict", "lib/b/**"],
      ["req-1-3", "re_reviewing", "lib/c/**"],
    ] as const;
    for (const [id, status, scope] of ids) {
      saveTicket(storage, id, status, fields({ write_scope: [scope] }));
      const path = join(worktreeRoot, `${id}-r0`);
      mkdirSync(path, { recursive: true });
      await storage.prStore<TicketPrRecord>().put({
        kind: "ticket",
        pr_id: `local-${id}`,
        ticket_id: id,
        worktree_path: path,
        branch: `bakacoding/${id}-r0`,
        base_branch: "bakacoding/integration",
        base_sha: HEAD,
        head_sha: "d".repeat(40),
        status: status === "conflict" ? "conflict" : "open",
        created_ts: "2026-10-17T08:00:01Z",
        updated_ts: "2026-10-17T08:00:01Z",
      });
    }
    const runTicket = vi.fn(async () => ({
      status: "done" as const,
      summary: "",
      changed_files: [],
    }));
    const { pr, calls } = fakePr();
    const { app } = await start({ storage, worktreeRoot, pr, runTicket });
    expect(app.takeOver.adopted).toEqual(["req-1-1", "req-1-2", "req-1-3"]);
    expect(app.takeOver.failed).toEqual([]);
    for (const [id] of ids)
      await vi.waitFor(() => expect(statusOf(storage, id)).toBe("merged"), { timeout: 5000 });
    await app.scheduler.idle();
    expect(runTicket).not.toHaveBeenCalled();
    expect(calls.open).toEqual([]);
    expect(calls.merge).toEqual(["local-req-1-1", "local-req-1-2", "local-req-1-3"]);
    // 再接管一次：已接回的不重复 adopt
    const again = await app.supervisor.takeOver();
    expect(again.adopted).toEqual([]);
    expect(again.failed).toEqual([]);
  });

  it("接管重试：第一次 adopt 失败、enqueue 的单已派单持锁，再 takeOver 时写入范围重叠的单进 failed、不叠锁", async () => {
    const { storage, worktreeRoot } = setup();
    // A 在合并队列里，但第一次接管时 2 里还没有它的 PR 记录：adopt 失败
    saveTicket(storage, "req-1-1", "merge_queued", fields({ write_scope: ["lib/a/**"] }));
    // B 编码中、范围与 A 重叠：enqueue 回 9，派单后持锁
    saveTicket(storage, "req-1-2", "coding", fields({ write_scope: ["lib/a/x.ts"] }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runTicket = vi.fn(async () => {
      await gate;
      return { status: "done" as const, summary: "写好了", changed_files: ["lib/a/x.ts"] };
    });
    const { pr, calls } = fakePr();
    const { app } = await start({ storage, worktreeRoot, pr, runTicket });
    expect(app.takeOver.failed.map((f) => f.ticket_id)).toEqual(["req-1-1"]);
    expect(app.takeOver.enqueued).toEqual(["req-1-2"]);
    await vi.waitFor(() => expect(runTicket).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(
      app.scheduler.snapshot().find((v) => v.ticket_id === "req-1-2")!.locked_scope,
    ).not.toBeNull();

    // 补上 A 的 PR 记录后重试接管：A 与持锁的 B 重叠，进 failed，9 不登记 A
    const path = join(worktreeRoot, "req-1-1-r0");
    mkdirSync(path, { recursive: true });
    await storage.prStore<TicketPrRecord>().put({
      kind: "ticket",
      pr_id: "local-A",
      ticket_id: "req-1-1",
      worktree_path: path,
      branch: "bakacoding/req-1-1-r0",
      base_branch: "bakacoding/integration",
      base_sha: HEAD,
      head_sha: "d".repeat(40),
      status: "open",
      created_ts: "2026-10-17T08:00:01Z",
      updated_ts: "2026-10-17T08:00:01Z",
    });
    const again = await app.supervisor.takeOver();
    expect(again.adopted).toEqual([]);
    expect(again.failed).toEqual([
      { ticket_id: "req-1-1", error: expect.stringMatching(/在途单 req-1-2 重叠/) },
    ]);
    expect(app.scheduler.status("req-1-1")).toBeUndefined();
    expect(
      app.scheduler
        .snapshot()
        .filter((v) => v.locked_scope !== null)
        .map((v) => v.ticket_id),
    ).toEqual(["req-1-2"]);
    expect(statusOf(storage, "req-1-1")).toBe("merge_queued");

    release();
    await vi.waitFor(() => expect(statusOf(storage, "req-1-2")).toBe("merged"), {
      timeout: 5000,
    });
    await app.scheduler.idle();
    expect(calls.merge).not.toContain("local-A");
  });

  it("沿用已开的 PR 时 worktree 不在了：不另开 PR，交 9 上报", async () => {
    const { storage, worktreeRoot } = setup();
    saveTicket(storage, "req-1-1", "coding", fields());
    await storage.prStore<TicketPrRecord>().put({
      kind: "ticket",
      pr_id: "local-9",
      ticket_id: "req-1-1",
      worktree_path: join(worktreeRoot, "req-1-1-r0"),
      branch: "bakacoding/req-1-1-r0",
      base_branch: "bakacoding/integration",
      base_sha: HEAD,
      head_sha: HEAD,
      status: "open",
      created_ts: "2026-10-17T08:00:01Z",
      updated_ts: "2026-10-17T08:00:01Z",
    });
    const { pr, calls } = fakePr();
    const { app, created } = await start({ storage, worktreeRoot, pr });
    await vi.waitFor(() => expect(statusOf(storage, "req-1-1")).toBe("escalated"), {
      timeout: 5000,
    });
    await app.scheduler.idle();
    expect(calls.open).toEqual([]);
    expect(created).toEqual([]);
    const esc = storage.queryEvents().filter((e) => e.type === "escalated");
    expect(esc).toHaveLength(1);
    expect((esc[0]!.payload as { detail?: string }).detail).toMatch(/worktree 不在了/);
  });
});

describe("currentTicketPr", () => {
  it("取本单未结束的最新一条 ticket 记录", async () => {
    const base = {
      kind: "ticket" as const,
      ticket_id: "T",
      worktree_path: "/w",
      branch: "b",
      base_branch: "i",
      base_sha: HEAD,
      head_sha: HEAD,
      updated_ts: "2026-10-17T08:00:00Z",
    };
    const list = [
      { ...base, pr_id: "p1", status: "open" as const, created_ts: "2026-10-17T08:00:00Z" },
      { ...base, pr_id: "p2", status: "conflict" as const, created_ts: "2026-10-17T09:00:00Z" },
      { ...base, pr_id: "p3", status: "closed" as const, created_ts: "2026-10-17T10:00:00Z" },
      {
        ...base,
        pr_id: "p4",
        ticket_id: "U",
        status: "open" as const,
        created_ts: "2026-10-17T11:00:00Z",
      },
    ];
    expect((await currentTicketPr({ list: async () => list }, "T"))?.pr_id).toBe("p2");
    expect(await currentTicketPr({ list: async () => list }, "X")).toBeUndefined();
  });
});

// ---------------- T-041b ----------------

function prRec(
  over: Partial<TicketPrRecord> & { pr_id: string; ticket_id: string },
): TicketPrRecord {
  return {
    kind: "ticket",
    worktree_path: `/wt/${over.ticket_id}-r0`,
    branch: `bakacoding/${over.ticket_id}-r0`,
    base_branch: "bakacoding/integration",
    base_sha: HEAD,
    head_sha: "d".repeat(40),
    status: "open",
    created_ts: "2026-10-17T08:00:01Z",
    updated_ts: "2026-10-17T08:00:01Z",
    ...over,
  };
}

describe("T-041b closeTicketPrs（N1）", () => {
  it("远端已合入、本地还是 open：先 sync 再判，返回 merged，本地记录不会被标成 closed", async () => {
    const { storage } = setup();
    const store = storage.prStore<TicketPrRecord>();
    await store.put(prRec({ pr_id: "local-1", ticket_id: "T" }));
    const order: string[] = [];
    const close = vi.fn(async (pr_id: string) => {
      order.push("close");
      const r = (await store.get(pr_id))!;
      await store.put({ ...r, status: "closed" });
    });
    const sync = async () => {
      order.push("sync");
      // 6 的 sync：把用户在 GitHub 上的手动合并同步回本地
      const r = (await store.get("local-1"))!;
      await store.put({ ...r, status: "merged" });
    };
    expect(await closeTicketPrs({ sync, store, pr: { close } }, "T", "由重拆取代")).toBe("merged");
    expect(order).toEqual(["sync"]);
    expect(close).not.toHaveBeenCalled();
    expect((await store.get("local-1"))!.status).toBe("merged");
  });

  it("只看本单的 ticket 记录：open / conflict 全部关掉返回 closed；没有未结束的返回 none；close 抛 PrAlreadyMergedError 算 merged；sync 出错照抛、不关", async () => {
    const { storage } = setup();
    const store = storage.prStore<TicketPrRecord>();
    await store.put(prRec({ pr_id: "local-1", ticket_id: "T", status: "closed" }));
    await store.put(prRec({ pr_id: "local-2", ticket_id: "T", status: "conflict" }));
    await store.put(prRec({ pr_id: "local-3", ticket_id: "T" }));
    await store.put(prRec({ pr_id: "local-4", ticket_id: "U" }));
    const closed: string[] = [];
    const pr = { close: async (id: string) => void closed.push(id) };
    const sync = async () => {};
    expect(await closeTicketPrs({ sync, store, pr }, "T", "r")).toBe("closed");
    expect(closed.sort()).toEqual(["local-2", "local-3"]);
    expect(await closeTicketPrs({ sync, store, pr }, "V", "r")).toBe("none");
    const { PrAlreadyMergedError } = await import("@bakacoding/pr");
    expect(
      await closeTicketPrs(
        {
          sync,
          store,
          pr: {
            close: async (id) => {
              throw new PrAlreadyMergedError(id);
            },
          },
        },
        "U",
        "r",
      ),
    ).toBe("merged");
    const close = vi.fn();
    await expect(
      closeTicketPrs(
        {
          sync: async () => {
            throw new Error("sync 挂了");
          },
          store,
          pr: { close },
        },
        "U",
        "r",
      ),
    ).rejects.toThrow(/sync 挂了/);
    expect(close).not.toHaveBeenCalled();
  });

  it("#65 评审：sync 抛 GithubRateLimitError 原样抛出（同一个实例），一次 close 都不调", async () => {
    const { storage } = setup();
    const store = storage.prStore<TicketPrRecord>();
    await store.put(prRec({ pr_id: "local-1", ticket_id: "T" }));
    const err = new GithubRateLimitError(429, "sync", 60000);
    const close = vi.fn();
    await expect(
      closeTicketPrs(
        {
          sync: async () => {
            throw err;
          },
          store,
          pr: { close },
        },
        "T",
        "r",
      ),
    ).rejects.toBe(err);
    expect(close).not.toHaveBeenCalled();
    expect((await store.get("local-1"))!.status).toBe("open");
  });
});

describe("T-041b lastEscalationFrom（N5）", () => {
  it("取本单最后一条需要处理的 escalated，跳过 scope_lock_failed / merged_but / resplit_limit", () => {
    const { storage } = setup();
    const ev = (ticket_id: string, reason: string, n: number) =>
      storage.ingest({
        type: "escalated",
        event_id: `e${n}`,
        seq: storage.nextSeq(),
        ts: "2026-10-17T08:00:00Z",
        trace_id: "t",
        span_id: `s${n}`,
        parent_span_id: null,
        requirement_id: "req-1",
        ticket_id,
        payload: { reason, detail: `d${n}` },
      } as BakaEvent);
    ev("T", "review_limit", 1);
    ev("T", "conflict_limit", 2);
    ev("T", "scope_lock_failed", 3);
    ev("T", "resplit_limit", 4);
    ev("U", "budget_exceeded", 5);
    const last = lastEscalationFrom(storage);
    expect(last("T")).toMatchObject({ payload: { reason: "conflict_limit", detail: "d2" } });
    expect(last("X")).toBeUndefined();
  });
});

describe("T-041b 组合根：上报处理与重启", () => {
  it("关旧 PR 时 sync 失败：不关、不重拆、发 pr_close_failed；重启后从关旧 PR 这一步接着做", async () => {
    const { storage, worktreeRoot } = setup();
    saveTicket(storage, "req-1-1", "coding", fields({ requirement_text: "原需求" }));
    const wt = join(worktreeRoot, "req-1-1-r0");
    mkdirSync(wt, { recursive: true });
    await storage
      .prStore<TicketPrRecord>()
      .put(prRec({ pr_id: "local-1", ticket_id: "req-1-1", worktree_path: wt }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = fakePr();
    a.pr.sync = async () => {
      throw new Error("GitHub 不可用");
    };
    const close1 = vi.spyOn(a.pr, "close");
    const runTicket = vi.fn(async () => {
      await gate;
      return { status: "done" as const, summary: "", changed_files: [] };
    });
    const { app } = await start({ storage, worktreeRoot, pr: a.pr, runTicket });
    await vi.waitFor(() => expect(runTicket).toHaveBeenCalled(), { timeout: 5000 });
    // 8 上报（状态由 8 写，这里直接模拟）
    saveTicket(storage, "req-1-1", "escalated", undefined);
    await app.bus.publish({
      type: "escalated",
      trace_id: "tr-r",
      span_id: "sp-x",
      parent_span_id: "sp-t",
      requirement_id: "req-1",
      ticket_id: "req-1-1",
      payload: {
        reason: "review_limit",
        detail: "评审不过",
        resubmit_counts: { review: 3, conflict: 0 },
      },
    });
    await vi.waitFor(
      () =>
        expect(
          storage
            .queryEvents({ types: ["ticket_warning"] })
            .map((e) => (e.payload as { code: string }).code),
        ).toEqual(["pr_close_failed"]),
      { timeout: 5000 },
    );
    expect(close1).not.toHaveBeenCalled();
    const f1 = storage.getTicket("req-1-1")!.fields as Record<string, unknown>;
    expect(f1).toMatchObject({ escalation_handled: { action: "resplit" } });
    expect(f1.pr_close_done).toBeUndefined();
    expect(storage.listTickets().map((r) => r.ticket_id)).toEqual(["req-1-1"]);
    app.stop();
    release();

    // 重启：sync 正常，从关旧 PR 这一步接着做（关掉旧 PR，再进拆单；本测试没建项目，拆单失败 → 记 error 交用户、不再重试）
    const b = fakePr();
    const closed: string[] = [];
    b.pr.close = async (id) => void closed.push(id);
    const notified: string[] = [];
    const { app: app2 } = await start({
      storage,
      worktreeRoot,
      pr: b.pr,
      notifyUser: (m) => void notified.push(m.text),
    });
    expect(app2.takeOver.escalations).toEqual([{ ticket_id: "req-1-1", action: "notify_user" }]);
    expect(closed).toEqual(["local-1"]);
    const f2 = storage.getTicket("req-1-1")!.fields as Record<string, unknown>;
    expect(f2).toMatchObject({
      pr_close_done: { result: "closed" },
      escalation_handled: { action: "resplit", error: expect.any(String) },
    });
    expect(notified.some((t) => /重拆失败/.test(t))).toBe(true);
  });

  it("#65 评审：关旧 PR 时 6 的 sync 抛 GithubRateLimitError：错误原样上抛、一次 close 都不调、发 pr_close_failed、不出新单", async () => {
    const { storage, worktreeRoot } = setup();
    saveTicket(storage, "req-1-1", "coding", fields({ requirement_text: "原需求" }));
    const wt = join(worktreeRoot, "req-1-1-r0");
    mkdirSync(wt, { recursive: true });
    await storage
      .prStore<TicketPrRecord>()
      .put(prRec({ pr_id: "local-1", ticket_id: "req-1-1", worktree_path: wt }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = fakePr();
    const err = new GithubRateLimitError(429, "sync", 60000);
    const sync = vi.fn(async (): Promise<never> => {
      throw err;
    });
    a.pr.sync = sync;
    const close1 = vi.spyOn(a.pr, "close");
    const runTicket = vi.fn(async () => {
      await gate;
      return { status: "done" as const, summary: "", changed_files: [] };
    });
    const { app } = await start({ storage, worktreeRoot, pr: a.pr, runTicket });
    await vi.waitFor(() => expect(runTicket).toHaveBeenCalled(), { timeout: 5000 });
    saveTicket(storage, "req-1-1", "escalated", undefined);
    await app.bus.publish({
      type: "escalated",
      trace_id: "tr-r",
      span_id: "sp-x",
      parent_span_id: "sp-t",
      requirement_id: "req-1",
      ticket_id: "req-1-1",
      payload: {
        reason: "review_limit",
        detail: "评审不过",
        resubmit_counts: { review: 3, conflict: 0 },
      },
    });
    await vi.waitFor(
      () =>
        expect(
          storage
            .queryEvents({ types: ["ticket_warning"] })
            .map((e) => (e.payload as { code: string }).code),
        ).toEqual(["pr_close_failed"]),
      { timeout: 5000 },
    );
    expect(sync).toHaveBeenCalled();
    // 10 拿到的就是 6 抛的这个限流错误（经 9 的 sync 和 closeTicketPrs 原样上抛，没被吞、没被换掉）
    const w = storage.queryEvents({ types: ["ticket_warning"] })[0]!;
    expect((w.payload as { detail: string }).detail).toContain(err.message);
    expect(close1).not.toHaveBeenCalled();
    const f1 = storage.getTicket("req-1-1")!.fields as Record<string, unknown>;
    expect(f1).toMatchObject({ escalation_handled: { action: "resplit" } });
    expect(f1.pr_close_done).toBeUndefined();
    expect(storage.listTickets().map((r) => r.ticket_id)).toEqual(["req-1-1"]);
    expect((await storage.prStore<TicketPrRecord>().get("local-1"))!.status).toBe("open");
    app.stop();
    release();
  });

  it("重启前经 extendScope 批准扩出的范围随 adopt / enqueue 并进 9 的锁：与它重叠的单接不回", async () => {
    const { storage, worktreeRoot } = setup();
    saveTicket(
      storage,
      "req-1-1",
      "merge_queued",
      fields({ write_scope: ["lib/a/**"], depends_on: ["zz"] }),
    );
    saveTicket(storage, "req-1-2", "merge_queued", fields({ write_scope: ["lib/z/x.ts"] }));
    for (const id of ["req-1-1", "req-1-2"]) {
      const path = join(worktreeRoot, `${id}-r0`);
      mkdirSync(path, { recursive: true });
      await storage
        .prStore<TicketPrRecord>()
        .put(prRec({ pr_id: `local-${id}`, ticket_id: id, worktree_path: path }));
    }
    storage.ingest({
      type: "write_scope_granted",
      event_id: "g1",
      seq: storage.nextSeq(),
      ts: "2026-10-17T08:00:00Z",
      trace_id: "tr-r",
      span_id: "sp-g",
      parent_span_id: null,
      requirement_id: "req-1",
      ticket_id: "req-1-1",
      payload: { ticket_id: "req-1-1", request_id: "r1", granted_scope: ["lib/z/**", "../bad/**"] },
    } as BakaEvent);
    const { pr } = fakePr();
    const { app } = await start({ storage, worktreeRoot, pr });
    expect(app.takeOver.adopted).toEqual(["req-1-1"]);
    expect(app.takeOver.failed).toEqual([
      { ticket_id: "req-1-2", error: expect.stringMatching(/在途单 req-1-1 重叠/) },
    ]);
    expect(app.scheduler.snapshot().find((v) => v.ticket_id === "req-1-1")!.locked_scope).toEqual([
      "lib/a/**",
      "lib/z/**",
    ]);
  });
});

// ---------------- T-041c ----------------

describe("T-041c judgeHighRiskOnTakeover（N4）", () => {
  const diffOf = (
    files: Array<{ path: string; status: "added" | "modified" | "deleted" | "renamed" }>,
  ) => ({
    diff: async () => ({
      base_sha: HEAD,
      head_sha: "c".repeat(40),
      files: files.map((f) => ({ ...f, additions: 0, deletions: 0, patch: "" })),
    }),
  });

  it("删除的 package.json、锁文件、没有旧路径的改名都算高风险；普通改动不算；diff 出错按高风险", async () => {
    const judge = async (path: string, status: "added" | "modified" | "deleted" | "renamed") =>
      (await judgeHighRiskOnTakeover(diffOf([{ path, status }]), "p")).high_risk;
    expect(await judge("package.json", "deleted")).toBe(true);
    // 没有 old_path 的改名仍按兜底算（T-065）
    expect(await judge("src/x.ts", "renamed")).toBe(true);
    expect(await judge("sub/yarn.lock", "modified")).toBe(true);
    expect(await judge("apps/web/pnpm-lock.yaml", "added")).toBe(true);
    expect(await judge("src/x.ts", "modified")).toBe(false);
    expect(await judge("docs/package.json.md", "modified")).toBe(false);
    // T-065：改名看旧路径——package.json 改名成 x.json 也算
    const renamedAway = {
      diff: async () => ({
        base_sha: HEAD,
        head_sha: "c".repeat(40),
        files: [
          {
            path: "x.json",
            old_path: "package.json",
            status: "renamed" as const,
            additions: 0,
            deletions: 0,
            patch: "",
          },
        ],
      }),
    };
    expect((await judgeHighRiskOnTakeover(renamedAway, "p")).high_risk).toBe(true);
    expect(
      (await judgeHighRiskOnTakeover(diffOf([{ path: "package.json", status: "deleted" }]), "p"))
        .files,
    ).toEqual([{ path: "package.json", status: "deleted", additions: 0, deletions: 0, patch: "" }]);
    const warned: string[] = [];
    expect(
      await judgeHighRiskOnTakeover(
        {
          diff: async () => {
            throw new Error("git 挂了");
          },
        },
        "p",
        (m) => void warned.push(m),
      ),
    ).toEqual({ high_risk: true, files: null });
    expect(warned[0]).toMatch(/按高风险处理/);
  });
});

describe("T-041c 组合根：高风险闸门", () => {
  /** 两张已在合并队列里的单：T1 的 PR 删了 package.json（kind 不是 dependency），T2 普通 */
  async function restartSetup(
    o: { diffFails?: boolean; config?: Opts["config"]; scheduler?: Opts["scheduler"] } = {},
  ) {
    const { storage, worktreeRoot } = setup();
    saveTicket(storage, "req-1-1", "merge_queued", fields({ write_scope: ["package.json"] }));
    saveTicket(storage, "req-1-2", "merge_queued", fields({ write_scope: ["lib/b/**"] }));
    for (const id of ["req-1-1", "req-1-2"]) {
      const path = join(worktreeRoot, `${id}-r0`);
      mkdirSync(path, { recursive: true });
      await storage
        .prStore<TicketPrRecord>()
        .put(prRec({ pr_id: `local-${id}`, ticket_id: id, worktree_path: path }));
    }
    const f = fakePr();
    const closed: string[] = [];
    f.pr.close = async (id) => void closed.push(id);
    const diffCalls: string[] = [];
    f.pr.diff = async (pr_id) => {
      diffCalls.push(pr_id);
      if (pr_id === "local-req-1-1" && o.diffFails) throw new Error("diff 挂了");
      return {
        base_sha: HEAD,
        head_sha: "d".repeat(40),
        files:
          pr_id === "local-req-1-1"
            ? [{ path: "package.json", status: "deleted", additions: 0, deletions: 3, patch: "" }]
            : [{ path: "lib/b/x.ts", status: "modified", additions: 1, deletions: 0, patch: "+x" }],
      };
    };
    const notified: string[] = [];
    const { app } = await start({
      storage,
      worktreeRoot,
      pr: f.pr,
      notifyUser: (m) => void notified.push(m.text),
      ...(o.config ? { config: o.config } : {}),
      ...(o.scheduler ? { scheduler: o.scheduler } : {}),
    });
    return { storage, app, calls: f.calls, closed, notified, pr: f.pr, diffCalls };
  }

  it("重启：按 diff 补判出高风险（删了 package.json、kind 不是 dependency）的单扣着并通知用户放行不保存；普通单照常合；放行后合入", async () => {
    const { storage, app, calls, notified, diffCalls } = await restartSetup();
    expect(app.takeOver.adopted).toEqual(["req-1-1", "req-1-2"]);
    await app.scheduler.idle();
    expect(calls.merge).toEqual(["local-req-1-2"]);
    expect(statusOf(storage, "req-1-1")).toBe("merge_queued");
    expect(app.scheduler.snapshot().find((v) => v.ticket_id === "req-1-1")!.held_high_risk).toBe(
      true,
    );
    expect(
      notified.filter((t) => /重启后.*req-1-1.*放行不跨重启保存.*再放行一次/.test(t)),
    ).toHaveLength(1);
    // 理由和文件来自 N4 补判时那份 diff：每个 PR 只取一次 diff
    expect(app.supervisor.pendingHighRisk()).toEqual([
      {
        ticket_id: "req-1-1",
        project_id: "proj-1",
        pr_id: "local-req-1-1",
        reasons: ["dependency_file"],
        files: [{ path: "package.json" }],
        files_more: 0,
        held_at: expect.any(String),
      },
    ]);
    expect(diffCalls.filter((id) => id === "local-req-1-1")).toHaveLength(1);
    // 按 pr_id 绑定：旧 / 错的 pr_id 抛 stale_pr
    await expect(
      app.supervisor.decideHighRisk("req-1-1", "local-old", "release"),
    ).rejects.toMatchObject({ code: "stale_pr" });
    expect(calls.merge).toEqual(["local-req-1-2"]);
    expect(await app.supervisor.decideHighRisk("req-1-1", "local-req-1-1", "release")).toEqual({
      decision: "release",
      result: "released",
    });
    await app.scheduler.idle();
    expect(calls.merge).toEqual(["local-req-1-2", "local-req-1-1"]);
    expect(statusOf(storage, "req-1-1")).toBe("merged");
  });

  it("重启时取 diff 失败：按高风险扣着；AppDeps 传 holdHighRisk: false 也关不掉闸门", async () => {
    const { app, calls } = await restartSetup({
      diffFails: true,
      scheduler: { holdHighRisk: false },
    });
    await app.scheduler.idle();
    expect(calls.merge).toEqual(["local-req-1-2"]);
    expect(app.scheduler.snapshot().find((v) => v.ticket_id === "req-1-1")!.held_high_risk).toBe(
      true,
    );
  });

  it("拒绝：关掉 PR、单子 escalated、escalated(high_risk_rejected) 落库，主管交用户、不重拆", async () => {
    const { storage, app, closed, notified } = await restartSetup();
    await app.scheduler.idle();
    expect(
      await app.supervisor.decideHighRisk("req-1-1", "local-req-1-1", "reject", "不要删依赖"),
    ).toEqual({ decision: "reject", pr_close: "closed" });
    await vi.waitFor(() =>
      expect(notified.some((t) => /高风险 PR 被拒绝.*不重拆/.test(t))).toBe(true),
    );
    expect(closed).toEqual(["local-req-1-1"]);
    expect(statusOf(storage, "req-1-1")).toBe("escalated");
    expect(
      storage
        .queryEvents({ types: ["escalated"] })
        .map((e) => [e.ticket_id, (e.payload as { reason: string; detail?: string }).reason]),
    ).toEqual([["req-1-1", "high_risk_rejected"]]);
    expect(app.supervisor.pendingHighRisk()).toEqual([]);
  });

  it("拒绝时 6 的 sync 被限流：照样拒绝（escalated(high_risk_rejected)），本地 PR 记录不标关闭，记 unconfirmed，单子不再进合并队列", async () => {
    const { storage, app, calls, closed, pr } = await restartSetup();
    await app.scheduler.idle();
    const err = new GithubRateLimitError(429, "sync", 60000);
    pr.sync = async (): Promise<never> => {
      throw err;
    };
    expect(
      await app.supervisor.decideHighRisk("req-1-1", "local-req-1-1", "reject", "不要"),
    ).toEqual({ decision: "reject", pr_close: "unconfirmed" });
    expect(closed).toEqual([]);
    expect((await storage.prStore<TicketPrRecord>().get("local-req-1-1"))?.status).toBe("open");
    expect(statusOf(storage, "req-1-1")).toBe("escalated");
    expect(
      storage
        .queryEvents({ types: ["escalated"] })
        .map((e) => [e.ticket_id, (e.payload as { reason: string }).reason]),
    ).toEqual([["req-1-1", "high_risk_rejected"]]);
    expect(
      (storage.getTicket("req-1-1")!.fields as { high_risk_close?: { state: string } })
        .high_risk_close?.state,
    ).toBe("unconfirmed");
    await app.scheduler.idle();
    expect(calls.merge).not.toContain("local-req-1-1");
    expect(app.scheduler.snapshot().find((v) => v.ticket_id === "req-1-1")!.status).toBe(
      "escalated",
    );
  });

  it("反压暂停（待合并 PR 超限）时通知用户，写明其中几张是等裁决的高风险 PR", async () => {
    const notifiedAll: string[] = [];
    const { storage, worktreeRoot } = setup();
    for (const id of ["req-1-1", "req-1-2"]) {
      saveTicket(
        storage,
        id,
        "merge_queued",
        fields({ write_scope: [`lib/${id}/**`], kind: "dependency" }),
      );
      const path = join(worktreeRoot, `${id}-r0`);
      mkdirSync(path, { recursive: true });
      await storage
        .prStore<TicketPrRecord>()
        .put(prRec({ pr_id: `local-${id}`, ticket_id: id, worktree_path: path }));
    }
    saveTicket(storage, "req-1-3", "pending", fields({ write_scope: ["lib/c/**"] }));
    const runTicket = vi.fn(async () => ({
      status: "done" as const,
      summary: "",
      changed_files: [],
    }));
    const { pr } = fakePr();
    const { app } = await start({
      storage,
      worktreeRoot,
      pr,
      runTicket,
      notifyUser: (m) => void notifiedAll.push(m.text),
      config: (c) => ({ ...c, backpressure: { ...c.backpressure, pending_pr_limit: 1 } }),
    });
    await app.scheduler.dispatch();
    await vi.waitFor(() =>
      expect(notifiedAll.some((t) => t.startsWith("已暂停派新单"))).toBe(true),
    );
    const t = notifiedAll.find((x) => x.startsWith("已暂停派新单"))!;
    expect(t).toMatch(/待合并 PR 超过上限/);
    expect(t).toMatch(/待合并的 PR 共 2 张（上限 1），其中 2 张是等你裁决的高风险 PR/);
    // 一直暂停着：再跑几轮派单 / 合并循环也只通知一次
    for (let i = 0; i < 3; i++) {
      await app.scheduler.dispatch();
      await app.scheduler.sync();
      await app.scheduler.idle();
    }
    expect(notifiedAll.filter((x) => x.startsWith("已暂停派新单"))).toHaveLength(1);
    expect(runTicket).not.toHaveBeenCalled();
  });

  it("新单走完 8：kind: dependency 的单评审通过后被扣、不合并，通知用户等裁决", async () => {
    const { storage, worktreeRoot } = setup();
    saveTicket(storage, "req-1-1", "pending", fields({ kind: "dependency" }));
    const f = fakePr();
    const notified: string[] = [];
    const { app } = await start({
      storage,
      worktreeRoot,
      pr: f.pr,
      notifyUser: (m) => void notified.push(m.text),
    });
    await vi.waitFor(() => expect(statusOf(storage, "req-1-1")).toBe("merge_queued"), {
      timeout: 5000,
    });
    await app.scheduler.idle();
    expect(f.calls.merge).toEqual([]);
    expect(
      notified.some((t) =>
        /req-1-1 的 PR local-new-1 属于高风险 PR（依赖类单）.*等你放行或拒绝/.test(t),
      ),
    ).toBe(true);
  });
});

describe("T-064 closeTicketPrs 只关指定 PR + bakacoding 重试", () => {
  it("N5：传 pr_id 时只关那一个；同单其他 open PR 不动", async () => {
    const { storage } = setup();
    const store = storage.prStore<TicketPrRecord>();
    await store.put(prRec({ pr_id: "P1", ticket_id: "T" }));
    await store.put(prRec({ pr_id: "P2", ticket_id: "T" }));
    const closed: string[] = [];
    const pr = {
      close: async (id: string) => {
        closed.push(id);
        const r = (await store.get(id))!;
        await store.put({ ...r, status: "closed", closed_by: "bakacoding" as const });
      },
    };
    expect(await closeTicketPrs({ sync: async () => {}, store, pr }, "T", "拒绝", "P1")).toBe(
      "closed",
    );
    expect(closed).toEqual(["P1"]);
    expect((await store.get("P2"))!.status).toBe("open");
  });

  it("N5：关 P1 时同单已有 P2；不关 P2（蓝色大肥鱼要求的场景）", async () => {
    const { storage } = setup();
    const store = storage.prStore<TicketPrRecord>();
    await store.put(prRec({ pr_id: "P1", ticket_id: "T" }));
    await store.put(prRec({ pr_id: "P2", ticket_id: "T" }));
    const closed: string[] = [];
    expect(
      await closeTicketPrs(
        {
          sync: async () => {},
          store,
          pr: {
            close: async (id) => {
              closed.push(id);
            },
          },
        },
        "T",
        "拒绝",
        "P1",
      ),
    ).toBe("closed");
    expect(closed).toEqual(["P1"]);
  });

  it("N5 反向：不传 pr_id 时仍关本单所有 open（旧行为）", async () => {
    const { storage } = setup();
    const store = storage.prStore<TicketPrRecord>();
    await store.put(prRec({ pr_id: "P1", ticket_id: "T" }));
    await store.put(prRec({ pr_id: "P2", ticket_id: "T" }));
    const closed: string[] = [];
    await closeTicketPrs(
      { sync: async () => {}, store, pr: { close: async (id) => void closed.push(id) } },
      "T",
      "重拆",
    );
    expect(closed.sort()).toEqual(["P1", "P2"]);
  });

  it("B3/Q-6：本地已 closed_by bakacoding 时重试会再调 close", async () => {
    const { storage } = setup();
    const store = storage.prStore<TicketPrRecord>();
    await store.put(
      prRec({
        pr_id: "P1",
        ticket_id: "T",
        status: "closed",
        closed_by: "bakacoding",
        close_reason: "上次失败",
      }),
    );
    const close = vi.fn(async () => {});
    expect(
      await closeTicketPrs({ sync: async () => {}, store, pr: { close } }, "T", "重试", "P1"),
    ).toBe("closed");
    expect(close).toHaveBeenCalledOnce();
    // 不传 pr_id 的路径也同样重试
    close.mockClear();
    expect(await closeTicketPrs({ sync: async () => {}, store, pr: { close } }, "T", "重试")).toBe(
      "closed",
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("E2E B3/N5：模拟 6 的 close——先标本地 closed 再 PATCH 失败；重试 closeTicketPrs 再调 close 返回 closed", async () => {
    // 6（github.ts）：先 store.put(closed_by:bakacoding)，再 PATCH；失败时本地已是 closed、远程仍 open。
    const { storage } = setup();
    const store = storage.prStore<TicketPrRecord>();
    await store.put(
      prRec({
        pr_id: "P-gh",
        ticket_id: "T",
        status: "open",
        // 有 remote 才走 PATCH；这里用形状标记「像 GitHub 记录」
      }),
    );
    let patchOk = false;
    let patchAttempts = 0;
    const close = vi.fn(async (pr_id: string, reason: string) => {
      const rec = (await store.get(pr_id))!;
      if (rec.status === "merged") throw new Error("已合并");
      if (rec.status === "closed" && rec.closed_by !== "bakacoding") return;
      if (rec.status !== "closed") {
        await store.put({
          ...rec,
          status: "closed",
          closed_by: "bakacoding",
          close_reason: reason,
          updated_ts: "2026-10-17T12:00:00Z",
        });
      }
      // 模拟 PATCH
      patchAttempts++;
      if (!patchOk) throw new Error("PATCH /pulls/1 → 500");
      // 成功：远程已关，本地已是 closed
    });

    // 第一次：open → 标 closed → PATCH 失败，closeTicketPrs 把错抛出
    await expect(
      closeTicketPrs({ sync: async () => {}, store, pr: { close } }, "T", "拒绝", "P-gh"),
    ).rejects.toThrow(/500/);
    expect(patchAttempts).toBe(1);
    expect(await store.get("P-gh")).toMatchObject({
      status: "closed",
      closed_by: "bakacoding",
    });
    // 若没有 bakacoding 重试，下面会返回 none（反向检查）
    patchOk = true;
    expect(
      await closeTicketPrs({ sync: async () => {}, store, pr: { close } }, "T", "拒绝重试", "P-gh"),
    ).toBe("closed");
    expect(patchAttempts).toBe(2);
    expect(close).toHaveBeenCalledTimes(2);

    // 不传 pr_id 的路径：同一状态下也会重试
    await store.put(
      prRec({
        pr_id: "P-gh2",
        ticket_id: "U",
        status: "closed",
        closed_by: "bakacoding",
        close_reason: "上次",
      }),
    );
    patchAttempts = 0;
    patchOk = true;
    expect(
      await closeTicketPrs({ sync: async () => {}, store, pr: { close } }, "U", "重拆重试"),
    ).toBe("closed");
    expect(patchAttempts).toBe(1);
  });

  it("E2E B3 反向：无 bakacoding 重试时同状态只能得到 none（对照现行 closeTicketPrs）", async () => {
    // 若 N5 规则 5 被删，本地已 closed_by bakacoding 时会走 none，远程永远关不上。
    // 这里用「不含 bakacoding 分支」的对照实现证明：新 E2E 依赖的正是那条重试。
    const { storage } = setup();
    const store = storage.prStore<TicketPrRecord>();
    await store.put(
      prRec({
        pr_id: "P1",
        ticket_id: "T",
        status: "closed",
        closed_by: "bakacoding",
        close_reason: "上次 PATCH 失败",
      }),
    );
    const close = vi.fn(async () => {});
    async function closeTicketPrsNoBakacodingRetry(
      ticket_id: string,
      reason: string,
      only?: string,
    ): Promise<"closed" | "none" | "merged"> {
      if (only !== undefined) {
        const rec = await store.get(only);
        if (!rec || rec.kind !== "ticket" || rec.ticket_id !== ticket_id) return "none";
        if (rec.status === "merged") return "merged";
        if (rec.status === "open" || rec.status === "conflict") {
          await close(rec.pr_id, reason);
          return "closed";
        }
        return "none"; // ← 缺 bakacoding 重试
      }
      const mine = (await store.list()).filter(
        (r): r is TicketPrRecord => r.kind === "ticket" && r.ticket_id === ticket_id,
      );
      if (mine.some((r) => r.status === "merged")) return "merged";
      const open = mine.filter((r) => r.status === "open" || r.status === "conflict");
      if (open.length === 0) return "none";
      for (const r of open) await close(r.pr_id, reason);
      return "closed";
    }
    expect(await closeTicketPrsNoBakacodingRetry("T", "r", "P1")).toBe("none");
    expect(close).not.toHaveBeenCalled();
    // 现行实现必须再调 close → closed
    expect(
      await closeTicketPrs({ sync: async () => {}, store, pr: { close } }, "T", "r", "P1"),
    ).toBe("closed");
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("T-064 B2：adopt 发现已合入的 PR", () => {
  it("E2E：merge_queued 单的 PR 已是 merged → takeOver 记进 merged，下游不再 waiting；有 merge_sha 发 interface_changed", async () => {
    const { storage, worktreeRoot } = setup();
    // 上游：状态还是 merge_queued，但 PR 记录已 merged（停机期间用户合入 + sync 写了库）
    saveTicket(
      storage,
      "req-1-1",
      "merge_queued",
      fields({
        write_scope: ["lib/a/**"],
        interfaces: [{ file: "lib/a/x.ts", symbol: "foo" }],
      }),
    );
    const wt = join(worktreeRoot, "req-1-1-r0");
    mkdirSync(wt, { recursive: true });
    const mergeSha = "ab".repeat(20);
    await storage.prStore<TicketPrRecord>().put(
      prRec({
        pr_id: "pr-up",
        ticket_id: "req-1-1",
        status: "merged",
        worktree_path: wt,
        merge_sha: mergeSha,
      }),
    );
    saveTicket(
      storage,
      "req-1-2",
      "pending",
      fields({ write_scope: ["lib/b/**"], depends_on: ["req-1-1"] }),
    );

    const { pr } = fakePr();
    const { app } = await start({ storage, worktreeRoot, pr });
    // takeOver 在 assemble 里已跑完
    expect(app.takeOver.merged).toContain("req-1-1");
    expect(app.takeOver.adopted).not.toContain("req-1-1");
    expect(app.takeOver.failed.map((f) => f.ticket_id)).not.toContain("req-1-1");
    expect(app.scheduler.status("req-1-1")).toBe("merged");
    expect(statusOf(storage, "req-1-1")).toBe("merged");
    // 下游应已 enqueue，且依赖已 ready（9 里上游是 merged）
    expect(app.takeOver.enqueued).toContain("req-1-2");
    expect(app.scheduler.dependencyState("req-1-2")).toBe("ready");
    // interface_changed：合法 merge_sha 才发（announceMerge 在 adopt 同步路径已发）
    const fromStore = storage.queryEvents().filter((e) => e.type === "interface_changed");
    expect(fromStore.length).toBeGreaterThanOrEqual(1);
    expect(
      fromStore.some(
        (e) => e.payload && (e.payload as { base_commit?: string }).base_commit === mergeSha,
      ),
    ).toBe(true);
  });

  it("E2E 反向补充：无合法 merge_sha 时不发 interface_changed，仍记 merged", async () => {
    const { storage, worktreeRoot } = setup();
    saveTicket(storage, "req-1-1", "merge_queued", fields({ write_scope: ["lib/a/**"] }));
    const wt = join(worktreeRoot, "req-1-1-r0");
    mkdirSync(wt, { recursive: true });
    await storage.prStore<TicketPrRecord>().put(
      prRec({
        pr_id: "pr-up",
        ticket_id: "req-1-1",
        status: "merged",
        worktree_path: wt,
        // 无 merge_sha
      }),
    );
    const { pr } = fakePr();
    const { app } = await start({ storage, worktreeRoot, pr });
    expect(app.takeOver.merged).toContain("req-1-1");
    expect(app.scheduler.status("req-1-1")).toBe("merged");
    const fromStore = storage.queryEvents().filter((e) => e.type === "interface_changed");
    expect(fromStore).toEqual([]);
  });

  it("反向：没有 merged 记录时 adopt 仍失败", async () => {
    const { storage, worktreeRoot } = setup();
    saveTicket(storage, "req-1-3", "merge_queued", fields());
    const { pr } = fakePr();
    const { app } = await start({ storage, worktreeRoot, pr });
    expect(app.takeOver.failed.some((f) => f.ticket_id === "req-1-3")).toBe(true);
    expect(app.takeOver.merged).not.toContain("req-1-3");
  });
});
