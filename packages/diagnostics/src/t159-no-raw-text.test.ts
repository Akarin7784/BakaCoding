// T-159：诊断包不含对话和提示词原文。原文字段换成 {len, hmac}，hmac 用每包随机 salt，salt 不进包。
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BakaEvent } from "@bakacoding/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 记下导出时生成的每一个 salt（只为验证 salt 不进包；源码照常调用真的 randomBytes）。
const salts = vi.hoisted(() => [] as Buffer[]);
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomBytes: (n: number) => {
      const b = actual.randomBytes(n);
      salts.push(b);
      return b;
    },
  };
});

import {
  exportPackage,
  readPackage,
  readZip,
  toSweBenchJsonl,
  writeZip,
  TEXT_DIGEST_NOTE,
  type DiagnosticsSource,
  type TextDigest,
  type TicketRecord,
} from "./index.js";

const PROJECT = "proj-159";
const SHA = "c".repeat(40);

// 多轮对话里的原文：用户原话（含很短的回复）、模型回复、思考内容、评审文本。故意不像密钥，脱敏规则抓不到。
const RAW = {
  userAsk: "帮我把登录页改成支持手机号验证码登录",
  userOk: "可以",
  userDefault: "按默认来",
  modelReply: "好的，我会先拆成两张单：短信接口和登录页表单",
  reasoning: "用户想要手机号登录，先确认短信服务商再拆单",
  failedPrompt: "第三轮请求：继续完善验证码倒计时逻辑",
  failedReasoning: "倒计时用 setInterval 还是 requestAnimationFrame",
  dispatch: "派单给编码组：实现短信发送接口",
  ifaceSummary: "新增 sendSmsCode 导出函数，签名改为返回 Promise",
  escalation: "用户拒绝原因：这个依赖太大了换一个",
  warning: "需求原文太长截断在两万码点处",
  scopeReason: "需要改动共享的表单校验工具函数",
  scopeDenied: "写入范围超出本单权限请走申请流程",
  ticketText: "实现手机号验证码登录页面与倒计时按钮",
  decomposition: "按前后端拆分为接口单和页面单两张",
  failReason: "倒计时结束后按钮没有恢复可点击状态",
  review: "请补上验证码过期的错误提示文案",
} as const;

let seq = 0;
const ev = (type: string, ts: string, payload: Record<string, unknown>): BakaEvent =>
  ({
    event_id: `ev-${++seq}`,
    seq,
    ts,
    requirement_id: "R-1",
    ticket_id: "T-1",
    trace_id: "tr-1",
    span_id: `sp-${seq}`,
    parent_span_id: null,
    type,
    payload,
  }) as unknown as BakaEvent;

const call = (ts: string, prompt: string, output: string, error?: { code: string }) =>
  ev("call_completed", ts, {
    role: "supervisor",
    provider: "deepseek",
    model: "deepseek-v4.1-flash",
    effort: "low",
    prompt,
    output,
    tokens: { input: 10, output: 5, cache_hit_input: 0 },
    cache_hit: false,
    latency_ms: 10,
    cost: 1,
    is_resubmit: false,
    rate_limited_retry: 0,
    ...(error ? { error } : {}),
  });

function makeEvents(): BakaEvent[] {
  seq = 0;
  return [
    call(
      "2026-10-10T01:00:00.000Z",
      `user: ${RAW.userAsk}\n[reasoning]\n${RAW.reasoning}`,
      RAW.modelReply,
    ),
    call("2026-10-10T01:01:00.000Z", `user: ${RAW.userOk}`, RAW.modelReply),
    call("2026-10-10T01:02:00.000Z", RAW.userDefault, RAW.userOk),
    // 失败（含取消）的调用：prompt 带完整输入和已收到的思考内容，output 为空串
    call(
      "2026-10-10T01:03:00.000Z",
      `${RAW.failedPrompt}\n[reasoning]\n${RAW.failedReasoning}`,
      "",
      { code: "ABORTED" },
    ),
    ev("group_message", "2026-10-10T01:04:00.000Z", {
      project_id: PROJECT,
      sender: "supervisor",
      kind: "dispatch",
      content: RAW.dispatch,
      flash_calls: [],
    }),
    ev("group_message", "2026-10-10T01:05:00.000Z", {
      project_id: PROJECT,
      sender: "sub_agent",
      kind: "report",
      content: RAW.userOk,
      flash_calls: [],
    }),
    ev("interface_changed", "2026-10-10T01:06:00.000Z", {
      pr_id: "pr-1",
      base_commit: SHA,
      changed_interfaces: [{ file: "src/sms.ts", symbol: "sendSmsCode" }],
      summary: RAW.ifaceSummary,
      affected_ticket_ids: [],
    }),
    ev("escalated", "2026-10-10T01:07:00.000Z", {
      reason: "high_risk_rejected",
      detail: RAW.escalation,
    }),
    ev("ticket_warning", "2026-10-10T01:08:00.000Z", {
      project_id: PROJECT,
      code: "requirement_truncated",
      detail: RAW.warning,
    }),
    ev("write_scope_requested", "2026-10-10T01:09:00.000Z", {
      request_id: "rq-1",
      requested_scope: ["src/form/**"],
      reason: RAW.scopeReason,
    }),
    ev("write_scope_denied", "2026-10-10T01:10:00.000Z", {
      request_id: "rq-1",
      reason: RAW.scopeDenied,
    }),
  ];
}

const tickets = (): TicketRecord[] => [
  {
    project_id: PROJECT,
    ticket_id: "T-1",
    requirement_id: "R-1",
    created_at: "2026-10-10T00:30:00.000Z",
    ticket_text: RAW.ticketText,
    decomposition_summary: RAW.decomposition,
    status: "merged",
    outcome: "passed_after_resubmit",
    base_commit: SHA,
    permission_list: [{ glob: "src/**", level: "rw" }],
    rounds: [
      {
        round: 1,
        verdict: "fail",
        fail_reasons: [RAW.failReason, RAW.userOk],
        diff: {
          base_sha: SHA,
          head_sha: SHA,
          files: [
            {
              path: "src/login.ts",
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: "@@ -1 +1 @@\n+const a = 1;",
            },
          ],
        },
      },
      {
        round: 2,
        verdict: "pass",
        fail_reasons: [],
        review_comments: RAW.review,
        diff: {
          base_sha: SHA,
          head_sha: SHA,
          files: [
            {
              path: "src/login.ts",
              status: "modified",
              additions: 1,
              deletions: 0,
              patch: "@@ -1 +1 @@\n+const a = 2;",
            },
          ],
        },
      },
    ],
    context_snippets: [{ path: "src/login.ts", content: "export const a = 0;\n" }],
    marked_for_eval_set: true,
  } as TicketRecord,
];

const source: DiagnosticsSource = {
  queryEvents: () => makeEvents(),
  queryTickets: () => tickets(),
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "diag-t159-"));
  salts.length = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const deps = (out: string) => ({
  source,
  out_dir: join(dir, out),
  eval_tasks: { "T-1": { test_names: ["login.test"], run_command: "pnpm test" } },
  now: () => new Date("2026-10-24T11:00:00Z"),
});
const exportOne = (out: string) =>
  exportPackage(
    { project_id: PROJECT, scope: { kind: "requirement", requirement_id: "R-1" } },
    deps(out),
  );

/** zip 里每个文件的全部文本：条目名、解压后的内容，外加压缩后的原始字节。 */
async function allText(zip_path: string): Promise<string[]> {
  const bytes = await readFile(zip_path);
  const entries = readZip(bytes);
  return [
    zip_path,
    bytes.toString("latin1"),
    bytes.toString("utf8"),
    ...entries.map((e) => e.name),
    ...entries.map((e) => e.data.toString("utf8")),
  ];
}

const isDigest = (v: unknown): v is TextDigest =>
  typeof v === "object" &&
  v !== null &&
  Object.keys(v).sort().join() === "hmac,len" &&
  typeof (v as TextDigest).len === "number" &&
  /^[0-9a-f]{64}$/.test((v as TextDigest).hmac);

describe("T-159：诊断包不含对话和提示词原文", () => {
  it("多轮对话（含失败调用和「可以」「按默认来」这种短回复）：zip 里每个文件都搜不到任何原文", async () => {
    const zip_path = await exportOne("a");
    const all = await allText(zip_path);
    for (const [name, raw] of Object.entries(RAW)) {
      for (const s of all) expect(s.includes(raw), `${name} 原文进了包`).toBe(false);
    }
    // 事件和单子确实导出了（不是靠没导出来"通过"）
    const pkg = await readPackage(zip_path);
    expect(pkg.events).toHaveLength(makeEvents().length);
    expect(pkg.tickets).toHaveLength(1);
  });

  it("每个要摘要的字段都换成了 {len, hmac}，len 是码点数；其余字段保留", async () => {
    const pkg = await readPackage(await exportOne("a"));
    const p = (i: number) => pkg.events[i]!.payload;
    const textFields: [number, string, string][] = [
      [0, "prompt", `user: ${RAW.userAsk}\n[reasoning]\n${RAW.reasoning}`],
      [0, "output", RAW.modelReply],
      [3, "prompt", `${RAW.failedPrompt}\n[reasoning]\n${RAW.failedReasoning}`],
      [3, "output", ""],
      [4, "content", RAW.dispatch],
      [6, "summary", RAW.ifaceSummary],
      [7, "detail", RAW.escalation],
      [8, "detail", RAW.warning],
      [9, "reason", RAW.scopeReason],
      [10, "reason", RAW.scopeDenied],
    ];
    for (const [i, k, raw] of textFields) {
      const v = p(i)[k];
      expect(isDigest(v), `${pkg.events[i]!.type}.${k}`).toBe(true);
      expect((v as TextDigest).len).toBe([...raw].length);
    }
    // 失败调用：prompt 摘要了，错误码保留
    expect(p(3).error).toEqual({ code: "ABORTED" });
    // 结构字段原样保留
    expect(p(6).changed_interfaces).toEqual([{ file: "src/sms.ts", symbol: "sendSmsCode" }]);
    expect(p(9).requested_scope).toEqual(["src/form/**"]);
    expect(p(7).reason).toBe("high_risk_rejected");

    const t = pkg.tickets[0]!;
    expect(isDigest(t.ticket_text)).toBe(true);
    expect((t.ticket_text as TextDigest).len).toBe([...RAW.ticketText].length);
    expect(isDigest(t.decomposition_summary)).toBe(true);
    expect(t.rounds[0]!.fail_reasons).toHaveLength(2);
    expect(t.rounds[0]!.fail_reasons.every(isDigest)).toBe(true);
    expect(isDigest(t.rounds[1]!.review_comments)).toBe(true);
    expect(t.rounds[0]!.diff_file).toBe("raw/T-1/r1.diff");
    expect(t.permission_list).toEqual([{ glob: "src/**", level: "rw" }]);
    // diff 和上下文片段是代码，照常进包
    expect(pkg.raw_files.find((f) => f.path === "raw/T-1/r2.diff")?.content).toContain(
      "const a = 2;",
    );
    expect(pkg.manifest.text_digest).toBe(TEXT_DIGEST_NOTE);
  });

  it("同一包内同文同 hmac（跨事件和单子字段），不同文不同 hmac", async () => {
    const pkg = await readPackage(await exportOne("a"));
    const ok1 = pkg.events[2]!.payload.output as TextDigest; // 「可以」作为模型输出
    const ok2 = pkg.events[5]!.payload.content as TextDigest; // 「可以」作为群消息
    const ok3 = pkg.tickets[0]!.rounds[0]!.fail_reasons[1] as TextDigest; // 「可以」作为评审原因
    expect(ok1).toEqual({ len: 2, hmac: ok2.hmac });
    expect(ok3.hmac).toBe(ok1.hmac);
    // 两次调用的模型回复相同
    expect((pkg.events[0]!.payload.output as TextDigest).hmac).toBe(
      (pkg.events[1]!.payload.output as TextDigest).hmac,
    );
    const def = pkg.events[2]!.payload.prompt as TextDigest; // 「按默认来」
    expect(def.len).toBe(4);
    expect(def.hmac).not.toBe(ok1.hmac);
  });

  it("同一段原文在两个包里 hmac 不同（每包随机 salt）", async () => {
    const a = await readPackage(await exportOne("a"));
    const b = await readPackage(await exportOne("b"));
    const ha = (a.events[5]!.payload.content as TextDigest).hmac;
    const hb = (b.events[5]!.payload.content as TextDigest).hmac;
    expect(ha).not.toBe(hb);
    expect((a.tickets[0]!.ticket_text as TextDigest).hmac).not.toBe(
      (b.tickets[0]!.ticket_text as TextDigest).hmac,
    );
  });

  it("salt 不进包：hex / base64 / base64url / 原始字节都搜不到", async () => {
    const zip_path = await exportOne("a");
    expect(salts.filter((s) => s.length === 32)).toHaveLength(1);
    const salt = salts.find((s) => s.length === 32)!;
    const bytes = await readFile(zip_path);
    const entries = readZip(bytes);
    const all = await allText(zip_path);
    for (const form of [
      salt.toString("hex"),
      salt.toString("hex").toUpperCase(),
      salt.toString("base64"),
      salt.toString("base64url"),
    ]) {
      for (const s of all) expect(s).not.toContain(form);
    }
    for (const blob of [bytes, ...entries.map((e) => e.data)]) {
      expect(blob.includes(salt)).toBe(false);
    }
    // manifest 说明了摘要方式，但没有 salt 字段
    const manifest = JSON.parse(
      entries.find((e) => e.name === "manifest.json")!.data.toString("utf8"),
    );
    expect(manifest.text_digest).toContain("HMAC-SHA256");
    expect(JSON.stringify(manifest)).not.toMatch(/"salt"/);
  });

  it("toSweBenchJsonl：problem_statement 为空串（题面须来自用户本地日志），patch 照常", async () => {
    const pkg = await readPackage(await exportOne("a"));
    const rows = toSweBenchJsonl(pkg)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].problem_statement).toBe("");
    expect(rows[0].patch).toContain("const a = 2;");
    expect(rows[0].FAIL_TO_PASS).toBe(JSON.stringify(["login.test"]));
  });

  it("仍能读 v1.1 旧包：文本字段是字符串，原样读回", async () => {
    const manifest = {
      schema: "bakacoding-diag/v1.1",
      project_id: PROJECT,
      scope: { kind: "ticket", ticket_id: "T-1" },
      include_full_repo: false,
      created_at: "2026-10-01T00:00:00.000Z",
      redaction: "full",
      excluded_env_files: 0,
      excluded_context_env_files: 0,
      files: [
        "manifest.json",
        "events.jsonl",
        "tickets.jsonl",
        "costs.jsonl",
        "redaction_report.json",
      ],
      stats: {
        tickets: 1,
        outcomes: {},
        rounds: 0,
        first_round_pass: 0,
        review_pass_rejected_by_user: 0,
      },
    };
    const oldEvent = { ...makeEvents()[4]! };
    const oldTicket = {
      ticket_id: "T-1",
      requirement_id: "R-1",
      created_at: "2026-10-01T00:00:00.000Z",
      ticket_text: "旧包里的需求原文",
      base_commit: SHA,
      permission_list: [],
      rounds: [],
      resubmit_count: 0,
      context_files: [],
      cost: { ticket_id: "T-1", total_micro_usd: 0, resubmit_micro_usd: 0, entries: 0 },
    };
    const zip = writeZip(
      [
        { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) },
        { name: "events.jsonl", data: Buffer.from(`${JSON.stringify(oldEvent)}\n`) },
        { name: "tickets.jsonl", data: Buffer.from(`${JSON.stringify(oldTicket)}\n`) },
        { name: "costs.jsonl", data: Buffer.from("") },
        { name: "redaction_report.json", data: Buffer.from("{}") },
      ],
      new Date("2026-10-01T00:00:00Z"),
    );
    const p = join(dir, "old-v11.zip");
    await (await import("node:fs/promises")).writeFile(p, zip);
    const back = await readPackage(p);
    expect(back.manifest.schema).toBe("bakacoding-diag/v1.1");
    expect(back.manifest.text_digest).toBeUndefined();
    expect(back.events[0]!.payload.content).toBe(RAW.dispatch);
    expect(back.tickets[0]!.ticket_text).toBe("旧包里的需求原文");
  });
});
