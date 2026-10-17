// T-059：prStore 拒写和 redact 跑同一份 CREDENTIAL_CASES。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CREDENTIAL_CASES } from "@bakacoding/config-budget";
import type { PrRecord } from "@bakacoding/pr";
import { openStorage, type Storage } from "./index.js";

let dirs: string[] = [];
let opened: Storage[] = [];
afterEach(() => {
  for (const s of opened) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  opened = [];
});
function open(): Storage {
  const d = mkdtempSync(join(tmpdir(), "bc-storage-059-"));
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

const urlCases = CREDENTIAL_CASES.filter((c) => c.rule !== "token");

describe("prStore 按 CREDENTIAL_CASES 拒写 / 放行（T-059）", () => {
  it.each(urlCases.map((c) => [`${c.expect}：${c.name}`, c] as const))("%s", async (_n, c) => {
    const store = open().prStore<Rec>();
    const r = { ...base, remote: { number: 1, url: c.build().text } };
    if (c.expect === "reject") {
      await expect(store.put(r)).rejects.toThrow(/remote\.url 是带凭据的 URL/);
      expect(await store.get("pr-1")).toBeUndefined();
    } else {
      await store.put(r);
      expect(await store.get("pr-1")).toEqual(r);
    }
  });
});
