// UI-06c：git:status 只读查询——错误码固定文案、无路径、只读固定 ok:false；P3 常量一致。
import {
  BranchStatusError,
  DEFAULT_INTEGRATION_BRANCH,
  type BranchStatusCode,
} from "@bakacoding/app";
import { INTEGRATION_BRANCH } from "@bakacoding/pr";
import { describe, expect, it, vi } from "vitest";
import { readonlyBackend } from "./backend-switcher.js";
import {
  GIT_STATUS_CODE_TEXT,
  GIT_STATUS_FAILED,
  GIT_STATUS_UNAVAILABLE,
  readGitStatus,
} from "./git-status.js";

const ROOT = "/home/secret-user/repo";

describe("P3：模块 4 与模块 6 的集成分支常量一致", () => {
  it("DEFAULT_INTEGRATION_BRANCH === INTEGRATION_BRANCH", () => {
    expect(DEFAULT_INTEGRATION_BRANCH).toBe(INTEGRATION_BRANCH);
  });
});

describe("readGitStatus", () => {
  it("成功：传 6 的集成分支，回带 main_merge", async () => {
    const branchStatus = vi.fn(async () => ({ current_branch: "feat/x", ahead: 3 }));
    const r = await readGitStatus({ repoRoot: ROOT, mainMerge: "supervisor", branchStatus });
    expect(branchStatus).toHaveBeenCalledWith(ROOT, { integration_branch: INTEGRATION_BRANCH });
    expect(r).toEqual({
      ok: true,
      current_branch: "feat/x",
      integration_branch: INTEGRATION_BRANCH,
      ahead: 3,
      main_merge: "supervisor",
    });
  });

  it("分离 HEAD：current_branch 为 null", async () => {
    const r = await readGitStatus({
      repoRoot: ROOT,
      mainMerge: "user",
      branchStatus: async () => ({ current_branch: null, ahead: 0 }),
    });
    expect(r).toMatchObject({ ok: true, current_branch: null, ahead: 0 });
  });

  it("未接线 / 只读：固定 ok:false", async () => {
    expect(await readGitStatus(undefined)).toEqual({ ok: false, reason: GIT_STATUS_UNAVAILABLE });
  });

  const codes = Object.keys(GIT_STATUS_CODE_TEXT) as BranchStatusCode[];
  it.each(codes)("错误码 %s → 固定文案，不含路径", async (code) => {
    const r = await readGitStatus({
      repoRoot: ROOT,
      mainMerge: "user",
      branchStatus: async () => {
        throw new BranchStatusError(code);
      },
    });
    expect(r).toEqual({ ok: false, reason: GIT_STATUS_CODE_TEXT[code] });
    expect(JSON.stringify(r)).not.toContain("secret-user");
  });

  it("非 BranchStatusError（含路径原文）→ 通用固定文案", async () => {
    const r = await readGitStatus({
      repoRoot: ROOT,
      mainMerge: "user",
      branchStatus: async () => {
        throw Object.assign(new Error(`EACCES ${ROOT}`), { code: "not_git" });
      },
    });
    expect(r).toEqual({ ok: false, reason: GIT_STATUS_FAILED });
    expect(JSON.stringify(r)).not.toContain("secret-user");
  });

  it("文案表本身不含路径分隔符", () => {
    for (const t of Object.values(GIT_STATUS_CODE_TEXT)) expect(t).not.toMatch(/[\\/]/);
  });
});

describe("只读后端", () => {
  it("gitStatus 固定 ok:false", async () => {
    const be = readonlyBackend(ROOT, "只读");
    await expect(be.gitStatus()).resolves.toEqual({ ok: false, reason: GIT_STATUS_UNAVAILABLE });
  });
});
