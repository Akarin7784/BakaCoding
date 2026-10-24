// UI-07d：设置 › 项目——真后端上的列表 / 移除；project_removed 只带 project_id，诊断包里没有 repo_path。
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStorage, type Storage } from "@bakacoding/storage";
import { afterEach, describe, expect, it } from "vitest";
import { startBackend } from "./backend.js";

const examplePath = fileURLToPath(
  new URL("../../../../config/models.example.json", import.meta.url),
);
const pricingPath = fileURLToPath(new URL("../../../../config/pricing.json", import.meta.url));
const env = { DEEPSEEK_API_KEY: `sk-${"f00dfeed".repeat(4)}` };

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "bc-ui07d-"));
  dirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  writeFileSync(join(root, "README.md"), "x\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@test", "commit", "-qm", "init"], {
    cwd: root,
  });
  mkdirSync(join(root, "config"), { recursive: true });
  copyFileSync(examplePath, join(root, "config", "models.json"));
  copyFileSync(pricingPath, join(root, "config", "pricing.json"));
  return root;
}

async function start(r: string, warns: string[] = []) {
  let st: Storage | undefined;
  const backend = await startBackend({
    argv: [],
    env,
    cwd: r,
    lastRepo: r,
    logger: { warn: (m: string) => void warns.push(m) },
    openStorage: (o) => (st = openStorage(o)),
  });
  expect(backend.status(), JSON.stringify([backend.status(), warns])).toMatchObject({
    mode: "live",
  });
  return { backend, storage: () => st!, warns };
}

/** 解开诊断包，把所有文件内容拼成一个字符串 */
function unzipAll(zip: string): string {
  const out = mkdtempSync(join(tmpdir(), "bc-ui07d-unzip-"));
  dirs.push(out);
  execFileSync("unzip", ["-q", zip, "-d", out]);
  const files = execFileSync("find", [out, "-type", "f"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  expect(files.length).toBeGreaterThan(0);
  return files.map((f) => execFileSync("cat", [f], { encoding: "utf8" })).join("\n");
}

describe("设置 › 项目（UI-07d）", () => {
  it("listProjects 返回带 repo_path 的记录；移除后不再出现，project_removed 只带 project_id", async () => {
    const r = repo();
    const { backend, storage } = await start(r);
    const p = await backend.importCurrentRepo();
    expect(backend.listProjects()?.find((x) => x.project_id === p.project_id)?.repo_path).toBe(r);

    await expect(backend.removeProject(p.project_id)).resolves.toEqual({ removed: true });
    expect(backend.listProjects()?.some((x) => x.project_id === p.project_id)).toBe(false);

    const removed = storage()
      .queryEvents({})
      .filter((e) => e.type === "project_removed");
    expect(removed).toHaveLength(1);
    expect(removed[0]!.payload).toEqual({ project_id: p.project_id });
    const all = JSON.stringify(storage().queryEvents({}));
    expect(all).not.toContain(r);
    expect(all).not.toContain("repo_path");

    // 已经不在：removed:false，不再发事件
    await expect(backend.removeProject(p.project_id)).resolves.toEqual({ removed: false });
    expect(
      storage()
        .queryEvents({})
        .filter((e) => e.type === "project_removed"),
    ).toHaveLength(1);
    await backend.stop();
  });

  it("诊断包（导入后、移除前后）里没有 repo_path 字段也没有仓库路径", async () => {
    const r = repo();
    const warns: string[] = [];
    const { backend } = await start(r, warns);
    const p = await backend.importCurrentRepo();
    const out = mkdtempSync(join(tmpdir(), "bc-ui07d-out-"));
    dirs.push(out);
    const before = unzipAll(await backend.exportDiagnostics(join(out, "a.zip")));
    expect(before).toContain(p.project_id);
    expect(before).not.toContain("repo_path");
    expect(before).not.toContain(r);

    await backend.removeProject(p.project_id);
    const after = unzipAll(await backend.exportDiagnostics(join(out, "b.zip")));
    expect(after).not.toContain("repo_path");
    expect(after).not.toContain(r);
    expect(warns.join("\n")).not.toContain(r);
    await backend.stop();
  });
});
