// T-145：导入项目后由 importCurrentRepo 写入仓库路径（setProjectRepoPath），路径不进事件。
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
  const root = mkdtempSync(join(tmpdir(), "bc-t145-"));
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

/** 起后端并拿到它的写入方 storage；可包一层 setProjectRepoPath */
async function start(
  r: string,
  wrap?: (s: Storage) => Storage["setProjectRepoPath"],
  warns: string[] = [],
) {
  let st: Storage | undefined;
  const backend = await startBackend({
    argv: [],
    env,
    cwd: r,
    lastRepo: r,
    logger: { warn: (m: string) => void warns.push(m) },
    openStorage: (o) => {
      const s = openStorage(o);
      if (wrap) {
        const w = wrap(s);
        Object.defineProperty(s, "setProjectRepoPath", { value: w });
      }
      st = s;
      return s;
    },
  });
  expect(backend.status(), JSON.stringify([backend.status(), warns])).toMatchObject({
    mode: "live",
  });
  return { backend, storage: () => st!, warns };
}

describe("导入后写入仓库路径（T-145）", () => {
  it("listProjects 带 repo_path；queryEvents 里没有路径", async () => {
    const r = repo();
    const { backend, storage } = await start(r);
    const p = await backend.importCurrentRepo();
    const row = storage()
      .listProjects()
      .find((x) => x.project_id === p.project_id);
    expect(row?.repo_path).toBe(r);
    const events = storage().queryEvents({});
    expect(events.some((e) => e.type === "project_created")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(r);
    expect(JSON.stringify(events)).not.toContain("repo_path");
    await backend.stop();
  });

  it("调用 setProjectRepoPath 时 project_created 已落库", async () => {
    const r = repo();
    const seen: boolean[] = [];
    const { backend } = await start(r, (s) => {
      const orig = s.setProjectRepoPath.bind(s);
      return (id, path) => {
        seen.push(s.listProjects().some((x) => x.project_id === id));
        return orig(id, path);
      };
    });
    await backend.importCurrentRepo();
    expect(seen).toEqual([true]);
    await backend.stop();
  });

  it("移除项目后再导入：重新登记且路径重新写入", async () => {
    const r = repo();
    const { backend, storage } = await start(r);
    const p = await backend.importCurrentRepo();
    expect(storage().removeProject(p.project_id)).toEqual({ removed: true });
    expect(
      storage()
        .listProjects()
        .some((x) => x.project_id === p.project_id),
    ).toBe(false);
    await backend.importCurrentRepo();
    const row = storage()
      .listProjects()
      .find((x) => x.project_id === p.project_id);
    expect(row?.repo_path).toBe(r);
    await backend.stop();
  });

  it("updated:false 或抛错：导入照样成功，只记一条不带路径的 warn", async () => {
    for (const mode of ["false", "throw"] as const) {
      const r = repo();
      const warns: string[] = [];
      const { backend } = await start(
        r,
        () => () => {
          if (mode === "throw") throw new Error(`boom ${r}`);
          return { updated: false };
        },
        warns,
      );
      const p = await backend.importCurrentRepo();
      expect(p.project_id).toBeTruthy();
      const hits = warns.filter((w) => w.includes("仓库路径"));
      expect(hits).toHaveLength(1);
      expect(hits[0]).not.toContain(r);
      await backend.stop();
    }
  });
});
