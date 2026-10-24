// T-092：主管 1:1 对话落库（chatLog）与 history()，对真实的 2（openStorage，SQLite）跑。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage, StorageError, type Storage } from "@bakacoding/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createSupervisor, type SupervisorDeps } from "./index.js";

let dirs: string[] = [];
let opened: Storage[] = [];
afterEach(() => {
  for (const s of opened) {
    try {
      s.close();
    } catch {
      // 已关
    }
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  opened = [];
});

function openTmp(): Storage {
  const d = mkdtempSync(join(tmpdir(), "bc-t092-"));
  dirs.push(d);
  const s = openStorage({ path: join(d, "bakacoding.db"), logger: { warn: () => {} } });
  opened.push(s);
  return s;
}

const answer = (reply: string) => JSON.stringify({ intent: "answer", reply, decision: null });

function setup(
  opts: { chatLog?: boolean; chatLogImpl?: SupervisorDeps["chatLog"]; now?: () => number } = {},
) {
  const storage = openTmp();
  const outputs: (string | Error)[] = [];
  const warns: string[] = [];
  let id = 0;
  const now = opts.now ?? (() => 1_760_000_000_000);
  const deps: SupervisorDeps = {
    call: async () => {
      const o = outputs.shift();
      if (o === undefined) throw new Error("没有更多桩输出");
      if (o instanceof Error) throw o;
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
    storage,
    ...(opts.chatLog === false ? {} : { chatLog: opts.chatLogImpl ?? storage }),
    enqueue: () => {},
    publish: () => {},
    subscribe: () => () => {},
    targetHead: () => "abc1234",
    notifyUser: () => {},
    newId: () => `id${++id}`,
    clock: () => new Date(now()),
    logger: { warn: (m: string) => void warns.push(m) },
  };
  return { storage, outputs, warns, sup: createSupervisor(deps) };
}

describe("T-092 主管对话落库", () => {
  it("先存用户消息、再存主管回复，history 按时间正序", async () => {
    const t = setup();
    t.outputs.push(answer("你好呀"));
    const r = await t.sup.chat({ text: "你好", project_id: "p1" });
    expect(r).toEqual({ message_id: expect.any(String), kind: "answer", text: "你好呀" });
    const h = t.sup.history();
    expect(h.map((m) => [m.role, m.kind, m.content, m.project_id])).toEqual([
      ["user", null, "你好", "p1"],
      ["supervisor", "answer", "你好呀", "p1"],
    ]);
    // 同一毫秒：靠 message_id 排出先后
    expect(h[0]!.created_at).toBe(h[1]!.created_at);
    expect(h[0]!.message_id < h[1]!.message_id).toBe(true);
  });

  it("模型失败只留用户那条；带同一 message_id 重试不重复，回复排在后面", async () => {
    const t = setup();
    t.outputs.push(new Error("网络断了"));
    await expect(t.sup.chat({ text: "在吗", message_id: "u-1" })).rejects.toThrow("网络断了");
    expect(t.sup.history().map((m) => [m.message_id, m.role])).toEqual([["u-1", "user"]]);
    t.outputs.push(answer("在"));
    await t.sup.chat({ text: "在吗", message_id: "u-1" });
    const h = t.sup.history();
    expect(h.map((m) => [m.role, m.content])).toEqual([
      ["user", "在吗"],
      ["supervisor", "在"],
    ]);
    expect(h[0]!.message_id).toBe("u-1");
  });

  it("没带 message_id 时模型失败也只留用户那条", async () => {
    const t = setup();
    t.outputs.push(new Error("限流"));
    await expect(t.sup.chat({ text: "hi" })).rejects.toThrow("限流");
    expect(t.sup.history().map((m) => m.role)).toEqual(["user"]);
  });

  it("同一毫秒连发多条：10 生成的 message_id 严格递增，时钟回拨也不倒退", async () => {
    let ms = 1_760_000_000_500;
    const t = setup({ now: () => ms });
    for (let i = 0; i < 3; i++) {
      t.outputs.push(answer(`r${i}`));
      await t.sup.chat({ text: `q${i}` });
    }
    ms -= 100; // 回拨
    t.outputs.push(answer("r3"));
    await t.sup.chat({ text: "q3" });
    const all = t.storage.listSupervisorMessages({ limit: 200 });
    const ids = all.map((m) => m.message_id);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(8);
    // 按 created_at、message_id 排序后的内容顺序仍是一问一答
    expect(all.map((m) => m.content)).toEqual(["q0", "r0", "q1", "r1", "q2", "r2", "q3", "r3"]);
    expect(all.map((m) => m.created_at).every((x, i, a) => i === 0 || x >= a[i - 1]!)).toBe(true);
  });

  it("history 的 before 分页：取游标之前最近的 limit 条，仍升序；未知游标抛 invalid_cursor", async () => {
    let ms = 1_760_000_000_000;
    const t = setup({ now: () => (ms += 10) });
    for (let i = 0; i < 3; i++) {
      t.outputs.push(answer(`r${i}`));
      await t.sup.chat({ text: `q${i}` });
    }
    const all = t.sup.history();
    expect(all.map((m) => m.content)).toEqual(["q0", "r0", "q1", "r1", "q2", "r2"]);
    const page = t.sup.history({ before: all[4]!.message_id, limit: 2 });
    expect(page.map((m) => m.content)).toEqual(["q1", "r1"]);
    expect(t.sup.history({ limit: 2 }).map((m) => m.content)).toEqual(["q2", "r2"]);
    let code: string | undefined;
    try {
      t.sup.history({ before: "nope" });
    } catch (e) {
      if (e instanceof StorageError) code = e.code;
    }
    expect(code).toBe("invalid_cursor");
  });

  it("没注入 chatLog：chat 照常，history 返回空数组", async () => {
    const t = setup({ chatLog: false });
    t.outputs.push(answer("好"));
    expect(await t.sup.chat({ text: "嗯" })).toEqual({
      message_id: expect.any(String),
      kind: "answer",
      text: "好",
    });
    expect(t.sup.history()).toEqual([]);
    expect(t.storage.listSupervisorMessages()).toEqual([]);
  });
});

describe("T-144 主管对话落库跟进", () => {
  it("chatLog.append 抛错：chat 照常返回，并记 warn", async () => {
    const t = setup({
      chatLogImpl: {
        appendSupervisorMessage: () => {
          throw new Error("磁盘满了");
        },
        listSupervisorMessages: () => [],
      },
    });
    t.outputs.push(answer("照常回复"));
    const r = await t.sup.chat({ text: "你好" });
    expect(r).toEqual({ message_id: expect.any(String), kind: "answer", text: "照常回复" });
    expect(t.warns.filter((m) => m.includes("主管对话落库失败"))).toHaveLength(2);
  });

  it("上次回复已存、调用方带同一 message_id 重试：历史里只有一条用户消息和一条回复", async () => {
    const t = setup();
    t.outputs.push(answer("第一次"), answer("第二次"));
    await t.sup.chat({ text: "你好", message_id: "u-1" });
    await t.sup.chat({ text: "你好", message_id: "u-1" });
    const h = t.sup.history();
    expect(h.map((m) => [m.message_id, m.role, m.content])).toEqual([
      ["u-1", "user", "你好"],
      ["u-1-r", "supervisor", "第一次"],
    ]);
  });

  it("10 生成用户 id 时回复 id 为 <用户 id>-r，同毫秒也排在用户消息之后", async () => {
    const t = setup();
    t.outputs.push(answer("好"));
    await t.sup.chat({ text: "嗨" });
    const h = t.sup.history();
    expect(h).toHaveLength(2);
    expect(h[1]!.message_id).toBe(`${h[0]!.message_id}-r`);
    expect(h[0]!.created_at).toBe(h[1]!.created_at);
    expect(h.map((m) => m.role)).toEqual(["user", "supervisor"]);
  });
});

describe("T-148 ChatReply 带回复自己的 message_id", () => {
  it("返回的 message_id 与历史里这条回复的 id 相同（10 生成 id 时）", async () => {
    const t = setup();
    t.outputs.push(answer("好"));
    const r = await t.sup.chat({ text: "嗨" });
    const h = t.sup.history();
    expect(h.map((m) => m.role)).toEqual(["user", "supervisor"]);
    expect(r.message_id).toBe(h[1]!.message_id);
    expect(r.message_id).not.toBe(h[0]!.message_id);
  });

  it("幂等重试命中：同一用户 message_id 两次返回同一个回复 id，且与历史一致", async () => {
    const t = setup();
    t.outputs.push(answer("第一次"), answer("第二次"));
    const a = await t.sup.chat({ text: "你好", message_id: "u-1" });
    const b = await t.sup.chat({ text: "你好", message_id: "u-1" });
    expect(b.message_id).toBe(a.message_id);
    const h = t.sup.history();
    expect(h.filter((m) => m.role === "supervisor").map((m) => m.message_id)).toEqual([
      a.message_id,
    ]);
  });
});
