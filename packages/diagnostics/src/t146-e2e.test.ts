// T-146 端到端：事件多带路径字段、trace_id 写成路径，导出并解压后，整个包里搜不到路径和 home 目录。
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { BakaEvent } from "@bakacoding/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  exportPackage,
  readZip,
  type DiagnosticsSource,
  type ExportDeps,
  type TicketRecord,
} from "./index.js";

const PROJECT = "proj-t146";
const HOME = homedir();
// 片段都带 evat146 标记，方便整包搜索。
const PATHS = {
  posix: "/srv/evat146-repos/demo",
  trace: "/tmp/evat146-trace/run-1",
  tilde: "~/evat146/code",
  windows: "C:\\evat146\\repo",
  windowsSlash: "D:/evat146/repo",
  unc: "\\\\evat146-server\\share\\repo",
  fileUrl: "file:///var/evat146/a.ts",
  // home 内的相对部分（proj/x.ts）不算敏感，和模块 3 的 home_path 行为一致；只要求 home 本身不出现。
  home: join(HOME, "proj", "x.ts"),
} as const;
const VALUES = Object.values(PATHS);

function makeEvents(): BakaEvent[] {
  return [
    {
      event_id: "ev-1",
      seq: 1,
      ts: "2026-10-20T01:00:00.000Z",
      requirement_id: "R-1",
      ticket_id: "T-1",
      trace_id: PATHS.trace,
      span_id: "sp-1",
      parent_span_id: null,
      type: "group_message",
      payload: {
        project_id: PROJECT,
        sender: "supervisor",
        kind: "dispatch",
        content: `在 ${PATHS.home} 和 ${PATHS.tilde} 改`,
        flash_calls: [],
        extra_path: PATHS.posix,
        extra: { win: PATHS.windows, list: [PATHS.unc, PATHS.windowsSlash, PATHS.fileUrl] },
        [PATHS.posix]: "路径当键名",
      },
      cwd: PATHS.posix,
    } as unknown as BakaEvent,
  ];
}

function makeTickets(): TicketRecord[] {
  return [
    {
      project_id: PROJECT,
      ticket_id: "T-1",
      requirement_id: "R-1",
      created_at: "2026-10-20T01:00:30.000Z",
      ticket_text: `改 ${PATHS.posix}/a.ts`,
      base_commit: "c".repeat(40),
      permission_list: [],
      rounds: [],
      context_snippets: [{ path: PATHS.posix + "/ctx.ts", content: `// ${PATHS.home}` }],
    } as unknown as TicketRecord,
  ];
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bc-diag-t146-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(): ExportDeps {
  const source: DiagnosticsSource = {
    queryEvents: async () => makeEvents(),
    queryTickets: async () => makeTickets(),
  } as DiagnosticsSource;
  return { source, out_dir: dir, now: () => new Date("2026-10-24T01:00:00.000Z") };
}

describe("T-146：诊断包里任何位置都没有绝对路径和 home 目录", () => {
  it("造的数据确实带这些路径", () => {
    const s = JSON.stringify([makeEvents(), makeTickets()]);
    for (const p of VALUES) expect(s).toContain(JSON.stringify(p).slice(1, -1));
  });

  it("导出解压后，条目名、内容和 zip 原始字节里都搜不到", async () => {
    const zip_path = await exportPackage(
      { project_id: PROJECT, scope: { kind: "ticket", ticket_id: "T-1" } },
      deps(),
    );
    const bytes = await readFile(zip_path);
    const entries = readZip(bytes);
    expect(entries.length).toBeGreaterThan(5);
    const needles = [
      "evat146",
      HOME,
      JSON.stringify(HOME).slice(1, -1),
      ...VALUES.flatMap((p) => [p, JSON.stringify(p).slice(1, -1)]),
    ];
    const latin = bytes.toString("latin1");
    for (const n of needles) {
      expect(latin).not.toContain(n);
      for (const e of entries) {
        expect(e.name).not.toContain(n);
        expect(e.data.toString("utf8")).not.toContain(n);
      }
    }
    const events = entries.find((e) => e.name === "events.jsonl")!.data.toString("utf8");
    const ev = JSON.parse(events.trim()) as { trace_id: string };
    expect(ev.trace_id).toBe("[REDACTED:abs_path]");
  });
});
