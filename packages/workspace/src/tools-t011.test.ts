// T-011：三级权限登记与 applyPermissions、越界写申请、.env.example 只读、grep 回溯防护、工具定义深冻结。
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionList } from "@bakacoding/types";
import {
  FILE_TOOL_DEFINITIONS,
  GREP_LIMIT,
  GREP_PATTERN_MAX_LENGTH,
  createTools,
  type ToolResult,
} from "./tools.js";
import { isProtectedPath } from "./guard.js";
import {
  PermissionRegistry,
  applyPermissions,
  defaultPermissionRegistry,
  requestWriteScope,
  type ScopeBus,
} from "./permissions.js";

let base: string;
let ws: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "bc-t011-")));
  ws = join(base, "ws");
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "src", "a.ts"), "const a = 1;\n");
  writeFileSync(join(ws, "docs.md"), "doc\n");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function err(r: ToolResult): { code: string; message: string } {
  if (r.ok) throw new Error(`expected failure, got: ${r.output}`);
  return { code: r.code, message: r.message };
}
function ok(r: ToolResult): string {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.output;
}

/** 内存总线：记录发布的申请；reply 决定如何批复（不批复即模拟没人回）。 */
function fakeBus(
  reply?: (req: { request_id: string; requested_scope: string[] }) => {
    granted?: string[];
    denied?: string;
  },
): ScopeBus & {
  requests: Array<{ request_id: string; requested_scope: string[]; reason: string }>;
} {
  const handlers: Record<string, Array<(e: unknown) => void>> = {};
  const requests: Array<{ request_id: string; requested_scope: string[]; reason: string }> = [];
  const emit = (type: string, ticket_id: string, payload: object): void => {
    for (const h of handlers[type] ?? []) h({ type, ticket_id, payload });
  };
  return {
    requests,
    async publish(input) {
      requests.push(input.payload);
      const r = reply?.(input.payload);
      if (r?.granted)
        emit("write_scope_granted", input.ticket_id, {
          request_id: input.payload.request_id,
          granted_scope: r.granted,
        });
      else if (r?.denied !== undefined)
        emit("write_scope_denied", input.ticket_id, {
          request_id: input.payload.request_id,
          requested_scope: input.payload.requested_scope,
          reason: r.denied,
        });
      return undefined;
    },
    subscribe(type: string, h: (e: never) => void) {
      (handlers[type] ??= []).push(h as (e: unknown) => void);
      return () => {
        handlers[type] = (handlers[type] ?? []).filter((x) => x !== h);
      };
    },
  } as ScopeBus & { requests: typeof requests };
}
const ctx = { requirement_id: "R-1", trace: { trace_id: "tr", span_id: "sp" } };

describe("权限登记与 applyPermissions", () => {
  it("applyPermissions 整份替换后，已建好的工具立刻按新清单判定", async () => {
    const t = createTools({
      ticket_id: "T-reg",
      worktree_path: ws,
      permission_list: [{ glob: "src/**", level: "ro" }],
    });
    expect(err(await t.write({ file_path: "src/b.ts", content: "x" })).code).toBe(
      "FS_PERMISSION_DENIED",
    );
    applyPermissions("T-reg", [{ glob: "src/**", level: "rw" }]);
    ok(await t.write({ file_path: "src/b.ts", content: "x" }));
    applyPermissions("T-reg", []);
    expect(err(await t.read({ file_path: "src/a.ts" })).code).toBe("FS_PERMISSION_DENIED");
    defaultPermissionRegistry.release("T-reg");
  });

  it("清单格式不对抛错；存的是冻结副本，调用方改原数组不影响", () => {
    const reg = new PermissionRegistry();
    expect(() =>
      reg.applyPermissions("T-1", [{ glob: "**", level: "write" }] as unknown as PermissionList),
    ).toThrow();
    expect(() => reg.applyPermissions("", [])).toThrow(TypeError);
    const list: PermissionList = [{ glob: "src/**", level: "ro" }];
    const stored = reg.applyPermissions("T-1", list);
    list[0]!.level = "rw";
    expect(reg.get("T-1")).toEqual([{ glob: "src/**", level: "ro" }]);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(reg.grant("T-1", ["docs/**"])).toEqual([
      { glob: "src/**", level: "ro" },
      { glob: "docs/**", level: "rw" },
    ]);
    reg.release("T-1");
    expect(reg.get("T-1")).toBeUndefined();
  });

  it("不同 registry 互不影响", async () => {
    const reg = new PermissionRegistry();
    const t = createTools({
      ticket_id: "T-iso",
      worktree_path: ws,
      permission_list: [{ glob: "**", level: "ro" }],
      registry: reg,
    });
    applyPermissions("T-iso", []);
    ok(await t.read({ file_path: "src/a.ts" }));
    defaultPermissionRegistry.release("T-iso");
  });
});

describe("越界写申请", () => {
  const list: PermissionList = [{ glob: "src/**", level: "rw" }];

  it("批准后追加范围并完成写入；事件带 ticket、requirement 和父 span", async () => {
    const reg = new PermissionRegistry();
    const bus = fakeBus(() => ({ granted: ["docs/**"] }));
    const published: unknown[] = [];
    const spy: ScopeBus = {
      publish: async (i) => {
        published.push(i);
        return bus.publish(i);
      },
      subscribe: bus.subscribe.bind(bus) as ScopeBus["subscribe"],
    };
    const t = createTools({
      ticket_id: "T-2",
      worktree_path: ws,
      permission_list: list,
      registry: reg,
      scope_requests: {
        bus: spy,
        ctx,
        newId: (() => {
          let i = 0;
          return () => `id-${++i}`;
        })(),
      },
    });
    ok(await t.write({ file_path: "docs/new.md", content: "hi\n" }));
    expect(readFileSync(join(ws, "docs/new.md"), "utf8")).toBe("hi\n");
    expect(published).toEqual([
      {
        type: "write_scope_requested",
        trace_id: "tr",
        span_id: "id-2",
        parent_span_id: "sp",
        requirement_id: "R-1",
        ticket_id: "T-2",
        payload: {
          request_id: "id-1",
          requested_scope: ["docs/new.md"],
          reason: 'write "docs/new.md" is outside the current write scope',
        },
      },
    ]);
    expect(reg.get("T-2")).toEqual([...list, { glob: "docs/**", level: "rw" }]);
    // 批准的范围之后直接生效，不再申请
    ok(await t.write({ file_path: "docs/other.md", content: "x" }));
    expect(bus.requests).toHaveLength(1);
  });

  it("拒绝：返回 FS_PERMISSION_DENIED 带原因，文件不写", async () => {
    const t = createTools({
      ticket_id: "T-3",
      worktree_path: ws,
      permission_list: list,
      registry: new PermissionRegistry(),
      scope_requests: { bus: fakeBus(() => ({ denied: "主管不同意" })), ctx },
    });
    const e = err(await t.write({ file_path: "docs/new.md", content: "x" }));
    expect(e.code).toBe("FS_PERMISSION_DENIED");
    expect(e.message).toContain("主管不同意");
    expect(() => readFileSync(join(ws, "docs/new.md"))).toThrow();
  });

  it("批准的范围没覆盖目标：仍然拒绝", async () => {
    const t = createTools({
      ticket_id: "T-3b",
      worktree_path: ws,
      permission_list: list,
      registry: new PermissionRegistry(),
      scope_requests: { bus: fakeBus(() => ({ granted: ["lib/**"] })), ctx },
    });
    expect(err(await t.write({ file_path: "docs/new.md", content: "x" })).code).toBe(
      "FS_PERMISSION_DENIED",
    );
  });

  it("超时按拒绝；edit 同样走申请", async () => {
    const t = createTools({
      ticket_id: "T-4",
      worktree_path: ws,
      permission_list: [
        { glob: "**", level: "ro" },
        { glob: "src/**", level: "rw" },
      ],
      registry: new PermissionRegistry(),
      scope_requests: { bus: fakeBus(), ctx, timeout_ms: 20 },
    });
    ok(await t.read({ file_path: "docs.md" }));
    const e = err(await t.edit({ file_path: "docs.md", old_string: "doc", new_string: "x" }));
    expect(e.code).toBe("FS_PERMISSION_DENIED");
    expect(e.message).toContain("no reply within 20 ms");
    expect(readFileSync(join(ws, "docs.md"), "utf8")).toBe("doc\n");
  });

  it("受保护路径和工作区外路径从不申请", async () => {
    const bus = fakeBus(() => ({ granted: ["**"] }));
    const t = createTools({
      ticket_id: "T-5",
      worktree_path: ws,
      permission_list: list,
      registry: new PermissionRegistry(),
      scope_requests: { bus, ctx },
    });
    expect(err(await t.write({ file_path: ".env", content: "x" })).code).toBe("FS_PROTECTED_PATH");
    expect(err(await t.write({ file_path: "../out.txt", content: "x" })).code).not.toBe(
      "FS_PERMISSION_DENIED",
    );
    expect(bus.requests).toHaveLength(0);
  });

  it("requestWriteScope 只认同单同 request_id 的批复", async () => {
    let fire: ((e: unknown) => void) | undefined;
    const bus: ScopeBus = {
      publish: async () => {
        fire?.({ ticket_id: "T-other", payload: { request_id: "rq", granted_scope: ["**"] } });
        fire?.({ ticket_id: "T-6", payload: { request_id: "nope", granted_scope: ["**"] } });
        return undefined;
      },
      subscribe: ((type: string, h: (e: unknown) => void) => {
        if (type === "write_scope_granted") fire = h;
        return () => {};
      }) as ScopeBus["subscribe"],
    };
    const d = await requestWriteScope(
      { bus, ctx, timeout_ms: 20, newId: () => "rq" },
      "T-6",
      ["x"],
      "r",
    );
    expect(d).toEqual({ granted: false, reason: "no reply within 20 ms" });
  });
});

describe(".env.example 只读放行", () => {
  beforeEach(() => {
    writeFileSync(join(ws, ".env.example"), "API_KEY=\n");
    writeFileSync(join(ws, ".env"), "API_KEY=real\n");
  });
  const t = () =>
    createTools({
      ticket_id: "T-env",
      worktree_path: ws,
      permission_list: [{ glob: "**", level: "rw" }],
      registry: new PermissionRegistry(),
    });

  it("可读、可 glob、可 grep；.env 仍不可见", async () => {
    expect(ok(await t().read({ file_path: ".env.example" }))).toContain("API_KEY=");
    expect(ok(await t().glob({ pattern: ".env*" }))).toBe(".env.example");
    expect(ok(await t().grep({ pattern: "API_KEY" }))).toBe(".env.example\n  1: API_KEY=");
    expect(err(await t().read({ file_path: ".env" })).code).toBe("FS_PROTECTED_PATH");
  });

  it("不可写、不可改", async () => {
    const tt = t();
    expect(err(await tt.write({ file_path: ".env.example", content: "x" })).code).toBe(
      "FS_PROTECTED_PATH",
    );
    ok(await tt.read({ file_path: ".env.example" }));
    expect(
      err(await tt.edit({ file_path: ".env.example", old_string: "API", new_string: "X" })).code,
    ).toBe("FS_PROTECTED_PATH");
    expect(readFileSync(join(ws, ".env.example"), "utf8")).toBe("API_KEY=\n");
  });

  it("权限清单拒绝时照样不可读；名为 .env.example 的目录整个受保护", async () => {
    const denied = createTools({
      ticket_id: "T-env2",
      worktree_path: ws,
      permission_list: [{ glob: "src/**", level: "ro" }],
      registry: new PermissionRegistry(),
    });
    expect(err(await denied.read({ file_path: ".env.example" })).code).toBe("FS_PERMISSION_DENIED");
    mkdirSync(join(ws, "x", ".env.example"), { recursive: true });
    writeFileSync(join(ws, "x", ".env.example", "f.txt"), "API_KEY=1\n");
    expect(err(await t().read({ file_path: "x/.env.example/f.txt" })).code).toBe(
      "FS_PROTECTED_PATH",
    );
    expect(ok(await t().grep({ pattern: "API_KEY" }))).toBe(".env.example\n  1: API_KEY=");
  });

  it("isProtectedPath 按访问方式区分", () => {
    expect(isProtectedPath(".env.example")).toBe(true);
    expect(isProtectedPath(".env.example", "ro")).toBe(false);
    expect(isProtectedPath("a/.ENV.EXAMPLE", "ro")).toBe(false);
    expect(isProtectedPath(".env", "ro")).toBe(true);
    expect(isProtectedPath(".env.local", "ro")).toBe(true);
    expect(isProtectedPath(".env.example/x", "ro")).toBe(true);
  });
});

describe("grep 正则回溯防护", () => {
  const t = (grep_timeout_ms?: number) =>
    createTools({
      ticket_id: "T-grep",
      worktree_path: ws,
      permission_list: [{ glob: "**", level: "ro" }],
      registry: new PermissionRegistry(),
      ...(grep_timeout_ms === undefined ? {} : { grep_timeout_ms }),
    });

  it("正则超长返回 FS_INVALID_INPUT", async () => {
    const e = err(await t().grep({ pattern: "a".repeat(GREP_PATTERN_MAX_LENGTH + 1) }));
    expect(e.code).toBe("FS_INVALID_INPUT");
    ok(await t().grep({ pattern: "a".repeat(GREP_PATTERN_MAX_LENGTH) }));
  });

  it("灾难性回溯在时限内被终止，返回 FS_GREP_TIMEOUT，进程不卡", async () => {
    writeFileSync(join(ws, "src", "evil.txt"), "a".repeat(40) + "!\n");
    const started = Date.now();
    const e = err(await t(300).grep({ pattern: "^(a+)+$" }));
    expect(e.code).toBe("FS_GREP_TIMEOUT");
    expect(Date.now() - started).toBeLessThan(5000);
    // 超时后同一套工具还能正常 grep
    expect(ok(await t(5000).grep({ pattern: "const a" }))).toBe("src/a.ts\n  1: const a = 1;");
  });

  it("匹配条数上限照旧（worker 只多取一条判断是否还有更多）", async () => {
    writeFileSync(join(ws, "src", "many.txt"), "hit\n".repeat(300));
    const out = ok(await t().grep({ pattern: "hit", path: "src/many.txt" }));
    expect(out.split("\n").filter((l) => l.startsWith("  ")).length).toBe(GREP_LIMIT);
  });
});

describe("工具定义深冻结", () => {
  it("每一层都冻结，序列化字节和 T-011 之前一致", () => {
    const check = (v: unknown): void => {
      if (v !== null && typeof v === "object") {
        expect(Object.isFrozen(v)).toBe(true);
        for (const x of Object.values(v)) check(x);
      }
    };
    check(FILE_TOOL_DEFINITIONS);
    const props = (FILE_TOOL_DEFINITIONS[0]!.input_schema as { properties: Record<string, object> })
      .properties;
    expect(() => {
      (props as Record<string, unknown>).extra = {};
    }).toThrow(TypeError);
    expect(createHash("sha256").update(JSON.stringify(FILE_TOOL_DEFINITIONS)).digest("hex")).toBe(
      "71288b7c3dd41bb9e260da90edae8c050f5f4663d3a11c38982ba80605b1db3e",
    );
  });
});
