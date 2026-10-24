// T-142：项目记录删除（removeProject / project_removed）与 v6 迁移（projects.repo_path）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { EventSchema, type BakaEvent } from "@bakacoding/types";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "./schema.sql.js";
import { openStorage, openStorageReadonly, type Storage } from "./index.js";

let dirs: string[] = [];
let opened: { close(): void }[] = [];
afterEach(() => {
  for (const s of opened.reverse()) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  opened = [];
});
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "bc-storage-142-"));
  dirs.push(d);
  return join(d, "bakacoding.db");
}
function openW(path = tmpDb()): Storage {
  const s = openStorage({ path });
  opened.push(s);
  return s;
}
const SECRET_PATH = "/home/eva/secret-repos/demo";
let seq = 0;
function ev(type: "project_created" | "project_removed", payload: object, id?: string): BakaEvent {
  seq += 1;
  return EventSchema.parse({
    type,
    event_id: id ?? `ev-${seq}`,
    seq,
    ts: `2026-10-24T01:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    trace_id: "t",
    span_id: "s",
    parent_span_id: null,
    requirement_id: null,
    ticket_id: null,
    payload,
  });
}
const created = (id: string, extra: object = {}) =>
  ev("project_created", {
    project_id: id,
    name: id,
    language: "typescript",
    has_github_remote: false,
    ...extra,
  });

describe("T-142 removeProject", () => {
  it("删除只删记录：listProjects 不再返回，历史事件保留；未知项目返回 removed:false", () => {
    const s = openW();
    s.ingest(created("P-1"));
    s.ingest(created("P-2"));
    expect(s.removeProject("P-1")).toEqual({ removed: true });
    expect(s.listProjects().map((p) => p.project_id)).toEqual(["P-2"]);
    expect(s.removeProject("P-1")).toEqual({ removed: false });
    expect(s.removeProject("nope")).toEqual({ removed: false });
    const evs = s.queryEvents({ project_id: "P-1" });
    expect(evs.map((e) => e.type)).toEqual(["project_created"]);
  });

  it("删除后再导入同一个仓库（新的 project_created）会重新登记", () => {
    const s = openW();
    s.ingest(created("P-1"));
    s.removeProject("P-1");
    s.ingest(created("P-1")); // 同一事件重投之外的新事件
    expect(s.listProjects().map((p) => p.project_id)).toEqual(["P-1"]);
  });

  it("同一条 project_created 重投不会把删掉的项目带回来", () => {
    const s = openW();
    const e = created("P-1");
    s.ingest(e);
    s.removeProject("P-1");
    s.ingest(e);
    expect(s.listProjects()).toEqual([]);
  });

  it("project_removed 事件落库时删记录，事件本身保留；之后新的 project_created 可重新登记", () => {
    const s = openW();
    s.ingest(created("P-1"));
    s.ingest(ev("project_removed", { project_id: "P-1" }));
    expect(s.listProjects()).toEqual([]);
    expect(s.queryEvents({ project_id: "P-1" }).map((e) => e.type)).toEqual([
      "project_created",
      "project_removed",
    ]);
    s.ingest(created("P-1"));
    expect(s.listProjects().map((p) => p.project_id)).toEqual(["P-1"]);
  });

  it("只读连接的 listProjects 也不返回已删除项目", () => {
    const path = tmpDb();
    const s = openW(path);
    s.ingest(created("P-1"));
    s.ingest(created("P-2"));
    s.removeProject("P-2");
    const ro = openStorageReadonly({ path });
    opened.push(ro);
    expect(ro.listProjects().map((p) => p.project_id)).toEqual(["P-1"]);
  });

  it("project_id 为空或不是字符串抛 TypeError(invalid_project_id)，消息不带值", () => {
    const s = openW();
    for (const bad of ["", 42, null, undefined]) {
      let err: unknown;
      try {
        s.removeProject(bad as never);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(TypeError);
      expect((err as { code?: string }).code).toBe("invalid_project_id");
      expect((err as Error).message).toBe("project_id 须为非空字符串");
    }
  });
});

describe("T-142 repo_path", () => {
  it("事件带 repo_path 时 listProjects 返回它，没带为 null", () => {
    const s = openW();
    s.ingest(created("P-1", { repo_path: SECRET_PATH }));
    s.ingest(created("P-2"));
    const rows = s.listProjects();
    expect(rows.find((r) => r.project_id === "P-1")?.repo_path).toBe(SECRET_PATH);
    expect(rows.find((r) => r.project_id === "P-2")?.repo_path).toBeNull();
  });

  it("报错信息不带路径值或其他传入值", () => {
    const s = openW();
    s.ingest(created("P-1", { repo_path: SECRET_PATH }));
    const msgs: string[] = [];
    for (const bad of [{ path: SECRET_PATH }, [SECRET_PATH], 7]) {
      try {
        s.removeProject(bad as never);
      } catch (e) {
        msgs.push((e as Error).message);
      }
    }
    expect(msgs).toHaveLength(3);
    for (const m of msgs) {
      expect(m).not.toContain(SECRET_PATH);
      expect(m).not.toContain("secret-repos");
      expect(m).not.toContain("7");
    }
    // 空 repo_path 被 schema 拒绝，错误里也不带值
    const r = EventSchema.safeParse({
      ...created("P-9"),
      payload: {
        project_id: "P-9",
        name: "x",
        language: "ts",
        has_github_remote: false,
        repo_path: 1,
      },
    });
    expect(r.success).toBe(false);
  });

  it("v5 旧库升级到 v6：老项目保留、repo_path 为 null，之后可删", () => {
    const path = tmpDb();
    const raw = new Database(path);
    for (const step of MIGRATIONS.slice(0, 5)) {
      if (typeof step === "string") raw.exec(step);
      else step(raw);
    }
    raw.pragma("user_version = 5");
    raw
      .prepare(
        "INSERT INTO projects (project_id, name, language, has_github_remote, created_at) VALUES ('P-old', 'old', 'go', 0, '2026-10-01T00:00:00.000Z')",
      )
      .run();
    raw.close();
    const s = openW(path);
    expect(s.listProjects()).toEqual([
      { project_id: "P-old", name: "old", created_at: "2026-10-01T00:00:00.000Z", repo_path: null },
    ]);
    expect(s.removeProject("P-old")).toEqual({ removed: true });
    s.close();
    opened.pop();
    const check = new Database(path, { readonly: true });
    expect(check.pragma("user_version", { simple: true })).toBe(6);
    const cols = check.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
    check.close();
    expect(cols.map((c) => c.name)).toContain("repo_path");
    expect(MIGRATIONS.length).toBe(6);
  });
});
