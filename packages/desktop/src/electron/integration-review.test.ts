// UI-06d2：integration:review——调 10 的 reviewIntegration({project_id})，只回 result + head_sha / 原因码（单号、CI 链接、detail、file 不出主进程）；
// 抛 MainMergeError 按 code 固定文案，其他异常固定文案；只读固定 unavailable；IPC 取 args[1] 原样；
// P3：main:merge 的 IPC 层把参数原样（同一个对象）交给后端；sha 大写转小写后校验。
import { MainMergeError, type IntegrationReview } from "@bakacoding/supervisor";
import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../shared/api.js";
import { BackendSwitcher, readonlyBackend } from "./backend-switcher.js";
import type { BackendHandle } from "./backend.js";
import {
  INTEGRATION_REVIEW_FAILED,
  INTEGRATION_REVIEW_UNAVAILABLE,
  runIntegrationReview,
} from "./integration-review.js";
import { serveIntegrationReview, serveMainMerge, type IpcMainLike } from "./ipc.js";
import { MAIN_MERGE_CODE_TEXT, MAIN_MERGE_INVALID, runMainMerge } from "./main-merge.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OK: IntegrationReview = {
  result: "ok",
  pr_id: "pr-int",
  head_sha: SHA,
  base_sha: "b".repeat(40),
  summary: "可以合",
  ci: "green",
};

const R_OK = { result: "ok" as const, head_sha: SHA };
const R_BLOCKED = { result: "blocked" as const, reasons: ["tickets_in_flight" as const] };

const fakeIpc = () => {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const ipc = {
    handle: (c: string, h: (...a: unknown[]) => unknown) => handlers.set(c, h),
    removeHandler: (c: string) => handlers.delete(c),
  } as unknown as IpcMainLike;
  return { ipc, handlers };
};

describe("runIntegrationReview", () => {
  it("ok → 只回 result + head_sha，project_id 透传", async () => {
    const fn = vi.fn(async () => OK);
    const r = await runIntegrationReview(fn, { project_id: "p-1" });
    expect(r).toStrictEqual({ ok: true, review: { result: "ok", head_sha: SHA } });
    expect(fn).toHaveBeenCalledWith({ project_id: "p-1" });
  });

  it("blocked → 只回原因码（去重、丢掉认不出的码）；ticket_ids / url / detail / file 不出主进程", async () => {
    const SECRETS = [
      "T-SECRET-1",
      "https://ci.example/secret-run",
      "模型原文 secret",
      "/home/secret/f.ts",
    ];
    const raw = {
      result: "blocked",
      pr_id: "pr-secret",
      head_sha: null,
      summary: "summary secret",
      reasons: [
        { code: "tickets_in_flight", ticket_ids: [SECRETS[0]] },
        { code: "ci_failed", checks: [{ name: "ci", url: SECRETS[1] }] },
        { code: "model_blocked", items: [{ detail: SECRETS[2], file: SECRETS[3] }] },
        { code: "ci_failed", checks: [] },
        { code: "forged_code", detail: "x" },
      ],
    } as unknown as IntegrationReview;
    const r = await runIntegrationReview(async () => raw, {});
    expect(r).toStrictEqual({
      ok: true,
      review: { result: "blocked", reasons: ["tickets_in_flight", "ci_failed", "model_blocked"] },
    });
    const json = JSON.stringify(r);
    for (const k of [
      "ticket_ids",
      "checks",
      "url",
      "items",
      "detail",
      "file",
      "pr_id",
      "summary",
      "base_sha",
      "ci",
    ])
      expect(json).not.toContain(`"${k}"`);
    for (const s of [...SECRETS, "pr-secret", "summary secret"]) expect(json).not.toContain(s);
  });

  it("ok 结果里的 pr_id / base_sha / summary / ci 也不出主进程", async () => {
    const r = await runIntegrationReview(
      async () => ({ ...OK, extra: "/home/secret" }) as IntegrationReview,
      {},
    );
    expect(Object.keys(r.ok ? r.review : {})).toEqual(["result", "head_sha"]);
    expect(JSON.stringify(r)).not.toMatch(/pr-int|secret|可以合|green/);
  });

  it("认不出的结果形状 → 固定失败文案", async () => {
    const r = await runIntegrationReview(
      async () => ({ result: "weird" }) as unknown as IntegrationReview,
      {},
    );
    expect(r).toEqual({ ok: false, code: "error", reason: INTEGRATION_REVIEW_FAILED });
  });

  it("没有 project_id / 不是字符串 → 不带 project_id 调用", async () => {
    const fn = vi.fn(async () => OK);
    await runIntegrationReview(fn, { project_id: 3 });
    await runIntegrationReview(fn, undefined);
    expect(fn.mock.calls).toEqual([[{}], [{}]]);
  });

  it("未接线 → 固定 unavailable，不调用", async () => {
    await expect(runIntegrationReview(undefined, {})).resolves.toEqual({
      ok: false,
      code: "unavailable",
      reason: INTEGRATION_REVIEW_UNAVAILABLE,
    });
  });

  it("MainMergeError unavailable → 固定文案，不透出原始 message", async () => {
    const r = await runIntegrationReview(async () => {
      throw new MainMergeError("unavailable", "没有注入 pr：/home/secret-user");
    }, {});
    expect(r).toEqual({ ok: false, code: "unavailable", reason: MAIN_MERGE_CODE_TEXT.unavailable });
  });

  it("其他异常 / 伪造 code → 固定「审查集成分支失败」", async () => {
    for (const err of [
      new Error("EACCES /home/secret-user"),
      { name: "MainMergeError", code: "boom" },
      new MainMergeError("error", "/home/secret-user"),
    ]) {
      const r = await runIntegrationReview(async () => Promise.reject(err), {});
      expect(r).toEqual({ ok: false, code: "error", reason: INTEGRATION_REVIEW_FAILED });
    }
  });
});

describe("integration:review IPC / 后端", () => {
  it("handler 取 args[1] 原样给 backend.integrationReview；停止后移除", async () => {
    const { ipc, handlers } = fakeIpc();
    const integrationReview = vi.fn(async () => ({ ok: true as const, review: R_OK }));
    const stop = serveIntegrationReview(ipc, { integrationReview });
    const req = { project_id: "p-1" };
    await expect(
      handlers.get(IPC_CHANNELS.integrationReview)!({ sender: {} }, req),
    ).resolves.toEqual({ ok: true, review: R_OK });
    expect(integrationReview.mock.calls[0]![0]).toBe(req);
    stop();
    expect(handlers.has(IPC_CHANNELS.integrationReview)).toBe(false);
  });

  it("渲染端经 IPC 拿到的对象只有 ok / result / head_sha / 原因码，没有 ticket_ids、url、detail、file", async () => {
    const { ipc, handlers } = fakeIpc();
    const raw = {
      result: "blocked",
      pr_id: "pr-x",
      head_sha: null,
      reasons: [
        { code: "tickets_in_flight", ticket_ids: ["T-9"] },
        { code: "ci_failed", checks: [{ name: "ci", url: "https://ci/x" }] },
        { code: "model_blocked", items: [{ detail: "d", file: "f.ts" }] },
      ],
    } as unknown as IntegrationReview;
    serveIntegrationReview(ipc, {
      integrationReview: (i) => runIntegrationReview(async () => raw, i),
    });
    const got = (await handlers.get(IPC_CHANNELS.integrationReview)!({ sender: {} }, {})) as {
      review: { reasons: unknown[] };
    };
    expect(Object.keys(got)).toEqual(["ok", "review"]);
    expect(Object.keys(got.review)).toEqual(["result", "reasons"]);
    expect(got.review.reasons).toEqual(["tickets_in_flight", "ci_failed", "model_blocked"]);
    const walk = (v: unknown): string[] =>
      v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...walk(x)]) : [];
    for (const k of ["ticket_ids", "checks", "url", "items", "detail", "file", "pr_id"])
      expect(walk(got)).not.toContain(k);
  });

  it("只读后端固定 unavailable", async () => {
    await expect(readonlyBackend("/r", "x").integrationReview({})).resolves.toEqual({
      ok: false,
      code: "unavailable",
      reason: INTEGRATION_REVIEW_UNAVAILABLE,
    });
  });

  it("BackendSwitcher.integrationReview 原样转给当前后端", async () => {
    const integrationReview = vi.fn(async () => ({ ok: true as const, review: R_BLOCKED }));
    const current = {
      onNotify: () => () => {},
      onPendingHighRisk: () => () => {},
      integrationReview,
    } as unknown as BackendHandle;
    const sw = new BackendSwitcher(current, async () => current);
    const req = { project_id: "p-1" };
    await expect(sw.integrationReview(req)).resolves.toEqual({ ok: true, review: R_BLOCKED });
    expect(integrationReview.mock.calls[0]![0]).toBe(req);
  });
});

describe("P3：main:merge IPC 层参数原样透传", () => {
  it("handler 把 args[1] 这个对象本身交给 backend.mainMerge（不重建、不挑字段）", async () => {
    const { ipc, handlers } = fakeIpc();
    const mainMerge = vi.fn(async () => ({ ok: true as const, result: "notified" as const }));
    serveMainMerge(ipc, { mainMerge });
    for (const req of [{ head_sha: SHA }, { head_sha: SHA.toUpperCase(), extra: 1 }, "x", null]) {
      mainMerge.mockClear();
      await handlers.get(IPC_CHANNELS.mainMerge)!({ sender: {} }, req);
      expect(mainMerge).toHaveBeenCalledTimes(1);
      expect(mainMerge.mock.calls[0]![0]).toBe(req);
    }
  });
});

describe("P3：sha 接受大写，转小写后校验并透传", () => {
  it.each([SHA.toUpperCase(), "0123456789ABCDEF0123456789abcdef01234567"])(
    "%s → 小写透传",
    async (head_sha) => {
      const fn = vi.fn(async () => ({ result: "notified" as const }));
      await expect(runMainMerge(fn, { head_sha })).resolves.toEqual({
        ok: true,
        result: "notified",
      });
      expect(fn).toHaveBeenCalledWith({ by: "user", head_sha: SHA });
    },
  );

  it.each(["G".repeat(40), SHA.toUpperCase() + "0", "ABC1234"])(
    "%s 仍然 invalid",
    async (head_sha) => {
      const fn = vi.fn();
      await expect(runMainMerge(fn, { head_sha })).resolves.toEqual({
        ok: false,
        code: "invalid",
        reason: MAIN_MERGE_INVALID,
      });
      expect(fn).not.toHaveBeenCalled();
    },
  );
});
