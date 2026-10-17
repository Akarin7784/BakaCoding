// T-024：模块 2 的 Storage.diagnosticsSource() 作为模块 11 的数据源（modules.md 11：「模块 2 写适配器实现」）。
// 夹具全部通过存储 API 写入临时库；假密钥都是按格式拼的假值。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openStorage, type Storage } from "@bakacoding/storage";
import type { BakaEvent, DiagnosticsSource } from "@bakacoding/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPackage, exportPackage, readPackage, readZip } from "./index.js";

const FAKE_SK = `sk-${"FAKEstorage0000".repeat(2)}`;
const FAKE_IP = "10.20.30.40";
const FAKE_HOME_USER = "fakehomeuser";
const SHA = "c".repeat(40);

let dir: string;
let storage: Storage;
let source: DiagnosticsSource;
let seq = 0;

function ev(
  type: "call_completed" | "group_message" | "project_created" | "escalated",
  ts: string,
  requirement_id: string | null,
  ticket_id: string | null,
  extra: Record<string, unknown> = {},
): BakaEvent {
  seq += 1;
  const common = {
    event_id: `evt-${seq}`,
    seq,
    ts,
    trace_id: `trace-${requirement_id ?? "p"}`,
    span_id: `span-${seq}`,
    parent_span_id: null,
    requirement_id,
    ticket_id,
  };
  switch (type) {
    case "project_created":
      return {
        ...common,
        type,
        payload: { project_id: "P-1", name: "proj", language: "TS", has_github_remote: false },
      } as BakaEvent;
    case "group_message":
      return {
        ...common,
        type,
        payload: {
          project_id: "P-1",
          sender: "sub_agent",
          kind: "report",
          content: `部署在 ${FAKE_IP}，日志在 /home/${FAKE_HOME_USER}/logs`,
          flash_calls: [],
          ...extra,
        },
      } as BakaEvent;
    case "escalated":
      return { ...common, type, payload: { reason: "review_limit", ...extra } } as BakaEvent;
    case "call_completed":
      return {
        ...common,
        type,
        payload: {
          role: "coder",
          provider: "deepseek",
          model: "deepseek-v4.1-flash",
          effort: "low",
          prompt: `key=${FAKE_SK} host ${FAKE_IP}`,
          output: "ok",
          tokens: { input: 10, output: 2, cache_hit_input: 0 },
          cache_hit: false,
          latency_ms: 100,
          cost: 7,
          is_resubmit: false,
          rate_limited_retry: 0,
          ...extra,
        },
      } as BakaEvent;
  }
}

function ticket(ticket_id: string, requirement_id: string, created_at: string, project_id = "P-1") {
  storage.saveTicket({
    ticket_id,
    project_id,
    requirement_id,
    created_at,
    ticket_text: `${ticket_id} 需求原文`,
    decomposition_summary: "拆单摘要",
    status: "merged",
    outcome: "passed_after_resubmit",
    base_commit: SHA,
    permission_list: [{ glob: "src/**", level: "rw" }],
    context_snippets: [
      { path: "src/a.ts", content: `// 服务器 ${FAKE_IP}\n` },
      { path: "src/.env", content: "SHOULD_NOT_EXPORT=1\n" },
    ],
    ci_checks: [{ name: "ci", conclusion: "success" }],
  });
}

const diff = (patch: string) => ({
  base_sha: SHA,
  head_sha: "d".repeat(40),
  files: [{ path: "src/a.ts", status: "modified" as const, additions: 1, deletions: 0, patch }],
});

beforeEach(() => {
  seq = 0;
  dir = mkdtempSync(path.join(tmpdir(), "bc-diag-storage-"));
  storage = openStorage({ path: path.join(dir, "s.db") });
  source = storage.diagnosticsSource();

  storage.ingest(ev("project_created", "2026-10-10T00:00:00Z", null, null));
  ticket("T-1", "R-1", "2026-10-10T01:00:00Z");
  ticket("T-2", "R-1", "2026-10-10T01:00:00.999Z");
  ticket("T-3", "R-2", "2026-10-10T01:00:01.000Z");
  ticket("T-9", "R-9", "2026-10-10T01:00:00.500Z", "P-other");
  storage.savePrRecord({
    ticket_id: "T-1",
    round: 1,
    diff: diff(`@@ -1 +1,2 @@\n+// ${FAKE_IP}`),
    verdict: "fail",
    fail_reasons: ["缺测试"],
  });
  storage.savePrRecord({
    ticket_id: "T-1",
    round: 2,
    diff: diff("@@ -1 +1,2 @@\n+ok"),
    verdict: "pass",
    fail_reasons: [],
    review_comments: "补上了",
  });
  storage.saveMergeResult("T-1", {
    conflicted: false,
    base_changed: true,
    re_reviewed: true,
    merged: true,
  });
  storage.markForEvalSet("T-1");

  // 时间格式混用：有的带毫秒、有的不带
  storage.ingest(ev("call_completed", "2026-10-10T01:00:00Z", "R-1", "T-1"));
  storage.ingest(
    ev("call_completed", "2026-10-10T01:00:00.500Z", "R-1", "T-1", { is_resubmit: true, cost: 5 }),
  );
  storage.ingest(ev("group_message", "2026-10-10T01:00:00.999Z", "R-1", "T-2"));
  storage.ingest(ev("escalated", "2026-10-10T01:00:01.000Z", "R-2", "T-3"));
  storage.ingest(ev("call_completed", "2026-10-10T01:00:00.700Z", "R-9", "T-9"));
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Storage.diagnosticsSource() 作为诊断数据源", () => {
  it("需求单：轮次、合并结果、评测集标记、CI、上下文都来自存储；只给本项目", async () => {
    const tickets = await source.queryTickets({ project_id: "P-1" });
    expect(tickets.map((t) => t.ticket_id)).toEqual(["T-1", "T-2", "T-3"]);
    const t1 = tickets[0]!;
    expect(t1.rounds.map((r) => [r.round, r.verdict])).toEqual([
      [1, "fail"],
      [2, "pass"],
    ]);
    expect(t1.merge).toEqual({
      conflicted: false,
      base_changed: true,
      re_reviewed: true,
      merged: true,
    });
    expect(t1.marked_for_eval_set).toBe(true);
    expect(t1.outcome).toBe("passed_after_resubmit");
    expect(t1.ci_checks).toEqual([{ name: "ci", conclusion: "success" }]);
    expect(t1.context_snippets.map((f) => f.path)).toEqual(["src/a.ts", "src/.env"]);
    // 存储不存仓库文件，适配器不提供 repoFiles
    expect(source.repoFiles).toBeUndefined();
  });

  it("按单：只有这张单的事件和记录", async () => {
    const pkg = await buildPackage(
      { project_id: "P-1", scope: { kind: "ticket", ticket_id: "T-1" } },
      { source, out_dir: dir },
    );
    expect(pkg.tickets.map((t) => t.ticket_id)).toEqual(["T-1"]);
    expect(pkg.events.map((e) => [e.type, e.ticket_id])).toEqual([
      ["call_completed", "T-1"],
      ["call_completed", "T-1"],
    ]);
    expect(pkg.tickets[0]!.cost).toEqual({
      ticket_id: "T-1",
      total_micro_usd: 12,
      resubmit_micro_usd: 5,
      entries: 2,
    });
  });

  it("按需求：含需求下全部单，不含别的需求和别的项目", async () => {
    const pkg = await buildPackage(
      { project_id: "P-1", scope: { kind: "requirement", requirement_id: "R-1" } },
      { source, out_dir: dir },
    );
    expect(pkg.tickets.map((t) => t.ticket_id)).toEqual(["T-1", "T-2"]);
    expect(pkg.events.map((e) => e.event_id)).toEqual(["evt-2", "evt-3", "evt-4"]);
  });

  it("按时间段：两端都包含，带毫秒和不带毫秒的时间按毫秒比较", async () => {
    // from 不带毫秒、to 带毫秒；边界上的 T-1（01:00:00Z）和 T-2（01:00:00.999Z）都要进来，T-3（01:00:01.000Z）不进
    const scope = {
      kind: "time_range" as const,
      from: "2026-10-10T01:00:00Z",
      to: "2026-10-10T01:00:00.999Z",
    };
    const pkg = await buildPackage({ project_id: "P-1", scope }, { source, out_dir: dir });
    expect(pkg.tickets.map((t) => t.ticket_id)).toEqual(["T-1", "T-2"]);
    expect(pkg.events.map((e) => e.ts)).toEqual([
      "2026-10-10T01:00:00Z",
      "2026-10-10T01:00:00.500Z",
      "2026-10-10T01:00:00.999Z",
    ]);
    // 别的项目同一时段的单和事件不进
    expect(JSON.stringify(pkg)).not.toContain("T-9");

    // 反过来：from 带毫秒、to 不带毫秒，正好卡在 T-3 上
    const pkg2 = await buildPackage(
      {
        project_id: "P-1",
        scope: { kind: "time_range", from: "2026-10-10T01:00:01.000Z", to: "2026-10-10T01:00:01Z" },
      },
      { source, out_dir: dir },
    );
    expect(pkg2.tickets.map((t) => t.ticket_id)).toEqual(["T-3"]);
    expect(pkg2.events.map((e) => e.type)).toEqual(["escalated"]);
  });

  it("数据源直接查询同样两端包含（存储层按 ts_ms / created_at_ms 过滤）", async () => {
    const f = {
      project_id: "P-1",
      from: "2026-10-10T01:00:00.000Z",
      to: "2026-10-10T01:00:00.999Z",
    };
    expect((await source.queryEvents(f)).map((e) => e.event_id)).toEqual([
      "evt-2",
      "evt-3",
      "evt-4",
    ]);
    expect((await source.queryTickets(f)).map((t) => t.ticket_id)).toEqual(["T-1", "T-2"]);
  });

  it("勾选完整仓库：存储没有仓库文件来源，导出明确报错而不是假装导出", async () => {
    await expect(
      buildPackage(
        { project_id: "P-1", scope: { kind: "ticket", ticket_id: "T-1" }, include_full_repo: true },
        { source, out_dir: dir },
      ),
    ).rejects.toThrow(/repoFiles/);
  });
});

describe("端到端：从存储导出诊断包", () => {
  it("zip 里没有假密钥和内网信息，脱敏报告记下了完整脱敏的命中", async () => {
    const zip_path = await exportPackage(
      { project_id: "P-1", scope: { kind: "requirement", requirement_id: "R-1" } },
      { source, out_dir: dir, now: () => new Date("2026-10-17T07:00:00Z") },
    );
    const bytes = readFileSync(zip_path);
    const entries = readZip(bytes);
    const all = [
      zip_path,
      bytes.toString("latin1"),
      ...entries.map((e) => e.name),
      ...entries.map((e) => e.data.toString("utf8")),
    ];
    for (const needle of [FAKE_SK, FAKE_IP, FAKE_HOME_USER, "SHOULD_NOT_EXPORT"]) {
      for (const s of all) expect(s).not.toContain(needle);
    }
    // 事件确实进了包（不是靠没导出来"通过"）
    const pkg = await readPackage(zip_path);
    expect(pkg.manifest.schema).toBe("bakacoding-diag/v1.1");
    const msg = pkg.events.find((e) => e.type === "group_message");
    expect(msg?.type === "group_message" && msg.payload.content).toBe(
      "部署在 [REDACTED:ipv4]，日志在 [REDACTED:home_path]/logs",
    );
    // 落库时轻脱敏已去掉 sk- key；内网 IP 和 home 路径只在导出的完整脱敏里去掉，并计入报告
    expect(pkg.redaction_report.ipv4).toBeGreaterThan(0);
    expect(pkg.redaction_report.home_path).toBeGreaterThan(0);
    expect(JSON.stringify(pkg.redaction_report)).not.toContain(FAKE_IP);
    // 上下文里的 .env 不进包，只计数
    expect(pkg.manifest.excluded_context_env_files).toBe(2);
    expect(pkg.tickets.find((t) => t.ticket_id === "T-1")!.rounds).toHaveLength(2);
  });
});

// T-056：需求单的结构化字段 `fields`（T-055）按设计不脱敏，诊断包永远不能带上它。
// 两道防线各测一次：存储适配器不读出 fields；就算以后数据源把它带出来，模块 11 按字段白名单拼包也不收。
// 标记串故意不像密钥 / IP / 路径，脱敏规则抓不到：测的是白名单，不是脱敏。
describe("需求单 fields 不进诊断包（T-056）", () => {
  const MARK_KEY = "fieldsGuardKey7f3a";
  const MARK_VAL = "fields-guard-marker-91c2";
  const FIELDS = {
    write_scope: [`src/${MARK_VAL}/**`],
    interfaces: [MARK_VAL],
    [MARK_KEY]: { nested: [MARK_VAL] },
  };

  async function expectNoFields(src: DiagnosticsSource) {
    for (const scope of [
      { kind: "ticket", ticket_id: "T-1" } as const,
      { kind: "requirement", requirement_id: "R-1" } as const,
      {
        kind: "time_range",
        from: "2026-10-10T00:00:00Z",
        to: "2026-10-10T23:59:59Z",
      } as const,
    ]) {
      const out_dir = mkdtempSync(path.join(dir, "out-"));
      const zip_path = await exportPackage(
        { project_id: "P-1", scope },
        { source: src, out_dir, now: () => new Date("2026-10-17T07:00:00Z") },
      );
      const entries = readZip(readFileSync(zip_path));
      expect(entries.map((e) => e.name)).toContain("tickets.jsonl");
      for (const s of [
        ...entries.map((e) => e.name),
        ...entries.map((e) => e.data.toString("utf8")),
      ]) {
        expect(s).not.toContain(MARK_VAL);
        expect(s).not.toContain(MARK_KEY);
      }
      // 只查需求单记录本身有没有 fields 键，不拦整个包里的 "fields" 字样（别处以后可能有同名字段）
      const ticketsJsonl = entries.find((e) => e.name === "tickets.jsonl")!.data.toString("utf8");
      for (const line of ticketsJsonl.split("\n").filter(Boolean)) {
        expect(Object.keys(JSON.parse(line) as object)).not.toContain("fields");
      }
      const pkg = await readPackage(zip_path);
      expect(pkg.tickets.map((t) => t.ticket_id)).toContain("T-1");
      for (const t of pkg.tickets) expect(Object.keys(t)).not.toContain("fields");
    }
  }

  beforeEach(() => {
    storage.saveTicket({
      ticket_id: "T-1",
      project_id: "P-1",
      requirement_id: "R-1",
      created_at: "2026-10-10T01:00:00Z",
      ticket_text: "T-1 需求原文",
      decomposition_summary: "拆单摘要",
      status: "merged",
      outcome: "passed_after_resubmit",
      base_commit: SHA,
      permission_list: [{ glob: "src/**", level: "rw" }],
      context_snippets: [],
      ci_checks: [],
      fields: FIELDS,
    });
    // 库里确实存上了（不是靠没写进去「通过」）
    expect(JSON.stringify(storage.getTicket("T-1")?.fields)).toContain(MARK_VAL);
  });

  it("存储适配器：diagnosticsSource() 读出的需求单不带 fields，导出的 zip 里找不到标记串", async () => {
    const [t1] = await source.queryTickets({ project_id: "P-1", ticket_id: "T-1" });
    expect(t1).toBeDefined();
    expect(Object.keys(t1!)).not.toContain("fields");
    await expectNoFields(source);
  });

  it("模块 11 白名单：数据源把 fields 带出来，包里也没有", async () => {
    const leaky: DiagnosticsSource = {
      queryEvents: (f) => source.queryEvents(f),
      async queryTickets(f) {
        return (await source.queryTickets(f)).map((t) => ({ ...t, fields: FIELDS }));
      },
    };
    expect(JSON.stringify(await leaky.queryTickets({ project_id: "P-1" }))).toContain(MARK_VAL);
    await expectNoFields(leaky);
  });
});

// T-060：凭据 URL 的各种写法（#58 / T-059 定的那张清单）放进事件 detail 和消息正文，
// 从存储端到端导出后，包里任何文件都查不到凭据值。落库有轻脱敏、导出有完整脱敏，两道都算数，测的是最终结果。
// 假凭据全部运行时拼出来，源码里不出现完整的 token 字面量。
describe("凭据 URL 各种写法不进诊断包（T-060）", () => {
  const HEX40 = "0123456789abcdef".repeat(3).slice(0, 40);
  const B64 = "QmFrYUNvZGluZ0Zha2VUb2tlbg".repeat(2);
  const GHP = `ghp${"_"}${"FAKEtoken0".repeat(4)}`;
  const PAT = `github${"_pat_"}${"FAKEpat000".repeat(3)}`;
  const GLPAT = `glpat${"-"}${"FAKEglpat0".repeat(2)}`;
  const sec = (tag: string) => `fakeSecret${tag}9x7q`;

  // [说明, 写法, 必须查不到的凭据值]
  const CASES: [string, string, string][] = [
    ["user:pass@（基线）", `https://user:${sec("A")}@git.example.com/o/r`, sec("A")],
    ["40 位十六进制用户名", `https://${HEX40}@github.com/o/r`, HEX40],
    ["长 base64 用户名", `https://${B64}@github.com/o/r`, B64],
    ["%3A 编码的冒号", `https://x%3A${sec("B")}@git.example.com/o/r`, sec("B")],
    ["git:// 带 token 前缀的用户名", `git://${GHP}@git.example.com/o/r`, GHP],
    ["ssh:// 带 token 前缀的用户名", `ssh://${GHP}@git.example.com/o/r`, GHP],
    ["查询参数 token", `https://git.example.com/o/r?token=${sec("C")}`, sec("C")],
    ["查询参数 access_token", `https://git.example.com/o/r?x=1&access_token=${sec("D")}`, sec("D")],
    ["查询参数 private_token", `https://git.example.com/o/r?private_token=${sec("E")}`, sec("E")],
    ["查询参数 api_key", `https://git.example.com/o/r?api_key=${sec("F")}`, sec("F")],
    ["查询参数 X-Amz-Signature", `https://b.example.com/k?X-Amz-Signature=${sec("G")}`, sec("G")],
    ["参数名大写", `https://git.example.com/o/r?TOKEN=${sec("H")}`, sec("H")],
    ["参数名带 []", `https://git.example.com/o/r?token[]=${sec("I")}`, sec("I")],
    ["# 后面的 access_token", `https://git.example.com/cb#access_token=${sec("J")}`, sec("J")],
    ["scheme 后少了 //", `https:user:${sec("K")}@git.example.com`, sec("K")],
    ["scheme 后是 /\\", `https:/\\user:${sec("L")}@git.example.com`, sec("L")],
    ["嵌在一句话里", `远程是  https://user:${sec("M")}@git.example.com/o/r 请检查`, sec("M")],
    ["裸 ghp_ token", `token 是 ${GHP}`, GHP],
    ["裸 github_pat_ token", `token 是 ${PAT}`, PAT],
    ["裸 glpat- token", `token 是 ${GLPAT}`, GLPAT],
  ];

  async function exportT2() {
    const out_dir = mkdtempSync(path.join(dir, "out-"));
    const zip_path = await exportPackage(
      { project_id: "P-1", scope: { kind: "ticket", ticket_id: "T-2" } },
      { source, out_dir, now: () => new Date("2026-10-17T07:00:00Z") },
    );
    const entries = readZip(readFileSync(zip_path));
    return { zip_path, entries };
  }

  it.each(CASES)("%s：detail 和消息正文里的凭据都被抹掉", async (_label, text, secret) => {
    storage.ingest(
      ev("escalated", "2026-10-10T01:00:00.999Z", "R-1", "T-2", { detail: `push 失败：${text}` }),
    );
    storage.ingest(
      ev("group_message", "2026-10-10T01:00:00.999Z", "R-1", "T-2", { content: text }),
    );
    const { zip_path, entries } = await exportT2();
    for (const s of [
      ...entries.map((e) => e.name),
      ...entries.map((e) => e.data.toString("utf8")),
    ]) {
      expect(s).not.toContain(secret);
    }
    // 两条事件确实进了包（不是靠没导出来「通过」）
    const pkg = await readPackage(zip_path);
    expect(pkg.events.some((e) => e.type === "escalated" && e.ticket_id === "T-2")).toBe(true);
    expect(
      pkg.events.filter((e) => e.type === "group_message" && e.ticket_id === "T-2"),
    ).toHaveLength(2);
  });

  it("40 位十六进制用户名由 url_credentials 规则拦下，不是碰巧被邮箱规则抹掉", async () => {
    storage.ingest(
      ev("escalated", "2026-10-10T01:00:00.999Z", "R-1", "T-2", {
        detail: `push 失败：https://${HEX40}@github.com/o/r`,
      }),
    );
    const { zip_path } = await exportT2();
    const pkg = await readPackage(zip_path);
    const esc = pkg.events.find((e) => e.type === "escalated" && e.ticket_id === "T-2");
    const detail = esc?.type === "escalated" ? (esc.payload.detail ?? "") : "";
    expect(detail).not.toContain(HEX40);
    expect(detail).toContain("[REDACTED:url_credentials]");
    expect(detail).not.toContain("[REDACTED:email]");
  });
  // 10 万字符的 detail 导出不能卡住（T-059 修 redact 的平方级耗时；修复前 full 档 `a.a.…` 约 23 秒）
  it.each([
    ["a.a.…", "a.".repeat(50_000)],
    ["纯字母", "a".repeat(100_000)],
    ["a@a@…", "a@".repeat(50_000)],
    ["a:a:…", "a:".repeat(50_000)],
    ["https://u:u:…", `https://u:${"u:".repeat(50_000)}`],
  ])(
    "10 万字符的 %s detail 导出在 500ms 内",
    async (_label, big) => {
      storage.ingest(ev("escalated", "2026-10-10T01:00:00.999Z", "R-1", "T-2", { detail: big }));
      const t0 = performance.now();
      const { zip_path } = await exportT2();
      expect(performance.now() - t0).toBeLessThan(500);
      const pkg = await readPackage(zip_path);
      expect(pkg.events.some((e) => e.type === "escalated" && e.ticket_id === "T-2")).toBe(true);
    },
    120_000,
  );
});
