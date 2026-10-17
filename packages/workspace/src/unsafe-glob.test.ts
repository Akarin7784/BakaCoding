// T-051：不安全 glob 的统一判定，以及模块 4 在登记清单、越界写申请、收批准时的防护。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTools, type ToolResult } from "./tools.js";
import { isUnsafeGlob } from "./guard.js";
import { PermissionRegistry, type ScopeBus } from "./permissions.js";

// T-048 卡点里列出的写法，加上同类变体
const UNSAFE = [
  "src/../**",
  "src/*/../../a",
  "src/**/../../a",
  "src/{a,../../x}",
  "src/**/..",
  "..",
  "../x",
  "./src/**",
  "src/./a.ts",
  "src//a.ts",
  "src/",
  "/etc/passwd",
  "/**",
  "C:/x",
  "~/x",
  "src\\a.ts",
  "a\0b",
  "!src/**",
  "#x",
  "src/{a/b,c}",
  "src/@(a/b)",
  "src/{.,a}/x",
  "src/+(..)/x",
  "",
];
const SAFE = [
  "**",
  "src/**",
  "src/*.ts",
  "src/{a,b}.ts",
  "**/package.json",
  ".github/**",
  "a.b.ts",
];

describe("isUnsafeGlob", () => {
  it.each(UNSAFE)("不安全：%j", (g) => expect(isUnsafeGlob(g)).toBe(true));
  it.each(SAFE)("安全：%j", (g) => expect(isUnsafeGlob(g)).toBe(false));
});

let base: string;
let ws: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "bc-t051-")));
  ws = join(base, "ws");
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "src", "a.ts"), "a\n");
  writeFileSync(join(ws, "a"), "root\n");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function code(r: ToolResult): string {
  if (r.ok) throw new Error(`expected failure, got: ${r.output}`);
  return r.code;
}
function quietRegistry(): { reg: PermissionRegistry; warns: string[] } {
  const warns: string[] = [];
  return { reg: new PermissionRegistry({ logger: { warn: (m) => warns.push(m) } }), warns };
}

describe("登记清单时丢弃不安全条目", () => {
  it.each(["src/../**", "src/*/../../a", "src/**/../../a", "src/{a,../../x}", "src/**/.."])(
    "%j 不放行 src 外的写，也不放行 src 内的写",
    async (glob) => {
      const { reg, warns } = quietRegistry();
      const t = createTools({
        ticket_id: "T-u",
        worktree_path: ws,
        permission_list: [{ glob, level: "rw" }],
        registry: reg,
      });
      expect(reg.get("T-u")).toEqual([]);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("dropped unsafe permission glob");
      expect(code(await t.write({ file_path: "x.ts", content: "x" }))).toBe("FS_PERMISSION_DENIED");
      expect(code(await t.write({ file_path: "src/n.ts", content: "x" }))).toBe(
        "FS_PERMISSION_DENIED",
      );
      expect(existsSync(join(ws, "x.ts"))).toBe(false);
    },
  );

  it("ro 不安全条目同样丢弃；deny 条目保留；安全条目照常生效", () => {
    const { reg } = quietRegistry();
    expect(
      reg.applyPermissions("T-m", [
        { glob: "src/**", level: "rw" },
        { glob: "src/../**", level: "ro" },
        { glob: "src/../secret/**", level: "deny" },
      ]),
    ).toEqual([
      { glob: "src/**", level: "rw" },
      { glob: "src/../secret/**", level: "deny" },
    ]);
  });
});

describe("越界写申请", () => {
  const ctx = { requirement_id: "R-1", trace: { trace_id: "tr", span_id: "sp" } };
  function bus(granted: string[]): ScopeBus & { published: number } {
    let onGranted: ((e: unknown) => void) | undefined;
    const b = {
      published: 0,
      async publish(input: { ticket_id: string; payload: { request_id: string } }) {
        b.published++;
        onGranted?.({
          ticket_id: input.ticket_id,
          payload: { request_id: input.payload.request_id, granted_scope: granted },
        });
        return undefined;
      },
      subscribe(type: string, h: (e: unknown) => void) {
        if (type === "write_scope_granted") onGranted = h;
        return () => {};
      },
    };
    return b as unknown as ScopeBus & { published: number };
  }

  it("批准的范围里不安全的条目不生效，写仍被拒", async () => {
    const { reg, warns } = quietRegistry();
    const b = bus(["src/../**"]);
    const t = createTools({
      ticket_id: "T-g",
      worktree_path: ws,
      permission_list: [{ glob: "src/**", level: "rw" }],
      registry: reg,
      scope_requests: { bus: b, ctx },
    });
    expect(code(await t.write({ file_path: "docs/x.md", content: "x" }))).toBe(
      "FS_PERMISSION_DENIED",
    );
    expect(b.published).toBe(1);
    expect(reg.get("T-g")).toEqual([{ glob: "src/**", level: "rw" }]);
    expect(warns.some((w) => w.includes("src/../**"))).toBe(true);
  });

  it("目标路径本身不能表达成安全范围（文件名带 ..）：直接拒绝，不发申请", async () => {
    const { reg } = quietRegistry();
    const b = bus(["**"]);
    const t = createTools({
      ticket_id: "T-d",
      worktree_path: ws,
      permission_list: [{ glob: "src/**", level: "rw" }],
      registry: reg,
      scope_requests: { bus: b, ctx },
    });
    expect(code(await t.write({ file_path: "a..b.txt", content: "x" }))).toBe(
      "FS_PERMISSION_DENIED",
    );
    expect(b.published).toBe(0);
  });
});
