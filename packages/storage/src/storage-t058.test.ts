// T-058：prStore 凭据检查收窄——普通用户名放行，真凭据照样整条拒写。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PrRecord } from "@bakacoding/pr";
import { openStorage, PR_STRUCTURAL_FIELDS, type Storage } from "./index.js";

let dirs: string[] = [];
let opened: Storage[] = [];
afterEach(() => {
  for (const s of opened) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  opened = [];
});
function open(): Storage {
  const d = mkdtempSync(join(tmpdir(), "bc-storage-058-"));
  dirs.push(d);
  const s = openStorage({ path: join(d, "bakacoding.db") });
  opened.push(s);
  return s;
}
const base = {
  pr_id: "pr-1",
  kind: "ticket" as const,
  ticket_id: "T-1",
  branch: "bc/T-1",
  base_branch: "integration",
  base_sha: "a".repeat(40),
  head_sha: "b".repeat(40),
  status: "open" as const,
  worktree_path: "/wt/T-1",
  created_ts: "2026-10-17T00:00:00.000Z",
  updated_ts: "2026-10-17T00:00:00.000Z",
};
type Rec = PrRecord & { remote?: { number: number; url: string } };

describe("prStore 凭据检查（T-058）", () => {
  it.each([
    ["ssh://git@", "ssh://git@github.com/o/r.git"],
    ["ssh://git@ 带端口", "ssh://git@gitlab.example.com:2222/o/r.git"],
    ["https://user@", "https://eva@github.com/o/r.git"],
    ["https://user@ 带邮箱编码", "https://eva%40corp.com@git.example.com/r.git"],
    ["SSH 简写", "git@github.com:o/r.git"],
    ["普通 https", "https://github.com/o/r.git"],
    ["无关查询参数", "https://github.com/o/r/pull/3?tab=files&page=2"],
    ["token 参数为空", "https://example.com/r.git?token="],
    ["git+ssh 用户名", "git+ssh://git@github.com/o/r.git"],
  ])("放行：%s", async (_n, url) => {
    const store = open().prStore<Rec>();
    const r = { ...base, remote: { number: 1, url } };
    await store.put(r);
    expect(await store.get("pr-1")).toEqual(r);
  });

  it.each([
    ["user:token@", "https://eva:ghp_abcdefghij@github.com/o/r.git"],
    ["x-access-token:token@", "https://x-access-token:abc123@github.com/o/r.git"],
    ["ssh 带密码", "ssh://git:secret@github.com/o/r.git"],
    ["只有用户名但像 GitHub token", "https://ghp_abcdefghijklmnop@github.com/o/r.git"],
    ["只有用户名但像细粒度 PAT", "https://github_pat_11ABCDEF_xyz@github.com/o/r.git"],
    ["只有用户名但像 GitLab token", "https://glpat-abcdefghij@gitlab.com/o/r.git"],
    ["oauth2 用户名", "https://oauth2@gitlab.com/o/r.git"],
    ["查询参数 token", "https://example.com/r.git?token=abc"],
    ["查询参数 access_token", "https://api.example.com/x?a=1&access_token=abc"],
    ["查询参数 private_token", "https://gitlab.com/api/v4/x?private_token=abc"],
    ["查询参数 api_key", "https://example.com/x?api_key=abc"],
    ["预签名 URL", "https://bucket.s3.amazonaws.com/a?X-Amz-Signature=deadbeef"],
    ["大小写混写的参数名", "https://example.com/x?Access-Token=abc"],
  ])("拒写：%s", async (_n, url) => {
    const store = open().prStore<Rec>();
    await expect(store.put({ ...base, remote: { number: 1, url } })).rejects.toThrow(
      /remote\.url 是带凭据的 URL/,
    );
    expect(await store.get("pr-1")).toBeUndefined();
  });

  it("嵌套在数组里的结构字段同样检查；非结构字段照旧轻脱敏不拒写", async () => {
    const store = open().prStore<PrRecord & { remote?: unknown; note?: string }>();
    await expect(
      store.put({ ...base, remote: { urls: ["https://github.com/o/r", "https://a:b@h/r"] } }),
    ).rejects.toThrow(/remote\.urls\[1\] 是带凭据的 URL/);
    await store.put({ ...base, note: "https://a:b@h/r" });
    expect((await store.get("pr-1"))?.note).toBeDefined();
  });

  it("closed_by 在 PR_STRUCTURAL_FIELDS 里", () => {
    expect(PR_STRUCTURAL_FIELDS.has("closed_by")).toBe(true);
  });
});
