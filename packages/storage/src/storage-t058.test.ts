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
    ["https://user@ 带点和连字符", "https://eva.m-1@github.com/o/r.git"],
    ["SSH 简写", "git@github.com:o/r.git"],
    ["普通 https", "https://github.com/o/r.git"],
    ["无关查询参数", "https://github.com/o/r/pull/3?tab=files&page=2"],
    ["token 参数为空", "https://example.com/r.git?token="],
    ["git+ssh 用户名", "git+ssh://git@github.com/o/r.git"],
    ["前后有空格的普通 URL", "  https://github.com/o/r.git  "],
    ["无关的 # 片段", "https://github.com/o/r/pull/3#discussion_r1"],
    ["文字里嵌普通 URL", "见 https://github.com/o/r/pull/3 和 ssh://git@github.com/o/r.git"],
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
    // #58 评审阻塞 1：没有前缀的 token 当用户名
    ["40 位十六进制用户名", "https://a1b2c3d4e5f60718293a4b5c6d7e8f9012345678@github.com/o/r"],
    ["长串 base64 用户名（纯字母数字）", "https://AbCdEfGhIjKlMnOpQrStUvWx@github.com/o/r"],
    ["base64 用户名带 =", "https://dGhpc2lzYXRva2Vu=@github.com/o/r"],
    ["用户名带 % 编码（白名单外的字符）", "https://eva%40corp.com@git.example.com/r.git"],
    ["用户名超过 39 个字符", "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@github.com/o/r"],
    // 阻塞 2：非 http(s) 也查 token 前缀和长串用户名
    ["git:// 用户名像 token", "git://ghp_abcdefghijklmnop@github.com/o/r.git"],
    ["ftp:// 用户名像 token", "ftp://ghp_abcdefghijklmnop@example.com/x"],
    ["ssh:// 用户名像 token", "ssh://ghp_abcdefghijklmnop@github.com/o/r.git"],
    [
      "ssh:// 40 位十六进制用户名",
      "ssh://a1b2c3d4e5f60718293a4b5c6d7e8f9012345678@github.com/o/r.git",
    ],
    // 阻塞 3：%3A 编码的冒号
    ["用户名里 %3A 编码的冒号", "https://x%3Atok@h/r"],
    ["用户名里小写 %3a", "https://x%3atok@h/r"],
    // 一起补上
    ["# 后面的 access_token", "https://app.example.com/cb#access_token=abc"],
    ["# 后面带路径再带参数", "https://app.example.com/#/cb?token=abc"],
    ["参数名末尾的 []", "https://example.com/x?token[]=abc"],
    ["# 里参数名末尾的 []", "https://example.com/x#api_key[]=abc"],
    ["前面有空格", "  https://eva:ghp_abc@github.com/o/r.git"],
    ["嵌在文字里的 user:pass@", "克隆地址 https://eva:tok@github.com/o/r.git 已配置"],
    ["嵌在文字里的 token 用户名", "clone https://ghp_abcdefghijklmnop@github.com/o/r"],
    ["嵌在文字里的查询参数 token", "回调 https://example.com/x?token=abc 已收到"],
    ["https:/\\ 反斜杠写法", "https:/\\user:tok@h/r"],
    ["https: 不带斜杠", "https:user:tok@h/r"],
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
