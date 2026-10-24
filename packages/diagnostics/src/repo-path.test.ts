// T-143：诊断包导出时按字段名整段去掉 repo_path（模块 2 的 projects 表和「项目已创建」事件数据，T-142）。
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BakaEvent } from "@bakacoding/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DROPPED_KEYS,
  PACKAGE_FILES,
  buildPackage,
  exportPackage,
  readZip,
  type DiagnosticsSource,
  type ExportDeps,
  type TicketRecord,
} from "./index.js";

const PROJECT = "proj-rp";
const SHA = "c".repeat(40);

// 覆盖 POSIX、Windows（含空格）、UNC、~、带空格。
const PATHS = {
  posix: "/srv/evafakeuser-repos/bakacoding-demo",
  windows: "C:\\Users\\x y\\repo",
  unc: "\\\\fileserver\\share\\team repo",
  tilde: "~/code/my-fake-repo",
  spaces: "/Volumes/Data Disk/My Repo With Spaces",
} as const;
const PATH_VALUES = Object.values(PATHS);

let seq = 0;
const common = (ticket_id: string | null, requirement_id: string | null, ts: string) => ({
  event_id: `ev-rp-${++seq}`,
  seq,
  ts,
  requirement_id,
  ticket_id,
  trace_id: "tr-rp",
  span_id: `sp-rp-${seq}`,
  parent_span_id: null,
});

/** 手工造带 repo_path 的事件：T-142 之后 project_created 的数据里会有它；另外故意塞进别的事件和更深的嵌套里，验证只按字段名去掉。 */
function makeEvents(withNull = false): BakaEvent[] {
  seq = 0;
  const ev = (e: unknown) => e as BakaEvent;
  return [
    ev({
      ...common(null, null, "2026-10-20T01:00:00.000Z"),
      type: "project_created",
      payload: {
        project_id: PROJECT,
        name: "demo",
        language: "typescript",
        has_github_remote: false,
        repo_path: withNull ? null : PATHS.posix,
      },
    }),
    ev({
      ...common(null, "R-1", "2026-10-20T01:01:00.000Z"),
      type: "group_message",
      payload: {
        project_id: PROJECT,
        sender: "supervisor",
        kind: "dispatch",
        content: "派单",
        flash_calls: [],
        repo_path: withNull ? null : PATHS.windows,
        nested: {
          list: [{ repo_path: withNull ? null : PATHS.unc, keep: "保留" }],
          deeper: { a: { b: { repo_path: withNull ? null : PATHS.tilde } } },
        },
      },
    }),
    ev({
      ...common("T-1", "R-1", "2026-10-20T01:02:00.000Z"),
      type: "some_future_event",
      payload: { project_id: PROJECT, repo_path: withNull ? null : PATHS.spaces },
      repo_path: withNull ? null : PATHS.spaces,
    }),
  ];
}

/** projects 表的行（T-142 起带 repo_path）。数据源接口里没有取项目记录的方法，这里额外挂一个，确认导出不会去读。 */
function makeProjectRows(withNull = false) {
  return PATH_VALUES.map((p, i) => ({
    project_id: i === 0 ? PROJECT : `proj-${i}`,
    name: `demo-${i}`,
    language: "typescript",
    has_github_remote: false,
    created_at: "2026-10-20T00:00:00.000Z",
    repo_path: withNull ? null : p,
  }));
}

function makeTickets(withNull = false): TicketRecord[] {
  const t = {
    project_id: PROJECT,
    ticket_id: "T-1",
    requirement_id: "R-1",
    created_at: "2026-10-20T01:00:30.000Z",
    ticket_text: "改文案",
    base_commit: SHA,
    permission_list: [],
    rounds: [],
    context_snippets: [],
    // 万一数据源把项目行带进单子记录，也要去掉。
    project: makeProjectRows(withNull)[0],
  };
  return [t as unknown as TicketRecord];
}

let dir: string;
let listProjects: ReturnType<typeof vi.fn>;

function deps(withNull = false): ExportDeps {
  listProjects = vi.fn(() => makeProjectRows(withNull));
  const source = {
    queryEvents: async () => makeEvents(withNull),
    queryTickets: async () => makeTickets(withNull),
    listProjects,
  } as DiagnosticsSource;
  return { source, out_dir: dir, now: () => new Date("2026-10-24T01:00:00.000Z") };
}

const OPTS = {
  project_id: PROJECT,
  scope: { kind: "time_range" as const, from: "2026-10-19T00:00:00Z", to: "2026-10-21T00:00:00Z" },
};

function hasKeyDeep(v: unknown, key: string): boolean {
  if (Array.isArray(v)) return v.some((x) => hasKeyDeep(x, key));
  if (v !== null && typeof v === "object") {
    return Object.entries(v).some(([k, x]) => k === key || hasKeyDeep(x, key));
  }
  return false;
}

/** 路径在 JSON 里的样子（反斜杠被转义）和原样都要搜。 */
function needles(): string[] {
  return PATH_VALUES.flatMap((p) => [p, JSON.stringify(p).slice(1, -1)]);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bc-diag-rp-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("T-143：诊断包去掉 repo_path", () => {
  it("DROPPED_KEYS 只含 repo_path", () => {
    expect([...DROPPED_KEYS]).toEqual(["repo_path"]);
  });

  it("造的数据里确实带 repo_path（不是靠没造出来通过）", () => {
    expect(hasKeyDeep(makeEvents(), "repo_path")).toBe(true);
    expect(hasKeyDeep(makeTickets(), "repo_path")).toBe(true);
    expect(JSON.stringify(makeEvents())).toContain(JSON.stringify(PATHS.unc).slice(1, -1));
  });

  it("事件（任意嵌套、任意事件类型）、单子记录、manifest 里都没有 repo_path 键", async () => {
    const pkg = await buildPackage(OPTS, deps());
    expect(pkg.events).toHaveLength(3);
    expect(hasKeyDeep(pkg.events, "repo_path")).toBe(false);
    expect(hasKeyDeep(pkg.tickets, "repo_path")).toBe(false);
    expect(hasKeyDeep(pkg.costs, "repo_path")).toBe(false);
    expect(hasKeyDeep(pkg.manifest, "repo_path")).toBe(false);
    // 其余字段照常保留。
    const gm = pkg.events[1]!.payload as unknown as {
      content: unknown;
      nested: { list: { keep: string }[]; deeper: { a: { b: object } } };
    };
    // T-159：content 是摘要（2 个码点），不是原文。
    expect(gm.content).toMatchObject({ len: 2 });
    expect(JSON.stringify(gm.content)).not.toContain("派单");
    expect(gm.nested.list[0]).toEqual({ keep: "保留" });
    expect(gm.nested.deeper.a.b).toEqual({});
    expect(pkg.events[0]!.payload).toMatchObject({ project_id: PROJECT, name: "demo" });
  });

  it("项目记录（projects 表）不导出：不调取项目记录，zip 里只有固定文件，也搜不到任何原路径", async () => {
    const zip_path = await exportPackage(OPTS, deps());
    expect(listProjects).not.toHaveBeenCalled();
    const bytes = await readFile(zip_path);
    const entries = readZip(bytes);
    expect(entries.map((e) => e.name).sort()).toEqual(Object.values(PACKAGE_FILES).sort());
    const latin = bytes.toString("latin1");
    for (const e of entries) {
      const text = e.data.toString("utf8");
      expect(text).not.toContain('"repo_path"');
      for (const n of needles()) {
        expect(e.name).not.toContain(n);
        expect(text).not.toContain(n);
      }
    }
    for (const n of needles()) {
      expect(latin).not.toContain(n);
      expect(zip_path).not.toContain(n);
    }
    // 逐行解析结构化文件，确认没有 repo_path 键。
    for (const e of entries) {
      const text = e.data.toString("utf8");
      const rows = e.name.endsWith(".jsonl")
        ? text
            .split("\n")
            .filter((l) => l.trim() !== "")
            .map((l) => JSON.parse(l) as unknown)
        : [JSON.parse(text) as unknown];
      expect(hasKeyDeep(rows, "repo_path")).toBe(false);
    }
  });

  it("repo_path 为 null 时也能正常导出，键同样不出现", async () => {
    const zip_path = await exportPackage(OPTS, deps(true));
    const entries = readZip(await readFile(zip_path));
    const events = entries.find((e) => e.name === PACKAGE_FILES.events)!.data.toString("utf8");
    expect(events.trim().split("\n")).toHaveLength(3);
    for (const e of entries) expect(e.data.toString("utf8")).not.toContain("repo_path");
  });
});
