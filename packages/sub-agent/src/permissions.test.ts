import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStorage, type Storage } from "@bakacoding/storage";
import { permissionFor } from "@bakacoding/workspace";
import {
  appendGrantedScope,
  generatePermissionList,
  globWithinScope,
  memoryTicketPermissions,
  storageTicketPermissions,
  type SubAgentTicket,
} from "./index.js";

const TICKET: SubAgentTicket = {
  ticket_id: "T-1",
  project_id: "P-1",
  requirement_id: "R-1",
  trace_id: "tr",
  span_id: "sp",
  parent_span_id: null,
  ticket_text: "改 src/a",
  base_commit: "c".repeat(40),
  permission_list: [],
};

describe("globWithinScope（写入范围包含判断，T-048）", () => {
  it("字面量路径按模块 4 的匹配规则；通配 glob 按段保守判断", () => {
    const yes: Array<[string, string[]]> = [
      ["src/a.ts", ["src/**"]],
      ["src/a.ts", ["src/*.ts"]],
      ["src/a/**", ["src/**"]],
      ["src/a/*.ts", ["src/**"]],
      ["src/*.ts", ["src/*"]],
      ["src/**/*.ts", ["src/**"]],
      ["src/a/b.ts", ["lib/**", "src/a/**"]],
      ["anything/**", ["**"]],
      ["./src/a.ts", ["src/**"]],
      ["src/a.ts", ["src/{a,b}.ts"]],
    ];
    const no: Array<[string, string[]]> = [
      ["src/**", ["src/a/**"]],
      ["**", ["src/**"]],
      ["src/*.ts", ["src/a.ts"]],
      ["src/*", ["src/*.ts"]],
      ["lib/a.ts", ["src/**"]],
      ["src/**/*.ts", ["src/*/*.ts"]],
      ["src/{a,b}.ts", ["src/a.ts"]],
      ["src/a.ts", []],
    ];
    for (const [g, s] of yes) expect(globWithinScope(g, s), `${g} ⊆ ${s.join(",")}`).toBe(true);
    for (const [g, s] of no) expect(globWithinScope(g, s), `${g} ⊆ ${s.join(",")}`).toBe(false);
  });
});

describe("generatePermissionList（T-048）", () => {
  it("没带建议：全仓只读 + 写入范围读写；其他路径按默认拒绝之外的 ro 读", () => {
    const { permission_list, cut } = generatePermissionList({
      permission_list: [],
      write_scope: ["src/a/**", "docs/a.md"],
    });
    expect(permission_list).toEqual([
      { glob: "**", level: "ro" },
      { glob: "src/a/**", level: "rw" },
      { glob: "docs/a.md", level: "rw" },
    ]);
    expect(cut).toEqual([]);
    expect(permissionFor(permission_list, "src/a/x.ts")).toBe("rw");
    expect(permissionFor(permission_list, "src/b/x.ts")).toBe("ro");
  });

  it("带建议：超出写入范围的 rw 降为 ro 并报给调用方；ro / deny 原样，顺序不变", () => {
    const { permission_list, cut } = generatePermissionList({
      permission_list: [
        { glob: "**", level: "ro" },
        { glob: "src/**", level: "rw" },
        { glob: "src/a/**", level: "rw" },
        { glob: "src/a/secret.ts", level: "deny" },
        { glob: "package.json", level: "rw" },
      ],
      write_scope: ["src/a/**"],
    });
    expect(permission_list).toEqual([
      { glob: "**", level: "ro" },
      { glob: "src/**", level: "ro" },
      { glob: "src/a/**", level: "rw" },
      { glob: "src/a/secret.ts", level: "deny" },
      { glob: "package.json", level: "ro" },
    ]);
    expect(cut.map((c) => c.entry.glob)).toEqual(["src/**", "package.json"]);
    expect(cut.every((c) => c.reason === "outside_write_scope")).toBe(true);
    // 用模块 4 的规则检查：写入范围外没有一条路径能写
    for (const p of ["src/b.ts", "package.json", "lib/x.ts"])
      expect(permissionFor(permission_list, p)).not.toBe("rw");
    expect(permissionFor(permission_list, "src/a/x.ts")).toBe("rw");
    expect(permissionFor(permission_list, "src/a/secret.ts")).toBe("deny");
  });

  it("没写写入范围按 ** 处理，不裁剪；建议全是 deny 也原样；结果永远非空", () => {
    expect(
      generatePermissionList({ permission_list: [{ glob: "src/**", level: "rw" }] }).cut,
    ).toEqual([]);
    expect(generatePermissionList({ permission_list: [] }).permission_list).toEqual([
      { glob: "**", level: "ro" },
      { glob: "**", level: "rw" },
    ]);
    expect(
      generatePermissionList({
        permission_list: [{ glob: "**", level: "deny" }],
        write_scope: ["a/**"],
      }).permission_list,
    ).toEqual([{ glob: "**", level: "deny" }]);
  });
});

describe("appendGrantedScope（T-048）", () => {
  it("批准的范围以 rw 追加到末尾（后条覆盖前条）；重复写回幂等；被后面 deny 覆盖的会重新追加", () => {
    const base = [
      { glob: "**", level: "ro" as const },
      { glob: "src/a/**", level: "rw" as const },
    ];
    const once = appendGrantedScope(base, ["docs/**", "src/a/**"]);
    expect(once).toEqual([...base, { glob: "docs/**", level: "rw" }]);
    expect(appendGrantedScope(once, ["docs/**"])).toEqual(once);
    expect(permissionFor(once, "docs/x.md")).toBe("rw");
    const denied = [...once, { glob: "docs/**", level: "deny" as const }];
    expect(appendGrantedScope(denied, ["docs/**"]).at(-1)).toEqual({
      glob: "docs/**",
      level: "rw",
    });
    // 不改入参
    expect(base).toHaveLength(2);
  });
});

describe("memoryTicketPermissions", () => {
  it("按 ticket_id 存取，存的是副本", () => {
    const m = memoryTicketPermissions();
    expect(m.get(TICKET)).toBeUndefined();
    const list = [{ glob: "**", level: "ro" as const }];
    m.set(TICKET, list);
    list.push({ glob: "x", level: "rw" });
    expect(m.get(TICKET)).toEqual([{ glob: "**", level: "ro" }]);
  });
});

describe("storageTicketPermissions（真 SQLite，2 的需求单记录）", () => {
  let root: string;
  let storage: Storage;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bc-perm-"));
    storage = openStorage({ path: join(root, "db.sqlite") });
  });
  afterEach(async () => {
    storage.close();
    await rm(root, { recursive: true, force: true });
  });

  it("写回只换 permission_list，其余列原样保留；读出来是解析后的清单", () => {
    storage.saveTicket({
      ticket_id: "T-1",
      project_id: "P-1",
      requirement_id: "R-1",
      created_at: "2026-10-17T08:00:00Z",
      ticket_text: "原文",
      decomposition_summary: "拆单摘要",
      status: "coding",
      base_commit: "b".repeat(40),
      permission_list: [],
      context_snippets: [{ path: "src/a.ts", content: "x" }],
    });
    const store = storageTicketPermissions(storage);
    expect(store.get(TICKET)).toEqual([]);
    store.set(TICKET, [
      { glob: "**", level: "ro" },
      { glob: "src/**", level: "rw" },
    ]);
    const rec = storage.query({ project_id: "P-1", ticket_id: "T-1" })[0]!;
    expect(rec.permission_list).toEqual([
      { glob: "**", level: "ro" },
      { glob: "src/**", level: "rw" },
    ]);
    expect(rec).toMatchObject({
      created_at: "2026-10-17T08:00:00Z",
      ticket_text: "原文",
      decomposition_summary: "拆单摘要",
      status: "coding",
      base_commit: "b".repeat(40),
      context_snippets: [{ path: "src/a.ts", content: "x" }],
    });
    expect(store.get(TICKET)).toEqual(rec.permission_list);
  });

  it("记录不存在：get 返回 undefined；set 按需求单建一条", () => {
    const store = storageTicketPermissions(storage, () => new Date("2026-10-17T09:00:00Z"));
    expect(store.get(TICKET)).toBeUndefined();
    store.set(TICKET, [{ glob: "**", level: "deny" }]);
    const rec = storage.query({ project_id: "P-1", ticket_id: "T-1" })[0]!;
    expect(rec).toMatchObject({
      requirement_id: "R-1",
      created_at: "2026-10-17T09:00:00.000Z",
      ticket_text: "改 src/a",
      base_commit: "c".repeat(40),
      permission_list: [{ glob: "**", level: "deny" }],
      context_snippets: [],
    });
  });

  it("非法清单不写", () => {
    const store = storageTicketPermissions(storage);
    expect(() => store.set(TICKET, [{ glob: "x", level: "write" as never }])).toThrow();
    expect(store.get(TICKET)).toBeUndefined();
  });
});
