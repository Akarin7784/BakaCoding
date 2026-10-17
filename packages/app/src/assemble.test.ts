// T-041a：组合根。真实的 0 总线、2 存储（SQLite）、8 / 9 / 10；5 / 7 / 6 / 4 的 worktree 用替身。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "@bakacoding/config-budget";
import type { CoderPool } from "@bakacoding/coder-pool";
import type { PrProvider, TicketPrRecord } from "@bakacoding/pr";
import { openStorage, type Storage, type TicketFields } from "@bakacoding/storage";
import type { BakaEvent, TicketStatus } from "@bakacoding/types";
import { requestWriteScope } from "@bakacoding/workspace";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assemble, type App, type AppDeps } from "./index.js";
import { currentTicketPr } from "./assemble.js";

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
}

async function start(o: Opts) {
  const created: string[] = [];
  const runTicket =
    o.runTicket ??
    (async () => ({ status: "done" as const, summary: "写好了", changed_files: ["lib/a/x.ts"] }));
  const app = await assemble({
    config: getConfig(examplePath),
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
    scheduler: { dispatch_poll_ms: 0 },
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
    expect(stored.map((e) => e.event_id).sort()).toEqual(seen.map((e) => e.event_id).sort());
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

  it("fields 无效的单不接回、只发一次 ticket_warning(fields_invalid)，不重拆、不上报；已上报的单只列出；没有 PR 记录的不 adopt", async () => {
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
