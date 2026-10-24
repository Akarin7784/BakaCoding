// UI-07c 附带（模块 11）：walk() 对「对象键名」也做完整脱敏（`out[this.text(k)]`）。
// 键名本身带 home 路径和像密钥的串时，导出的诊断包里两者都不能出现。
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BakaEvent } from "@bakacoding/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FullRedactor,
  buildPackage,
  exportPackage,
  readZip,
  type DiagnosticsSource,
  type ExportDeps,
} from "./index.js";

const PROJECT = "proj-keys";
// 只出现在键名里，值里没有，确保是靠键名脱敏遮掉的。
const HOME_USER = "evafakeuserkeyname";
const HOME_KEY = `/home/${HOME_USER}/work/repo`;
const TOKEN = "ghp_UI07cKeyNameTokenABCDEFGHIJKLMN";
const SK = "sk-ui07ckeyname0123456789abcdef";

function events(): BakaEvent[] {
  return [
    {
      event_id: "ev-k-1",
      seq: 1,
      ts: "2026-10-20T01:00:00.000Z",
      requirement_id: "R-1",
      ticket_id: null,
      trace_id: "tr-k",
      span_id: "sp-k-1",
      parent_span_id: null,
      type: "group_message",
      payload: {
        project_id: PROJECT,
        sender: "supervisor",
        kind: "dispatch",
        content: "派单",
        flash_calls: [],
        files: { [HOME_KEY]: "改了", [TOKEN]: 1, nested: { [SK]: true } },
      },
    } as unknown as BakaEvent,
  ];
}

let dir: string;
function deps(): ExportDeps {
  const source = {
    queryEvents: async () => events(),
    queryTickets: async () => [],
  } as unknown as DiagnosticsSource;
  return { source, out_dir: dir, now: () => new Date("2026-10-24T01:00:00.000Z") };
}
const OPTS = {
  project_id: PROJECT,
  scope: { kind: "time_range" as const, from: "2026-10-19T00:00:00Z", to: "2026-10-21T00:00:00Z" },
};
const NEEDLES = [HOME_USER, HOME_KEY, TOKEN, SK];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bc-diag-keys-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("诊断包：键名也做完整脱敏", () => {
  it("造的数据里这些串只在键名里（不是靠值脱敏通过）", () => {
    const keys: string[] = [];
    const vals: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") vals.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          keys.push(k);
          walk(x);
        }
    };
    walk(events());
    for (const n of [HOME_KEY, TOKEN, SK]) expect(keys).toContain(n);
    for (const n of NEEDLES) expect(vals.join("\n")).not.toContain(n);
  });

  it("FullRedactor.deep 把键名里的 home 路径和密钥遮掉，值照常保留", () => {
    const r = new FullRedactor();
    const out = r.deep({ [HOME_KEY]: "改了", [TOKEN]: 1, nested: { [SK]: true } });
    const text = JSON.stringify(out);
    for (const n of NEEDLES) expect(text).not.toContain(n);
    expect(Object.values(out)).toContain("改了");
    expect(r.report()).toMatchObject({ home_path: 1, github_token: 1, api_key: 1 });
  });

  it("导出的 zip（每个文件和整包字节）里搜不到键名里的 home 路径和密钥", async () => {
    const pkg = await buildPackage(OPTS, deps());
    expect(pkg.events).toHaveLength(1);
    const zip_path = await exportPackage(OPTS, deps());
    const bytes = await readFile(zip_path);
    const latin = bytes.toString("latin1");
    for (const e of readZip(bytes)) {
      const text = e.data.toString("utf8");
      for (const n of NEEDLES) expect(text).not.toContain(n);
    }
    for (const n of NEEDLES) expect(latin).not.toContain(n);
  });
});
