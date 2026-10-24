// UI-05a：requirement:detail——只读 2 的 listTickets / listPrRounds，白名单字段、全部脱敏、需求名截 80 字、
// 错误只给固定文案；IPC 取 args[1]；BackendSwitcher 原样转发；只读后端固定失败。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openStorage, type Storage } from "@bakacoding/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type DesktopRequirementDetailResult } from "../shared/api.js";
import { serveRequirementDetail, type IpcMainLike } from "./ipc.js";
import { BackendSwitcher, readonlyBackend } from "./backend-switcher.js";
import type { BackendHandle } from "./backend.js";
import {
  readRequirementDetail,
  REQUIREMENT_DETAIL_FAILED,
  REQUIREMENT_DETAIL_INVALID,
  REQUIREMENT_DETAIL_NOT_FOUND,
  REQUIREMENT_DETAIL_UNAVAILABLE,
  type RequirementDetailStorage,
} from "./requirement-detail.js";

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
const ENV = { DEEPSEEK_API_KEY: SECRET };
const PATH = "/home/eva/.bakacoding/secret-repo/src/a.ts";
const diff = { base_sha: "a".repeat(40), head_sha: "b".repeat(40), files: [] };

let dir: string;
let s: Storage | null = null;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "bc-ui05a-"));
});
afterEach(() => {
  s?.close();
  s = null;
  rmSync(dir, { recursive: true, force: true });
});

function seed(): Storage {
  s = openStorage({ path: path.join(dir, "store.db") });
  const base = {
    project_id: "P-1",
    requirement_id: "R-1",
    base_commit: "a".repeat(40),
    permission_list: [],
    context_snippets: [],
  };
  s.saveTicket({
    ...base,
    ticket_id: "T-1",
    created_at: "2026-10-24T01:00:00.000Z",
    ticket_text: `\n给 Todo 加 due_date ${"长".repeat(120)}\n第二行`,
    decomposition_summary: `拆成两张，参考 ${PATH}`,
    status: "in_review",
    fields: {
      requirement_text: `需求原文 ${PATH} key=${SECRET}`,
      trace: "trace-secret-field",
      high_risk_close: "unconfirmed",
    },
  });
  s.saveTicket({
    ...base,
    ticket_id: "T-2",
    created_at: "2026-10-24T01:00:01.000Z",
    ticket_text: "第二张",
  });
  s.savePrRecord({
    ticket_id: "T-1",
    round: 1,
    diff,
    verdict: "fail",
    fail_reasons: [`缺测试 ${PATH}`],
    review_comments: `看 ${PATH}`,
    reviewer: "member-a",
  });
  s.savePrRecord({ ticket_id: "T-1", round: 2, diff, verdict: "pass", fail_reasons: [] });
  return s;
}

describe("readRequirementDetail（UI-05a）", () => {
  it("白名单字段：需求原文、拆单摘要、单号状态、各轮评审；不下发 fields 的其他键", () => {
    const r = readRequirementDetail(seed(), { requirement_id: "R-1", extra: 1 }, ENV);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.detail;
    expect(Object.keys(d).sort()).toEqual(
      ["decomposition_summary", "name", "requirement_id", "requirement_text", "tickets"].sort(),
    );
    expect(d.requirement_id).toBe("R-1");
    expect(d.tickets.map((t) => [t.ticket_id, t.status])).toEqual([
      ["T-1", "in_review"],
      ["T-2", "pending"],
    ]);
    expect(Object.keys(d.tickets[0]!).sort()).toEqual(["rounds", "status", "ticket_id"]);
    expect(d.tickets[0]!.rounds.map((x) => [x.round, x.verdict, x.reviewer])).toEqual([
      [1, "fail", "member-a"],
      [2, "pass", null],
    ]);
    expect(Object.keys(d.tickets[0]!.rounds[0]!).sort()).toEqual(
      ["fail_reasons", "review_comments", "reviewer", "round", "verdict"].sort(),
    );
    expect(d.tickets[0]!.rounds[1]!.review_comments).toBeNull();
    expect(d.tickets[1]!.rounds).toEqual([]);
    const json = JSON.stringify(r);
    expect(json).not.toContain("trace-secret-field");
    expect(json).not.toContain("high_risk_close");
    expect(json).not.toContain("diff");
    expect(json).not.toContain("head_sha");
  });

  it("所有文本都脱敏：不带路径、不带密钥", () => {
    const r = readRequirementDetail(seed(), { requirement_id: "R-1" }, ENV);
    if (!r.ok) throw new Error("应成功");
    const json = JSON.stringify(r);
    expect(json).not.toContain("/home/eva");
    expect(json).not.toContain("secret-repo");
    expect(json).not.toContain(SECRET);
    expect(r.detail.requirement_text).toContain("需求原文");
    expect(r.detail.decomposition_summary).toContain("拆成两张");
    expect(r.detail.tickets[0]!.rounds[0]!.fail_reasons[0]).toContain("缺测试");
  });

  it("需求名取第一张单原文首个非空行，截到 80 字", () => {
    const r = readRequirementDetail(seed(), { requirement_id: "R-1" }, ENV);
    if (!r.ok) throw new Error("应成功");
    expect(r.detail.name.startsWith("给 Todo 加 due_date")).toBe(true);
    expect([...r.detail.name].length).toBe(80);
    expect(r.detail.name.endsWith("…")).toBe(true);
    expect(r.detail.name).not.toContain("第二行");
  });

  it("没有 requirement_text / 摘要时为 null；旧单 fields 为 null 也能读", () => {
    s = openStorage({ path: path.join(dir, "store.db") });
    s.saveTicket({
      ticket_id: "T-9",
      project_id: "P-1",
      requirement_id: "R-9",
      created_at: "2026-10-24T01:00:00.000Z",
      ticket_text: "短标题",
      base_commit: "a".repeat(40),
      permission_list: [],
      context_snippets: [],
    });
    const r = readRequirementDetail(s, { requirement_id: "R-9" }, ENV);
    expect(r).toEqual({
      ok: true,
      detail: {
        requirement_id: "R-9",
        name: "短标题",
        requirement_text: null,
        decomposition_summary: null,
        tickets: [{ ticket_id: "T-9", status: "pending", rounds: [] }],
      },
    });
  });

  it("错误都是固定文案：不带路径、不带用户输入", () => {
    const evil = `R-${PATH}`;
    expect(readRequirementDetail(undefined, { requirement_id: "R-1" }, ENV)).toEqual({
      ok: false,
      reason: REQUIREMENT_DETAIL_UNAVAILABLE,
    });
    for (const q of [null, "R-1", {}, { requirement_id: "" }, { requirement_id: 3 }]) {
      expect(readRequirementDetail(seed(), q, ENV)).toEqual({
        ok: false,
        reason: REQUIREMENT_DETAIL_INVALID,
      });
      s?.close();
      s = null;
      rmSync(path.join(dir, "store.db"), { force: true });
    }
    expect(readRequirementDetail(seed(), { requirement_id: evil }, ENV)).toEqual({
      ok: false,
      reason: REQUIREMENT_DETAIL_NOT_FOUND,
    });
    const boom: RequirementDetailStorage = {
      listTickets: () => {
        throw new Error(`SQLITE_CORRUPT at ${PATH} ${evil}`);
      },
      listPrRounds: () => [],
    };
    const r = readRequirementDetail(boom, { requirement_id: evil }, ENV);
    expect(r).toEqual({ ok: false, reason: REQUIREMENT_DETAIL_FAILED });
    expect(JSON.stringify(r)).not.toContain("/home/eva");
  });

  it("只用 listTickets({requirement_id}) 和 listPrRounds 两个只读方法", () => {
    const listTickets = vi.fn(() => []);
    const listPrRounds = vi.fn(() => []);
    readRequirementDetail({ listTickets, listPrRounds }, { requirement_id: "R-1" }, ENV);
    expect(listTickets).toHaveBeenCalledWith({ requirement_id: "R-1" });
  });
});

describe("serveRequirementDetail / switcher / 只读后端（UI-05a）", () => {
  function fakeIpc() {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipc: IpcMainLike = {
      handle: (c, h) => void handlers.set(c, h),
      removeHandler: (c) => void handlers.delete(c),
    };
    return { ipc, handlers };
  }
  const OK: DesktopRequirementDetailResult = {
    ok: true,
    detail: {
      requirement_id: "R-1",
      name: "n",
      requirement_text: null,
      decomposition_summary: null,
      tickets: [],
    },
  };

  it("event 不当参数：args[1] 交给后端；停掉后注销", async () => {
    const { ipc, handlers } = fakeIpc();
    const requirementDetail = vi.fn(async () => OK);
    const stop = serveRequirementDetail(ipc, { requirementDetail });
    const h = handlers.get(IPC_CHANNELS.requirementDetail)!;
    await expect(h({ sender: {} }, { requirement_id: "R-1" })).resolves.toEqual(OK);
    expect(requirementDetail).toHaveBeenCalledWith({ requirement_id: "R-1" });
    stop();
    expect(handlers.has(IPC_CHANNELS.requirementDetail)).toBe(false);
  });

  it("BackendSwitcher.requirementDetail 原样转给当前后端，结果原样返回", async () => {
    const requirementDetail = vi.fn(async () => OK);
    const current = {
      onNotify: () => () => {},
      onPendingHighRisk: () => () => {},
      requirementDetail,
    } as unknown as BackendHandle;
    const sw = new BackendSwitcher(current, async () => current);
    const q = { requirement_id: "R-1" };
    await expect(sw.requirementDetail(q)).resolves.toEqual(OK);
    expect(requirementDetail).toHaveBeenCalledWith(q);
  });

  it("只读后端：固定失败，不带路径", async () => {
    const b = readonlyBackend("/repo/secret-path", "缺少环境变量 DEEPSEEK_API_KEY");
    const r = await b.requirementDetail({ requirement_id: "R-1" });
    expect(r).toEqual({ ok: false, reason: REQUIREMENT_DETAIL_UNAVAILABLE });
    expect(JSON.stringify(r)).not.toContain("/repo");
  });
});
