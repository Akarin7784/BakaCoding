import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BakaEvent } from "@bakacoding/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as diag from "./index.js";
import {
  DIAG_SCHEMA,
  buildPackage,
  exportPackage,
  isEnvFile,
  packageToZip,
  readPackage,
  readZip,
  toSweBenchJsonl,
  writeZip,
  type DiagnosticsSource,
  type ExportDeps,
  type RawFile,
  type TicketRecord,
} from "./index.js";

// 以下全部是按格式拼出来的假值，不是真实凭据。
const FAKE = {
  sk: `sk-${"FAKEfake0000".repeat(2)}`,
  gh: `ghp_${"FAKE0fake1".repeat(4)}`,
  bearer: "FAKEbearerTOKENvalue123",
  email: "fake-leak@example.com",
  envPass: "hunter2-FAKE-pass",
  homeUser: "evafakeuser",
  ip: "10.11.12.13",
  keyBody: "FAKEPRIVATEKEYBODYAAAAbbbbCCCC",
  urlPass: "FAKEurlPASS99",
};
const PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----\n${FAKE.keyBody}\n-----END RSA PRIVATE KEY-----`;
const SECRET_BLOB = [
  `key ${FAKE.sk}`,
  `token ${FAKE.gh}`,
  `Authorization: Bearer ${FAKE.bearer}`,
  `mail ${FAKE.email}`,
  `DB_PASSWORD=${FAKE.envPass}`,
  `path /home/${FAKE.homeUser}/proj`,
  `host ${FAKE.ip}`,
  `git https://bob:${FAKE.urlPass}@example.com/r.git`,
  PRIVATE_KEY,
].join("\n");
const NEEDLES = Object.values(FAKE);

const PROJECT = "proj-1";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

let seq = 0;
const common = (ticket_id: string | null, requirement_id: string, ts: string) => ({
  event_id: `ev-${++seq}`,
  seq,
  ts,
  requirement_id,
  ticket_id,
  trace_id: `tr-${requirement_id}`,
  span_id: `sp-${seq}`,
  parent_span_id: null,
});

function call(
  ticket_id: string | null,
  requirement_id: string,
  ts: string,
  cost: number,
  is_resubmit: boolean,
): BakaEvent {
  return {
    ...common(ticket_id, requirement_id, ts),
    type: "call_completed",
    payload: {
      role: "coder",
      provider: "deepseek",
      model: "deepseek-v4.1-flash",
      effort: "low",
      prompt: `prompt with secrets:\n${SECRET_BLOB}`,
      output: `output ${FAKE.sk}`,
      tokens: { input: 100, output: 20, cache_hit_input: 50 },
      cache_hit: true,
      latency_ms: 1234,
      cost,
      is_resubmit,
      rate_limited_retry: 0,
    },
  };
}

function makeEvents(): BakaEvent[] {
  seq = 0;
  return [
    call("T-1", "R-1", "2026-10-10T01:00:00.000Z", 300, false),
    call("T-1", "R-1", "2026-10-10T02:00:00.000Z", 200, true),
    {
      ...common("T-1", "R-1", "2026-10-10T02:30:00.000Z"),
      type: "write_scope_requested",
      ticket_id: "T-1",
      payload: {
        request_id: "rq-1",
        requested_scope: [`/home/${FAKE.homeUser}/proj/src/**`],
        reason: `need ${FAKE.email}`,
      },
    },
    {
      ...common(null, "R-1", "2026-10-10T03:00:00.000Z"),
      type: "group_message",
      payload: {
        project_id: PROJECT,
        sender: "supervisor",
        kind: "dispatch",
        content: `dispatch ${FAKE.gh}`,
        flash_calls: [],
      },
    },
    // 别的项目的事件：必须被过滤掉。
    {
      ...common(null, "R-1", "2026-10-10T03:10:00.000Z"),
      type: "group_message",
      payload: {
        project_id: "other-project",
        sender: "supervisor",
        kind: "dispatch",
        content: "other project",
        flash_calls: [],
      },
    },
    call("T-2", "R-2", "2026-10-12T01:00:00.000Z", 50, false),
  ];
}

function makeTickets(): TicketRecord[] {
  return [
    {
      project_id: PROJECT,
      ticket_id: "T-1",
      requirement_id: "R-1",
      created_at: "2026-10-10T00:30:00.000Z",
      ticket_text: `实现登录。联系 ${FAKE.email}`,
      decomposition_summary: `拆单摘要 ${FAKE.ip}`,
      status: "merged",
      outcome: "passed_after_resubmit",
      base_commit: SHA_A,
      permission_list: [{ glob: "src/**", level: "rw" }],
      rounds: [
        {
          round: 1,
          verdict: "fail",
          fail_reasons: [`泄漏了 ${FAKE.sk}`],
          diff: {
            base_sha: SHA_A,
            head_sha: SHA_B,
            files: [
              {
                path: "src/config.ts",
                status: "modified",
                additions: 1,
                deletions: 0,
                patch: `@@ -1 +1,2 @@\n x\n+const k = "${FAKE.sk}";`,
              },
            ],
          },
        },
        {
          round: 2,
          verdict: "pass",
          fail_reasons: [],
          review_comments: `去掉 ${FAKE.gh}`,
          diff: {
            base_sha: SHA_A,
            head_sha: SHA_B,
            files: [
              {
                path: "src/login.ts",
                status: "added",
                additions: 2,
                deletions: 0,
                patch: `@@ -0,0 +1,2 @@\n+export const login = 1;\n+// ${SECRET_BLOB.split("\n").join("\n+// ")}`,
              },
            ],
          },
        },
      ],
      merge: { conflicted: false, base_changed: false, re_reviewed: false, merged: true },
      ci_checks: [{ name: "ci", conclusion: "success", tests: ["test_login"] }],
      context_snippets: [
        { path: "src/config.ts", content: `// ctx\n${SECRET_BLOB}\n` },
        { path: `/home/${FAKE.homeUser}/proj/.env`, content: `DEEPSEEK_API_KEY=${FAKE.sk}\n` },
      ],
      marked_for_eval_set: true,
    },
    {
      project_id: PROJECT,
      ticket_id: "T-2",
      requirement_id: "R-2",
      created_at: "2026-10-12T00:30:00.000Z",
      ticket_text: "改文案",
      outcome: "passed",
      base_commit: SHA_A,
      permission_list: [],
      rounds: [
        {
          round: 1,
          verdict: "pass",
          fail_reasons: [],
          diff: {
            base_sha: SHA_A,
            head_sha: SHA_B,
            files: [
              {
                path: "README.md",
                status: "modified",
                additions: 1,
                deletions: 1,
                patch: "@@ -1 +1 @@\n-a\n+b\n",
              },
            ],
          },
        },
      ],
      context_snippets: [],
    },
    // 别的项目的单：必须被过滤掉。
    {
      project_id: "other-project",
      ticket_id: "T-9",
      requirement_id: "R-1",
      created_at: "2026-10-10T00:30:00.000Z",
      ticket_text: "other",
      base_commit: SHA_A,
      permission_list: [],
      rounds: [],
      context_snippets: [],
    },
  ];
}

const REPO_FILES: RawFile[] = [
  { path: "src/index.ts", content: "export {};\n" },
  { path: ".env", content: `GITHUB_TOKEN=${FAKE.gh}\nDB_PASSWORD=${FAKE.envPass}\n` },
];

function makeSource(): DiagnosticsSource & { repoFiles: ReturnType<typeof vi.fn> } {
  // 数据源故意不按 filter 过滤，验证导出侧自己守住范围和项目边界。
  return {
    queryEvents: async () => makeEvents(),
    queryTickets: async () => makeTickets(),
    repoFiles: vi.fn(async () => REPO_FILES),
  };
}

let dir: string;
let source: ReturnType<typeof makeSource>;
let deps: ExportDeps;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bc-diag-"));
  source = makeSource();
  deps = {
    source,
    out_dir: dir,
    now: () => new Date("2026-10-17T06:00:00.000Z"),
    eval_tasks: {
      "T-1": {
        test_names: ["tests/test_login.py::test_ok"],
        run_command: `pytest -q  # TOKEN=${FAKE.gh}`,
        prefilled_from_ci: true,
      },
    },
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("完整脱敏", () => {
  it("事件、diff、原始文件（含完整仓库）里埋的假密钥在 zip 中一处都不出现", async () => {
    const zip_path = await exportPackage(
      {
        project_id: PROJECT,
        scope: { kind: "requirement", requirement_id: "R-1" },
        include_full_repo: true,
      },
      deps,
    );
    const bytes = await readFile(zip_path);
    const entries = readZip(bytes);
    expect(entries.length).toBeGreaterThan(5);
    // 确认密钥确实被埋进了 diff、上下文、完整仓库三类原始文件（不是靠没导出来"通过"）。
    const names = entries.map((e) => e.name);
    expect(names.some((n) => n.endsWith(".diff"))).toBe(true);
    expect(names.some((n) => n.includes("/context/"))).toBe(true);
    expect(names.some((n) => n.startsWith("repo/"))).toBe(true);

    for (const needle of NEEDLES) {
      expect(bytes.toString("latin1")).not.toContain(needle);
      expect(zip_path).not.toContain(needle);
      for (const e of entries) {
        expect(e.name).not.toContain(needle);
        expect(e.data.toString("utf8")).not.toContain(needle);
      }
    }
    const all = entries.map((e) => e.data.toString("utf8")).join("\n");
    expect(all).not.toMatch(/sk-[A-Za-z0-9]{16}|ghp_[A-Za-z0-9]{20}|BEGIN RSA PRIVATE KEY/);
    expect(all).toContain("[REDACTED:api_key]");
  });

  it("脱敏报告只有规则名 → 次数，没有合计、没有原文", async () => {
    const pkg = await buildPackage(
      {
        project_id: PROJECT,
        scope: { kind: "requirement", requirement_id: "R-1" },
        include_full_repo: true,
      },
      deps,
    );
    const rep = pkg.redaction_report;
    const known = [
      "private_key",
      "url_credentials",
      "github_token",
      "api_key",
      "bearer",
      "env_secret",
      "email",
      "home_path",
      "ipv4",
      "ipv6",
      "hostname",
      // T-146 路径规则
      "home_dir",
      "file_url",
      "unc_path",
      "windows_path",
      "tilde_path",
      "abs_path",
    ];
    for (const [k, v] of Object.entries(rep)) {
      expect(known).toContain(k);
      expect(Number.isInteger(v) && v > 0).toBe(true);
    }
    for (const k of [
      "api_key",
      "github_token",
      "bearer",
      "email",
      "env_secret",
      "home_path",
      "ipv4",
      "private_key",
      "url_credentials",
    ]) {
      expect(rep[k]).toBeGreaterThan(0);
    }
    expect(Object.keys(rep).some((k) => /total|sum|all/i.test(k))).toBe(false);
    const s = JSON.stringify(rep);
    for (const needle of NEEDLES) expect(s).not.toContain(needle);

    // zip 里的报告文件内容与包内一致。
    const zip_path = await exportPackage(
      {
        project_id: PROJECT,
        scope: { kind: "requirement", requirement_id: "R-1" },
        include_full_repo: true,
      },
      deps,
    );
    const read = await readPackage(zip_path);
    expect(read.redaction_report).toEqual(rep);
  });
});

describe("导出范围与内容", () => {
  it("export 别名就是 exportPackage；manifest 带 schema id 且列出全部条目", async () => {
    expect(diag.export).toBe(exportPackage);
    const zip_path = await diag.export(
      { project_id: PROJECT, scope: { kind: "ticket", ticket_id: "T-1" } },
      deps,
    );
    expect(zip_path.startsWith(dir)).toBe(true);
    expect(zip_path).toMatch(/bakacoding-diag-proj-1-ticket-T-1-20261017T060000000Z\.zip$/);
    const pkg = await readPackage(zip_path);
    expect(pkg.manifest.schema).toBe(DIAG_SCHEMA);
    expect(pkg.manifest.schema).toBe("bakacoding-diag/v1.1");
    expect(pkg.manifest.redaction).toBe("full");
    const names = readZip(await readFile(zip_path))
      .map((e) => e.name)
      .sort();
    expect([...pkg.manifest.files].sort()).toEqual(names);
  });

  it("默认不带完整仓库：不调 repoFiles，只有 diff 和上下文片段", async () => {
    const pkg = await buildPackage(
      { project_id: PROJECT, scope: { kind: "ticket", ticket_id: "T-1" } },
      deps,
    );
    expect(source.repoFiles).not.toHaveBeenCalled();
    expect(pkg.manifest.include_full_repo).toBe(false);
    expect(pkg.raw_files.some((f) => f.path.startsWith("repo/"))).toBe(false);
    expect(pkg.raw_files.map((f) => f.path)).toEqual([
      "raw/T-1/r1.diff",
      "raw/T-1/r2.diff",
      "raw/T-1/context/src/config.ts",
    ]);
  });

  it("勾选 include_full_repo 才带 repo/ 下的完整仓库（.env 默认排除）", async () => {
    const pkg = await buildPackage(
      { project_id: PROJECT, scope: { kind: "ticket", ticket_id: "T-1" }, include_full_repo: true },
      deps,
    );
    expect(source.repoFiles).toHaveBeenCalledWith(PROJECT);
    expect(pkg.raw_files.filter((f) => f.path.startsWith("repo/")).map((f) => f.path)).toEqual([
      "repo/src/index.ts",
    ]);
  });

  it("按单导出：只有这张单，别的单和别的项目都不进包", async () => {
    const pkg = await buildPackage(
      { project_id: PROJECT, scope: { kind: "ticket", ticket_id: "T-1" } },
      deps,
    );
    expect(pkg.tickets.map((t) => t.ticket_id)).toEqual(["T-1"]);
    expect(pkg.events.every((e) => e.ticket_id === "T-1")).toBe(true);
    expect(pkg.events).toHaveLength(3);
  });

  it("按需求导出：含需求下的无单号事件，排除别的项目", async () => {
    const pkg = await buildPackage(
      { project_id: PROJECT, scope: { kind: "requirement", requirement_id: "R-1" } },
      deps,
    );
    expect(pkg.tickets.map((t) => t.ticket_id)).toEqual(["T-1"]);
    expect(pkg.events.map((e) => e.type)).toEqual([
      "call_completed",
      "call_completed",
      "write_scope_requested",
      "group_message",
    ]);
    expect(JSON.stringify(pkg)).not.toContain("other-project");
  });

  it("按时间段导出：须选项目，区间外的单和事件不进包", async () => {
    const pkg = await buildPackage(
      {
        project_id: PROJECT,
        scope: {
          kind: "time_range",
          from: "2026-10-11T00:00:00.000Z",
          to: "2026-10-13T00:00:00.000Z",
        },
      },
      deps,
    );
    expect(pkg.tickets.map((t) => t.ticket_id)).toEqual(["T-2"]);
    expect(pkg.events.map((e) => e.ticket_id)).toEqual(["T-2"]);
    await expect(
      buildPackage(
        {
          project_id: "",
          scope: { kind: "time_range", from: "2026-10-11T00:00:00Z", to: "2026-10-13T00:00:00Z" },
        },
        deps,
      ),
    ).rejects.toThrow(/project_id/);
    await expect(
      buildPackage(
        {
          project_id: PROJECT,
          scope: { kind: "time_range", from: "2026-10-13T00:00:00Z", to: "2026-10-11T00:00:00Z" },
        },
        deps,
      ),
    ).rejects.toThrow(/from/);
  });

  it("每轮 diff、复投次数、费用（复投单列）、结果标签、统计", async () => {
    const pkg = await buildPackage(
      {
        project_id: PROJECT,
        scope: { kind: "time_range", from: "2026-10-01T00:00:00Z", to: "2026-10-31T00:00:00Z" },
      },
      deps,
    );
    const t1 = pkg.tickets.find((t) => t.ticket_id === "T-1")!;
    expect(t1.rounds.map((r) => [r.round, r.verdict, r.diff_file])).toEqual([
      [1, "fail", "raw/T-1/r1.diff"],
      [2, "pass", "raw/T-1/r2.diff"],
    ]);
    expect(t1.rounds[0]!.diff.files[0]!.patch).toBe("");
    expect(t1.resubmit_count).toBe(1);
    expect(t1.cost).toEqual({
      ticket_id: "T-1",
      total_micro_usd: 500,
      resubmit_micro_usd: 200,
      entries: 2,
    });
    expect(t1.outcome).toBe("passed_after_resubmit");
    const d2 = pkg.raw_files.find((f) => f.path === "raw/T-1/r2.diff")!.content;
    expect(
      d2.startsWith(
        "diff --git a/src/login.ts b/src/login.ts\n--- /dev/null\n+++ b/src/login.ts\n",
      ),
    ).toBe(true);
    expect(pkg.manifest.stats).toEqual({
      tickets: 2,
      outcomes: { passed_after_resubmit: 1, passed: 1 },
      rounds: 3,
      first_round_pass: 1,
      review_pass_rejected_by_user: 0,
    });
  });
});

describe("eval_task 与 SWE-bench JSONL", () => {
  it("只有人工补填过 eval_task 的单进 eval_task 段，并且同样脱敏", async () => {
    const pkg = await buildPackage(
      {
        project_id: PROJECT,
        scope: { kind: "time_range", from: "2026-10-01T00:00:00Z", to: "2026-10-31T00:00:00Z" },
      },
      deps,
    );
    const t1 = pkg.tickets.find((t) => t.ticket_id === "T-1")!;
    const t2 = pkg.tickets.find((t) => t.ticket_id === "T-2")!;
    expect(t1.eval_task?.test_names).toEqual(["tests/test_login.py::test_ok"]);
    expect(t1.eval_task?.run_command).not.toContain(FAKE.gh);
    expect(t2.eval_task).toBeUndefined();
    expect("eval_task" in t2).toBe(false);
  });

  it("toSweBenchJsonl：每个带 eval_task 的单一行，字段对齐 SWE-bench", async () => {
    const zip_path = await exportPackage(
      {
        project_id: PROJECT,
        scope: { kind: "time_range", from: "2026-10-01T00:00:00Z", to: "2026-10-31T00:00:00Z" },
      },
      { ...deps, repo: "owner/repo" },
    );
    const out = toSweBenchJsonl(await readPackage(zip_path));
    const lines = out.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const inst = JSON.parse(lines[0]!);
    expect(Object.keys(inst).sort()).toEqual(
      [
        "FAIL_TO_PASS",
        "PASS_TO_PASS",
        "base_commit",
        "created_at",
        "environment_setup_commit",
        "hints_text",
        "instance_id",
        "patch",
        "problem_statement",
        "repo",
        "test_patch",
        "version",
      ].sort(),
    );
    expect(inst.instance_id).toBe("proj-1__T-1");
    expect(inst.repo).toBe("owner/repo");
    expect(inst.base_commit).toBe(SHA_A);
    expect(JSON.parse(inst.FAIL_TO_PASS)).toEqual(["tests/test_login.py::test_ok"]);
    expect(JSON.parse(inst.PASS_TO_PASS)).toEqual([]);
    expect(inst.patch).toMatch(/^diff --git a\/src\/login\.ts b\/src\/login\.ts\n/);
    for (const needle of NEEDLES) expect(out).not.toContain(needle);
  });

  it("没有 eval_task 时输出空串", async () => {
    const pkg = await buildPackage(
      { project_id: PROJECT, scope: { kind: "ticket", ticket_id: "T-2" } },
      deps,
    );
    expect(toSweBenchJsonl(pkg)).toBe("");
  });
});

describe("zip 读写", () => {
  it("往返一致，压缩与不压缩条目都能读，CRC 损坏会报错", () => {
    const big = Buffer.from("hello ".repeat(1000), "utf8");
    const tiny = Buffer.from("x", "utf8");
    const zip = writeZip([
      { name: "a/big.txt", data: big },
      { name: "中文.txt", data: tiny },
    ]);
    const back = readZip(zip);
    expect(back.map((e) => e.name)).toEqual(["a/big.txt", "中文.txt"]);
    expect(back[0]!.data.equals(big)).toBe(true);
    expect(back[1]!.data.equals(tiny)).toBe(true);
    expect(zip.length).toBeLessThan(big.length);
    expect(() =>
      writeZip([
        { name: "d", data: tiny },
        { name: "d", data: tiny },
      ]),
    ).toThrow(/重名/);
    const bad = Buffer.from(zip);
    // 改坏不压缩条目的数据字节。
    const idx = bad.indexOf(Buffer.from("中文.txt", "utf8")) + Buffer.byteLength("中文.txt");
    bad[idx] = bad[idx]! ^ 0xff;
    expect(() => readZip(bad)).toThrow(/CRC/);
  });

  it("读到非 v1 schema 的包会报错", async () => {
    const zip = writeZip([{ name: "manifest.json", data: Buffer.from('{"schema":"other/v9"}') }]);
    const p = join(dir, "x.zip");
    await import("node:fs/promises").then((fs) => fs.writeFile(p, zip));
    await expect(readPackage(p)).rejects.toThrow(/schema/);
  });
});

describe("T-019：完整仓库默认排除 .env 文件", () => {
  it("任何一段路径是 .env 或 .env.* 的文件根本不进包", async () => {
    const files: RawFile[] = [
      { path: "src/index.ts", content: "export {};\n" },
      { path: ".env", content: `GITHUB_TOKEN=${FAKE.gh}\n` },
      { path: "apps/web/.env.local", content: "PLAIN=1\n" },
      { path: "config/.env.production/notes.txt", content: "in env dir\n" },
      { path: ".env/inner.txt", content: "x\n" },
      { path: "docs/.environment.md", content: "kept\n" },
      { path: "src/env.ts", content: "kept\n" },
      { path: "src/.envrc", content: "excluded since T-021\n" },
    ];
    source.repoFiles = vi.fn(async () => files);
    const zip_path = await exportPackage(
      { project_id: PROJECT, scope: { kind: "ticket", ticket_id: "T-2" }, include_full_repo: true },
      deps,
    );
    const names = readZip(await readFile(zip_path)).map((e) => e.name);
    expect(names.filter((n) => n.startsWith("repo/")).sort()).toEqual(
      ["repo/docs/.environment.md", "repo/src/env.ts", "repo/src/index.ts"].sort(),
    );
    const pkg = await readPackage(zip_path);
    expect(pkg.manifest.excluded_env_files).toBe(5);
    // 被排除的文件不是"打包后再脱敏"：脱敏报告与只给保留文件时完全一样。
    source.repoFiles = vi.fn(async () => files.filter((f) => !isEnvFile(f.path)));
    const baseline = await buildPackage(
      { project_id: PROJECT, scope: { kind: "ticket", ticket_id: "T-2" }, include_full_repo: true },
      deps,
    );
    expect(pkg.redaction_report).toEqual(baseline.redaction_report);
    expect(baseline.manifest.excluded_env_files).toBe(0);
  });
});

describe("T-019：diff_file 就是写进 zip 的条目路径", () => {
  it("单号和路径会触发脱敏时，tickets.jsonl 里的 diff_file / context_files 仍与 zip 条目逐字一致", async () => {
    const base = makeTickets()[1]!;
    const tricky: TicketRecord = {
      ...base,
      ticket_id: "TOKEN=T-7",
      context_snippets: [
        { path: `/home/${FAKE.homeUser}/proj/API_KEY=abc.ts`, content: "ctx\n" },
        { path: "srv.corp/a.ts", content: "ctx\n" },
      ],
      rounds: [base.rounds[0]!, { ...base.rounds[0]!, round: 2 }],
    };
    source.queryTickets = async () => [tricky];
    const evalDeps: ExportDeps = {
      ...deps,
      eval_tasks: { "TOKEN=T-7": { test_names: ["t"], run_command: "pytest" } },
    };
    const zip_path = await exportPackage(
      { project_id: PROJECT, scope: { kind: "requirement", requirement_id: "R-2" } },
      evalDeps,
    );
    const entries = readZip(await readFile(zip_path));
    const names = new Set(entries.map((e) => e.name));
    const ticketsJsonl = entries.find((e) => e.name === "tickets.jsonl")!.data.toString("utf8");
    const t = JSON.parse(ticketsJsonl.trim()) as {
      ticket_id: string;
      rounds: { diff_file: string }[];
      context_files: string[];
    };
    expect(t.ticket_id).not.toContain("T-7");
    const diffFiles = t.rounds.map((r) => r.diff_file);
    expect(diffFiles).toHaveLength(2);
    expect(new Set(diffFiles).size).toBe(2);
    for (const f of [...diffFiles, ...t.context_files]) {
      expect(names.has(f)).toBe(true);
      expect(f).not.toContain("[REDACTED");
    }
    const pkg = await readPackage(zip_path);
    expect([...pkg.manifest.files].sort()).toEqual([...names].sort());
    const inst = JSON.parse(toSweBenchJsonl(pkg).trim());
    expect(inst.patch).toContain("diff --git a/README.md b/README.md");
  });
});

describe("T-021：.env 排除规则", () => {
  const repoOnly = async (files: RawFile[]) => {
    source.repoFiles = vi.fn(async () => files);
    return buildPackage(
      { project_id: PROJECT, scope: { kind: "ticket", ticket_id: "T-2" }, include_full_repo: true },
      deps,
    );
  };

  it("大小写不敏感：.ENV、.Env.local 也排除", async () => {
    const pkg = await repoOnly([
      { path: ".ENV", content: "A=1\n" },
      { path: "apps/web/.Env.local", content: "B=2\n" },
      { path: "CONFIG/.eNv.Production/x.txt", content: "C=3\n" },
      { path: "src/index.ts", content: "export {};\n" },
    ]);
    expect(pkg.raw_files.filter((f) => f.path.startsWith("repo/")).map((f) => f.path)).toEqual([
      "repo/src/index.ts",
    ]);
    expect(pkg.manifest.excluded_env_files).toBe(3);
    expect(isEnvFile(".ENV")).toBe(true);
    expect(isEnvFile("a\\.Env.local")).toBe(true);
  });

  it(".envrc 也排除（含大小写变体），.environment.md 之类仍保留", async () => {
    const pkg = await repoOnly([
      { path: ".envrc", content: "export A=1\n" },
      { path: "sub/.ENVRC", content: "export B=1\n" },
      { path: "docs/.environment.md", content: "kept\n" },
      { path: "src/envrc.ts", content: "kept\n" },
    ]);
    expect(
      pkg.raw_files
        .filter((f) => f.path.startsWith("repo/"))
        .map((f) => f.path)
        .sort(),
    ).toEqual(["repo/docs/.environment.md", "repo/src/envrc.ts"]);
    expect(pkg.manifest.excluded_env_files).toBe(2);
    expect(isEnvFile("x/.envrc")).toBe(true);
    expect(isEnvFile("x/.envrc.bak")).toBe(true);
    expect(isEnvFile("x/.envrcx")).toBe(false);
  });

  it("上下文片段同样排除：不进包，只在 manifest 记个数，不记路径", async () => {
    const base = makeTickets()[1]!;
    const marker = "CTXENVMARKER";
    const t: TicketRecord = {
      ...base,
      context_snippets: [
        { path: "src/keep.ts", content: "keep\n" },
        { path: `secretdir-${marker}/.env`, content: `X=${marker}\nDB_PASSWORD=${FAKE.envPass}\n` },
        { path: `pkg/.Env.Local`, content: `${marker}\n` },
        { path: `.envrc`, content: `${marker}\n` },
      ],
    };
    source.queryTickets = async () => [t];
    const zip_path = await exportPackage(
      { project_id: PROJECT, scope: { kind: "ticket", ticket_id: "T-2" } },
      deps,
    );
    const entries = readZip(await readFile(zip_path));
    const pkg = await readPackage(zip_path);
    expect(pkg.tickets[0]!.context_files).toEqual(["raw/T-2/context/src/keep.ts"]);
    expect(pkg.manifest.excluded_context_env_files).toBe(3);
    expect(pkg.manifest.excluded_env_files).toBe(0);
    for (const e of entries) {
      expect(e.name).not.toContain(marker);
      expect(e.name.toLowerCase()).not.toMatch(/(^|\/)\.env/);
      expect(e.data.toString("utf8")).not.toContain(marker);
    }
    // 不是打包后再脱敏：没有因这些文件内容产生 env_secret 命中。
    source.queryTickets = async () => [{ ...t, context_snippets: [t.context_snippets[0]!] }];
    const baseline = await buildPackage(
      { project_id: PROJECT, scope: { kind: "ticket", ticket_id: "T-2" } },
      deps,
    );
    expect(pkg.redaction_report).toEqual(baseline.redaction_report);
  });
});

describe("T-021：schema bakacoding-diag/v1.1", () => {
  it("新导出的包是 v1.1", async () => {
    const pkg = await buildPackage(
      { project_id: PROJECT, scope: { kind: "ticket", ticket_id: "T-2" } },
      deps,
    );
    expect(DIAG_SCHEMA).toBe("bakacoding-diag/v1.1");
    expect(pkg.manifest.schema).toBe("bakacoding-diag/v1.1");
  });

  it("readPackage 读 v1.1，也仍能读 v1 旧包；未知 schema 报错", async () => {
    const pkg = await buildPackage(
      { project_id: PROJECT, scope: { kind: "ticket", ticket_id: "T-2" } },
      deps,
    );
    const p11 = join(dir, "v11.zip");
    await writeFile(p11, packageToZip(pkg));
    expect((await readPackage(p11)).manifest.schema).toBe("bakacoding-diag/v1.1");
    // 模拟 v1 旧包：schema 为 v1，没有 v1.1 新增的 excluded_context_env_files。
    const { excluded_context_env_files: _drop, ...v1manifest } =
      pkg.manifest as typeof pkg.manifest & {
        excluded_context_env_files?: number;
      };
    void _drop;
    const v1 = packageToZip({ ...pkg, manifest: { ...v1manifest, schema: "bakacoding-diag/v1" } });
    const p1 = join(dir, "v1.zip");
    await writeFile(p1, v1);
    const back = await readPackage(p1);
    expect(back.manifest.schema).toBe("bakacoding-diag/v1");
    expect(back.manifest.excluded_context_env_files).toBeUndefined();
    expect(back.tickets.map((t) => t.ticket_id)).toEqual(["T-2"]);

    for (const bad of ["bakacoding-diag/v2", "bakacoding-diag/v1.2", "other/v9"]) {
      const z = packageToZip({ ...pkg, manifest: { ...pkg.manifest, schema: bad as never } });
      const pb = join(dir, "bad.zip");
      await writeFile(pb, z);
      await expect(readPackage(pb)).rejects.toThrow(/schema/);
    }
  });
});
