// T-158：主管多轮对话带上之前的问答（按项目取、有条数和字数上限、超出写明省略），立项用合并后的需求。
import { describe, expect, it } from "vitest";
import { createSupervisor, type SupervisorDeps } from "./index.js";
import { CHAT_CONTEXT_MAX_CHARS, CHAT_CONTEXT_MAX_MESSAGES } from "./supervisor.js";
import type { SupervisorMessage } from "@bakacoding/storage";

const answer = (reply: string) => JSON.stringify({ intent: "answer", reply, decision: null });
const requirement = (reply: string, req: string | null) =>
  JSON.stringify({ intent: "requirement", reply, decision: null, requirement: req });
const split = (text = "需求单正文") =>
  JSON.stringify({
    summary: "一张",
    tickets: [{ key: "t1", ticket_text: text, write_scope: ["src/**"], interfaces: [] }],
  });

type Proj = { project_id: string; name: string };

function setup(opts: { projects?: Proj[]; chatLog?: SupervisorDeps["chatLog"] } = {}) {
  const outputs: string[] = [];
  const prompts: string[] = [];
  const warns: string[] = [];
  let id = 0;
  let ms = 1_760_000_000_000;
  const projects = opts.projects ?? [{ project_id: "p1", name: "demo" }];
  const deps = {
    call: async (_r: unknown, _p: unknown, _m: unknown, _e: unknown, prompt: string) => {
      prompts.push(prompt);
      const o = outputs.shift();
      if (o === undefined) throw new Error("没有更多桩输出");
      return {
        output: o,
        tokens: { input: 1, output: 1, cache_hit_input: 0 },
        cache_hit: false,
        latency_ms: 1,
        cost: 0,
        rate_limited_retry: 0,
      };
    },
    getConfig: () => ({
      roles: { supervisor: { provider: "deepseek", model: "deepseek-flash", effort: "max" } },
      pipeline: { resplit_limit: 2 },
    }),
    promptTemplate: async () => "桩模板",
    storage: {
      listProjects: () =>
        projects.map((p) => ({ ...p, repo_path: `/r/${p.project_id}`, has_github_remote: false })),
      listDecisions: () => [],
      saveDecision: () => {},
      listTickets: () => [],
      saveTicket: () => {},
      getTicket: () => undefined,
      registerRequirement: () => {},
      listGroupMessages: () => [],
      appendGroupMessage: () => {},
    },
    ...(opts.chatLog ? { chatLog: opts.chatLog } : {}),
    listFiles: async () => ["src/a.ts"],
    enqueue: () => {},
    publish: () => {},
    subscribe: () => () => {},
    targetHead: () => "abc1234",
    notifyUser: () => {},
    newId: () => `id${++id}`,
    clock: () => new Date(ms++),
    logger: { warn: (m: string) => void warns.push(m) },
  } as unknown as SupervisorDeps;
  return { outputs, prompts, warns, sup: createSupervisor(deps) };
}

/** 取提示词里 conversation 区块的正文（没有该区块返回 null） */
function conversation(prompt: string): string | null {
  const m = /<untrusted-[A-Za-z0-9]+ kind="conversation">\n([\s\S]*?)\n<\/untrusted-/.exec(prompt);
  return m ? m[1]! : null;
}

describe("T-158 主管多轮对话上下文", () => {
  it("Eva 的三轮对话：第二、三轮的请求里带着前面的问答；「按默认方案」立项时拆单拿到合并后的需求", async () => {
    const t = setup();
    t.outputs.push(answer("要做后端服务的话，默认方案是 Spring Boot 3 + MySQL，按默认来吗？"));
    await t.sup.chat({ text: "做一个用户管理后端", project_id: "p1" });
    expect(conversation(t.prompts[0]!)).toBeNull();

    t.outputs.push(
      requirement(
        "好的，按默认方案拆单",
        "用户管理后端，Spring Boot 3 + MySQL（用户采纳默认方案）",
      ),
      split(),
    );
    const r2 = await t.sup.chat({ text: "按默认方案", project_id: "p1" });
    expect(r2.kind).toBe("dispatched");
    const c2 = conversation(t.prompts[1]!)!;
    expect(c2).toBe(
      "[用户] 做一个用户管理后端\n[主管] 要做后端服务的话，默认方案是 Spring Boot 3 + MySQL，按默认来吗？",
    );
    // 当前这条只在 user_message 里，不重复进 conversation
    expect(c2).not.toContain("按默认方案");
    // 拆单拿到的是合并后的需求，不是「按默认方案」这几个字
    expect(t.prompts[2]).toContain(
      'kind="requirement">\n用户管理后端，Spring Boot 3 + MySQL（用户采纳默认方案）\n',
    );

    t.outputs.push(answer("要改成 Spring Boot 4 吗？"));
    await t.sup.chat({ text: "spring boot4", project_id: "p1" });
    const c3 = conversation(t.prompts[3]!)!;
    expect(c3).toContain("[用户] 做一个用户管理后端");
    expect(c3).toContain("[用户] 按默认方案");
    expect(c3).toContain("[主管] 已拆成 1 张单");
  });

  it("输出格式说明要求按最近一次追问理解短句", async () => {
    const t = setup();
    t.outputs.push(answer("好"));
    await t.sup.chat({ text: "你好" });
    expect(t.prompts[0]).toContain("按你最近一次的追问和给出的选项来理解");
  });

  it("requirement 字段缺省、为 null、为空串或全是空白：拆单退回用户原文", async () => {
    for (const req of [undefined, null, "", "   \n "]) {
      const t = setup();
      const out =
        req === undefined
          ? JSON.stringify({ intent: "requirement", reply: "好", decision: null })
          : requirement("好", req);
      t.outputs.push(out, split());
      await t.sup.chat({ text: "加个登录页" });
      expect(t.prompts[1], String(req)).toContain('kind="requirement">\n加个登录页\n');
    }
  });

  it("按项目取：别的项目的对话不带；还没定项目时的追问在定了项目后仍能接上", async () => {
    const projects = [
      { project_id: "p1", name: "应用" },
      { project_id: "p2", name: "官网" },
    ];
    const t = setup({ projects });
    t.outputs.push(answer("官网那边的问题"));
    await t.sup.chat({ text: "官网首页改个颜色？", project_id: "p2" });
    // 没定项目时的一问一答
    t.outputs.push(answer("登录用短信还是邮箱？默认邮箱。"));
    await t.sup.chat({ text: "加个登录" });
    // 定了项目再回答
    t.outputs.push(answer("好"));
    await t.sup.chat({ text: "按默认来", project_id: "p1" });
    const c = conversation(t.prompts[2]!)!;
    expect(c).toBe("[用户] 加个登录\n[主管] 登录用短信还是邮箱？默认邮箱。");
    expect(c).not.toContain("官网");
  });

  it(`超过 ${CHAT_CONTEXT_MAX_MESSAGES} 条：截掉最早的，并写明省略了几条`, async () => {
    const t = setup();
    for (let i = 0; i < 12; i++) {
      t.outputs.push(answer(`答${i}`));
      await t.sup.chat({ text: `问${i}` });
    }
    t.outputs.push(answer("好"));
    await t.sup.chat({ text: "最后一条" });
    const c = conversation(t.prompts[12]!)!;
    const lines = c.split("\n");
    expect(lines[0]).toBe("（更早的 4 条对话已省略）");
    expect(lines).toHaveLength(CHAT_CONTEXT_MAX_MESSAGES + 1);
    expect(lines[1]).toBe("[用户] 问2");
    expect(lines.at(-1)).toBe("[主管] 答11");
    expect(c).not.toContain("问1\n");
  });

  it(`超过 ${CHAT_CONTEXT_MAX_CHARS} 字：截掉最早的，写明省略；最新一条超长时只留它的结尾`, async () => {
    const t = setup();
    const big = "长".repeat(CHAT_CONTEXT_MAX_CHARS - 3);
    t.outputs.push(answer("答一"));
    await t.sup.chat({ text: "问一" });
    t.outputs.push(answer("答二"));
    await t.sup.chat({ text: big });
    t.outputs.push(answer("好"));
    await t.sup.chat({ text: "下一条" });
    const c = conversation(t.prompts[2]!)!;
    expect(c.startsWith("（更早的 2 条对话已省略）\n")).toBe(true);
    expect(c).toContain(`[用户] ${big}`);
    expect(c).not.toContain("问一");

    // 最新一条本身就超长（只可能来自对话记录）：只留它的结尾，前面的都省略
    const row = (message_id: string, role: "user" | "supervisor", content: string) =>
      ({
        message_id,
        project_id: null,
        role,
        kind: role === "user" ? null : "answer",
        content,
        requirement_id: null,
        ticket_ids: [],
        created_at: 1,
        in_reply_to: null,
      }) as SupervisorMessage;
    const t2 = setup({
      chatLog: {
        appendSupervisorMessage: () => ({ inserted: true }),
        listSupervisorMessages: () => [
          row("a", "user", "早"),
          row("b", "supervisor", `开头${"长".repeat(CHAT_CONTEXT_MAX_CHARS + 50)}结尾`),
        ],
      },
    });
    t2.outputs.push(answer("好"));
    await t2.sup.chat({ text: "下一条" });
    const c2 = conversation(t2.prompts[0]!)!;
    expect(c2.startsWith("（更早的 1 条对话已省略）\n[主管] …")).toBe(true);
    expect(c2.endsWith("结尾")).toBe(true);
    expect(c2).not.toContain("开头");
    expect(c2.length).toBeLessThan(CHAT_CONTEXT_MAX_CHARS + 40);
  });

  it("注入了 chatLog：从对话记录里取；读失败只记固定文案和错误码，不带历史内容，对话照常", async () => {
    const rows: SupervisorMessage[] = [];
    const ok = setup({
      chatLog: {
        appendSupervisorMessage: (m) => {
          rows.push(m);
          return { inserted: true };
        },
        listSupervisorMessages: () => rows.slice(),
      },
    });
    ok.outputs.push(answer("默认 MySQL，可以吗？"), answer("好"));
    await ok.sup.chat({ text: "做个后端" });
    await ok.sup.chat({ text: "可以" });
    expect(conversation(ok.prompts[1]!)).toBe("[用户] 做个后端\n[主管] 默认 MySQL，可以吗？");

    const bad = setup({
      chatLog: {
        appendSupervisorMessage: () => ({ inserted: true }),
        listSupervisorMessages: () => {
          throw Object.assign(new Error("秘密历史内容 做个后端"), { code: "io_error" });
        },
      },
    });
    bad.outputs.push(answer("好"));
    const r = await bad.sup.chat({ text: "可以" });
    expect(r.kind).toBe("answer");
    expect(conversation(bad.prompts[0]!)).toBeNull();
    expect(bad.warns).toEqual(["读取主管对话历史失败，本轮不带历史（io_error）"]);
  });
});
