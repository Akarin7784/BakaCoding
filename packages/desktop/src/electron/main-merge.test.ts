// UI-06d：main:merge——head_sha 原样透传给 10 的 mergeMain（by:"user"），MainMergeError.code 固定文案、
// 不透出原始错误 / 路径；只读固定 ok:false；IPC 取 args[1]；BackendSwitcher 原样转发 mainMerge 和 gitStatus（P3）。
import { MainMergeError, type MainMergeErrorCode } from "@bakacoding/supervisor";
import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../shared/api.js";
import { BackendSwitcher, readonlyBackend } from "./backend-switcher.js";
import type { BackendHandle } from "./backend.js";
import { serveMainMerge, type IpcMainLike } from "./ipc.js";
import {
  MAIN_MERGE_CODE_TEXT,
  MAIN_MERGE_FAILED,
  MAIN_MERGE_INVALID,
  MAIN_MERGE_UNAVAILABLE,
  runMainMerge,
} from "./main-merge.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const CODES: MainMergeErrorCode[] = [
  "unavailable",
  "not_reviewed",
  "stale_head",
  "conflict",
  "merge_blocked",
  "rate_limit",
  "target_dirty",
  "error",
];

describe("runMainMerge", () => {
  it("head_sha 原样透传，by 固定 user；merged 回带 sha", async () => {
    const fn = vi.fn(async () => ({
      result: "merged" as const,
      pr_id: "pr-int",
      sha: "f".repeat(40),
    }));
    await expect(runMainMerge(fn, { head_sha: SHA })).resolves.toEqual({
      ok: true,
      result: "merged",
      sha: "f".repeat(40),
    });
    expect(fn).toHaveBeenCalledWith({ by: "user", head_sha: SHA });
  });

  it("notified → ok:true result:notified（不带原因原文）", async () => {
    const fn = vi.fn(async () => ({ result: "notified" as const, reason: "/home/x 在 main" }));
    await expect(runMainMerge(fn, { head_sha: SHA })).resolves.toEqual({
      ok: true,
      result: "notified",
    });
  });

  it("未接线 → 固定 unavailable，不调 mergeMain", async () => {
    await expect(runMainMerge(undefined, { head_sha: SHA })).resolves.toEqual({
      ok: false,
      code: "unavailable",
      reason: MAIN_MERGE_UNAVAILABLE,
    });
  });

  it.each([
    undefined,
    null,
    {},
    { head_sha: 1 },
    { head_sha: "abc1234" },
    { head_sha: SHA.toUpperCase() },
  ])("参数不对（%j）→ invalid，不调 mergeMain", async (input) => {
    const fn = vi.fn();
    await expect(runMainMerge(fn, input)).resolves.toEqual({
      ok: false,
      code: "invalid",
      reason: MAIN_MERGE_INVALID,
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it.each(CODES)("MainMergeError %s → 固定文案，不透出原始 message", async (code) => {
    const fn = vi.fn(async () => {
      throw new MainMergeError(code, "main 工作区不干净：/home/secret-user/repo");
    });
    const r = await runMainMerge(fn, { head_sha: SHA });
    expect(r).toEqual({ ok: false, code, reason: MAIN_MERGE_CODE_TEXT[code] });
    expect(JSON.stringify(r)).not.toContain("secret-user");
  });

  it("文案穷举 MainMergeErrorCode，各不相同且不含路径", () => {
    expect(Object.keys(MAIN_MERGE_CODE_TEXT).sort()).toEqual([...CODES].sort());
    const texts = CODES.filter((c) => c !== "error").map((c) => MAIN_MERGE_CODE_TEXT[c]);
    expect(new Set(texts).size).toBe(texts.length);
    for (const t of Object.values(MAIN_MERGE_CODE_TEXT)) expect(t).not.toMatch(/[/\\]/);
  });

  it("其他异常 / 伪造 code → 固定「合入 main 失败」", async () => {
    for (const err of [
      new Error("EACCES /home/secret-user"),
      { name: "MainMergeError", code: "boom" },
    ]) {
      const r = await runMainMerge(async () => Promise.reject(err), { head_sha: SHA });
      expect(r).toEqual({ ok: false, code: "error", reason: MAIN_MERGE_FAILED });
    }
  });
});

describe("main:merge IPC / 后端", () => {
  it("handler 取 args[1] 原样给 backend.mainMerge；停止后移除", async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipc = {
      handle: (c: string, h: (...a: unknown[]) => unknown) => handlers.set(c, h),
      removeHandler: (c: string) => handlers.delete(c),
    } as unknown as IpcMainLike;
    const mainMerge = vi.fn(async () => ({ ok: true as const, result: "notified" as const }));
    const stop = serveMainMerge(ipc, { mainMerge });
    const h = handlers.get(IPC_CHANNELS.mainMerge)!;
    await expect(h({ sender: {} }, { head_sha: SHA })).resolves.toEqual({
      ok: true,
      result: "notified",
    });
    expect(mainMerge).toHaveBeenCalledWith({ head_sha: SHA });
    stop();
    expect(handlers.has(IPC_CHANNELS.mainMerge)).toBe(false);
  });

  it("只读后端固定 unavailable", async () => {
    await expect(readonlyBackend("/r", "x").mainMerge({ head_sha: SHA })).resolves.toEqual({
      ok: false,
      code: "unavailable",
      reason: MAIN_MERGE_UNAVAILABLE,
    });
  });

  it("BackendSwitcher.mainMerge 原样转给当前后端", async () => {
    const mainMerge = vi.fn(async () => ({
      ok: true as const,
      result: "merged" as const,
      sha: SHA,
    }));
    const current = {
      onNotify: () => () => {},
      onPendingHighRisk: () => () => {},
      mainMerge,
    } as unknown as BackendHandle;
    const sw = new BackendSwitcher(current, async () => current);
    await expect(sw.mainMerge({ head_sha: SHA })).resolves.toEqual({
      ok: true,
      result: "merged",
      sha: SHA,
    });
    expect(mainMerge).toHaveBeenCalledWith({ head_sha: SHA });
  });

  it("P3：BackendSwitcher.gitStatus 原样转给当前后端", async () => {
    const st = {
      ok: true as const,
      current_branch: "feat/x",
      integration_branch: "bakacoding/integration",
      ahead: 4,
      main_merge: "user" as const,
    };
    const gitStatus = vi.fn(async () => st);
    const current = {
      onNotify: () => () => {},
      onPendingHighRisk: () => () => {},
      gitStatus,
    } as unknown as BackendHandle;
    const sw = new BackendSwitcher(current, async () => current);
    await expect(sw.gitStatus()).resolves.toEqual(st);
    expect(gitStatus).toHaveBeenCalledTimes(1);
  });
});
