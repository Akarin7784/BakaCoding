// UI-07e：ledger:summary 的主进程 handler——确实调 3 的 ledgerSummary、只回 id / 名称 / 累计，不带路径，
// 空列表、只读、抛错都回固定形状。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerBreakdown } from "@bakacoding/types";

const spy = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("@bakacoding/config-budget", async (orig) => {
  const real = await orig<typeof import("@bakacoding/config-budget")>();
  return {
    ...real,
    ledgerSummary: vi.fn((...args: Parameters<typeof real.ledgerSummary>) => {
      spy.calls.push(args);
      return real.ledgerSummary(...args);
    }),
  };
});

const { PROJECT_TEXT, projectListHandlers } = await import("./project-list-ipc.js");
type Deps = Parameters<typeof projectListHandlers>[0];

const breakdown = (total: number, resubmit = 0): LedgerBreakdown => ({
  total_micro_usd: total,
  resubmit_micro_usd: resubmit,
  entries: 3,
  by_role: { supervisor: 0, reviewer: 0, sub_agent: 0, coder: total },
});
const row = (id: string, repo_path: string | null) => ({
  project_id: id,
  name: `n-${id}`,
  created_at: "2026-10-24T00:00:00.000Z",
  repo_path,
});

function deps(over: Partial<Deps["backend"]> = {}) {
  const warns: string[] = [];
  const totals: Record<string, LedgerBreakdown> = {
    "p-1": breakdown(1_500_000, 250_000),
    "p-2": breakdown(0),
  };
  const ledger = { totalsByProject: vi.fn(async (id: string) => totals[id] ?? breakdown(0)) };
  const backend: Deps["backend"] = {
    status: vi.fn(() => ({ mode: "live" }) as never),
    listProjects: vi.fn(() => [
      row("p-1", "/home/eva/secret/repo"),
      row("p-2", "C:\\Users\\eva\\r"),
    ]),
    removeProject: vi.fn(async () => ({ removed: true })),
    ledgerStore: vi.fn(() => ledger),
    ...over,
  };
  const h = projectListHandlers({
    backend,
    openPath: async () => "",
    warn: (m) => void warns.push(m),
  });
  return { h, ledger, warns };
}

beforeEach(() => {
  spy.calls.length = 0;
});

describe("ledger:summary", () => {
  it("对每个项目调真实的 ledgerSummary（project_id 对应），按存储顺序回累计", async () => {
    const { h, ledger } = deps();
    const r = await h.summary();
    expect(spy.calls.map((c) => c[1])).toEqual([{ project_id: "p-1" }, { project_id: "p-2" }]);
    expect(spy.calls[0]![0]).toBe(ledger);
    expect(ledger.totalsByProject).toHaveBeenCalledTimes(2);
    expect(r).toEqual({
      ok: true,
      projects: [
        { project_id: "p-1", name: "n-p-1", ...breakdown(1_500_000, 250_000) },
        { project_id: "p-2", name: "n-p-2", ...breakdown(0) },
      ],
    });
  });

  it("返回里没有路径、没有 today，每行只有白名单字段", async () => {
    const { h } = deps();
    const r = await h.summary();
    const s = JSON.stringify(r);
    expect(s).not.toContain("/home/eva");
    expect(s).not.toContain("Users");
    expect(s).not.toContain("repo_path");
    expect(s).not.toContain("today");
    if (!r.ok) throw new Error("应为 ok");
    for (const p of r.projects)
      expect(Object.keys(p).sort()).toEqual(
        [
          "by_role",
          "entries",
          "name",
          "project_id",
          "resubmit_micro_usd",
          "total_micro_usd",
        ].sort(),
      );
  });

  it("没有项目：ok 空列表，不调 ledgerSummary", async () => {
    const { h } = deps({ listProjects: vi.fn(() => []) });
    await expect(h.summary()).resolves.toEqual({ ok: true, projects: [] });
    expect(spy.calls).toHaveLength(0);
  });

  it.each([
    ["没有台账", { ledgerStore: vi.fn(() => null) }],
    ["没有存储", { listProjects: vi.fn(() => null) }],
  ])("只读（%s）：回固定文案", async (_n, over) => {
    const { h } = deps(over);
    await expect(h.summary()).resolves.toEqual({ ok: false, reason: PROJECT_TEXT.ledgerReadonly });
    expect(spy.calls).toHaveLength(0);
  });

  it("台账抛错：回失败原因，日志只记错误名，不带路径和原始信息", async () => {
    const err = new RangeError("boom at /home/eva/secret/db.sqlite");
    const { h, warns } = deps({
      ledgerStore: vi.fn(() => ({
        totalsByProject: async () => {
          throw err;
        },
      })),
    });
    await expect(h.summary()).resolves.toEqual({ ok: false, reason: PROJECT_TEXT.ledgerFailed });
    expect(warns).toEqual(["读取项目花费失败（RangeError）"]);
    expect(warns.join()).not.toContain("/home/eva");
  });
});
