// T-072：导入项目（目录检查、重新组装、忙时拒绝）、导出诊断包（11 完整脱敏）、只读设置。
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Project } from "@bakacoding/config-budget";
import { readZip } from "@bakacoding/diagnostics";
import { openStorageReadonly } from "@bakacoding/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type DesktopSettings } from "../shared/api.js";
import {
  countBusy,
  resolveRepoPath,
  startBackend,
  type BackendHandle,
  type NotifyMessage,
} from "./backend.js";
import { BackendSwitcher } from "./backend-switcher.js";
import type { IpcMainLike } from "./ipc.js";
import { checkProjectDir, repoLockedBy, REPO_LOCKED_REASON } from "./project-import.js";
import {
  envPresence,
  serveProjectSettings,
  type ProjectSettingsDeps,
} from "./project-settings-ipc.js";
import { readLastRepo, writeLastRepo } from "./repo-store.js";

const examplePath = fileURLToPath(
  new URL("../../../../config/models.example.json", import.meta.url),
);
const pricingPath = fileURLToPath(new URL("../../../../config/pricing.json", import.meta.url));

// 按格式拼的假密钥（11 的完整脱敏按格式识别）
const FAKE_GH = `ghp_${"A1b2C3d4E5".repeat(4)}`;
const FAKE_DS = `sk-${"f00dfeed".repeat(4)}`;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function repo(opts: { git?: boolean; models?: boolean; pricing?: boolean } = {}): string {
  const root = tmp("bc-imp-");
  if (opts.git !== false) {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "t"], { cwd: root });
    writeFileSync(join(root, "README.md"), "x\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: root });
  }
  mkdirSync(join(root, "config"), { recursive: true });
  if (opts.models !== false) copyFileSync(examplePath, join(root, "config", "models.json"));
  if (opts.pricing !== false) copyFileSync(pricingPath, join(root, "config", "pricing.json"));
  return root;
}

const quiet = { warn: () => {} };
const env = { DEEPSEEK_API_KEY: FAKE_DS };
const startOn = (r: string) => startBackend({ argv: [], env, cwd: r, lastRepo: r, logger: quiet });
const tick = () => new Promise((r) => setTimeout(r, 30));

/** 像 ipcMain.handle 一样调：第一个参数是 event */
function fakeIpc() {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const ipc: IpcMainLike = {
    handle: (c, l) => void handlers.set(c, l),
    removeHandler: (c) => void handlers.delete(c),
  };
  const invoke = <T>(c: string, ...args: unknown[]) =>
    handlers.get(c)!({ sender: {} }, ...args) as Promise<T>;
  return { ipc, handlers, invoke };
}

describe("仓库路径与上次导入（T-072）", () => {
  it("--repo > BAKACODING_REPO > 上次导入 > cwd", () => {
    expect(resolveRepoPath(["--repo=/a"], { BAKACODING_REPO: "/e" }, "/c", "/l")).toBe("/a");
    expect(resolveRepoPath([], { BAKACODING_REPO: "/e" }, "/c", "/l")).toBe("/e");
    expect(resolveRepoPath([], {}, "/c", "/l")).toBe("/l");
    expect(resolveRepoPath([], {}, "/c")).toBe("/c");
  });

  it("userData 里记下 / 读回上次导入的路径；坏文件当没有", () => {
    const d = tmp("bc-ud-");
    expect(readLastRepo(d)).toBeUndefined();
    writeLastRepo(d, "/r/x");
    expect(readLastRepo(d)).toBe("/r/x");
    writeFileSync(join(d, "desktop-state.json"), "{bad");
    expect(readLastRepo(d)).toBeUndefined();
  });

  it("repoLockedBy：--repo / BAKACODING_REPO", () => {
    expect(repoLockedBy(["--repo", "/x"], {})).toBe("arg");
    expect(repoLockedBy(["--repo=/x"], {})).toBe("arg");
    expect(repoLockedBy([], { BAKACODING_REPO: "/x" })).toBe("env");
    expect(repoLockedBy([], {})).toBeNull();
  });

  it("库路径：绝对的 --db / BAKACODING_DB_PATH 锁定；相对路径不锁", () => {
    const abs = join(tmpdir(), "shared.db");
    expect(repoLockedBy([`--db=${abs}`], {})).toBe("db_arg");
    expect(repoLockedBy(["--db", abs], {})).toBe("db_arg");
    expect(repoLockedBy([], { BAKACODING_DB_PATH: abs })).toBe("db_env");
    expect(repoLockedBy([], { BAKACODING_DB_PATH: "data/x.db" })).toBeNull();
    expect(repoLockedBy(["--db=data/x.db"], {})).toBeNull();
    // 相对的 --db 覆盖环境变量（与 resolveRepoDbPath 一致）
    expect(repoLockedBy(["--db=data/x.db"], { BAKACODING_DB_PATH: abs })).toBeNull();
  });
});

describe("checkProjectDir（T-072）", () => {
  it("合格目录通过", () => {
    expect(checkProjectDir(repo(), env)).toEqual({ ok: true });
  });

  it("不是 git 仓库、缺配置文件：missing 列出并写中文原因", () => {
    const r = checkProjectDir(repo({ git: false, models: false, pricing: false }), env);
    expect(r).toEqual({
      ok: false,
      missing: [".git", "config/models.json", "config/pricing.json"],
      reason: "不是 git 仓库（没有 .git）；缺少 config/models.json；缺少 config/pricing.json",
    });
    const r2 = checkProjectDir(repo({ pricing: false }), env);
    expect(r2.ok === false && r2.missing).toEqual(["config/pricing.json"]);
  });

  it("models.json 不合法 / pricing.json 坏：用 3 的 validate / loadPricing，错误脱敏", () => {
    const r = repo();
    writeFileSync(join(r, "config", "models.json"), JSON.stringify({ token: FAKE_GH }));
    writeFileSync(join(r, "config", "pricing.json"), `{"x": "${FAKE_DS}"}`);
    const c = checkProjectDir(r, { DEEPSEEK_API_KEY: FAKE_DS });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.reason).toContain("config/models.json");
    expect(c.reason).toContain("config/pricing.json 校验失败");
    expect(c.reason).not.toContain(FAKE_DS);
    expect(c.reason).not.toContain(FAKE_GH);
  });
});

describe("BackendSwitcher 重新组装（T-072）", () => {
  it("切到新仓库：旧后端拆掉，新后端 live，project_created 只落库一次、只通知一次；连导两次第二次仍 live", async () => {
    const a = repo();
    const b = repo();
    const sw = new BackendSwitcher(await startOn(a), startOn, env);
    expect(sw.status().mode).toBe("live");
    const got: NotifyMessage[] = [];
    sw.onNotify((m) => got.push(m));
    sw.markRendererReady();

    const r1 = await sw.switchTo(b);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(sw.status().mode).toBe("live");
    expect(sw.repoRoot()).toBe(b);
    expect(r1.project.name).toBeTruthy();
    // 旧库的锁已释放：能在旧仓库再起一个 live 后端
    const again = await startOn(a);
    expect(again.status().mode).toBe("live");
    await again.stop();

    await tick();
    // 渲染进程重载后调 ready：回放里恰好一条「已导入」
    const replay = sw.markRendererReady();
    const imported = [...got, ...replay].filter((m) => m.text.includes("已导入"));
    expect(imported).toHaveLength(1);
    expect(imported[0]!.project_id).toBe(r1.project.project_id);

    const r2 = await sw.switchTo(b);
    expect(r2.ok).toBe(true);
    expect(sw.status().mode).toBe("live");
    await sw.stop();

    const ro = openStorageReadonly({
      path: join(b, ".bakacoding", "bakacoding.db"),
      logger: quiet,
    });
    expect(ro.listProjects().filter((p) => p.project_id === r1.project.project_id)).toHaveLength(1);
    ro.close();
    expect(existsSync(join(a, ".bakacoding"))).toBe(true);
  });

  function busyFake(tickets: { ticket_id: string; status?: string }[], pendingHR: string[]) {
    const stop = vi.fn(async () => {});
    const fake = {
      busyCount: () => countBusy(tickets, pendingHR),
      stop,
      onNotify: () => () => {},
      onPendingHighRisk: () => () => {},
    } as unknown as BackendHandle;
    const start = vi.fn();
    return { sw: new BackendSwitcher(fake, start), stop, start };
  }

  it("只有进行中的单（无高风险待裁决）：拒绝切换，N = 进行中单数，不拆旧后端", async () => {
    const { sw, stop, start } = busyFake(
      [
        { ticket_id: "T-1", status: "coding" },
        { ticket_id: "T-2", status: "merge_queued" },
        { ticket_id: "T-3", status: "merged" },
        { ticket_id: "T-4" },
      ],
      [],
    );
    await expect(sw.switchTo("/x")).resolves.toEqual({
      ok: false,
      reason: "还有 3 张单在进行中，完成后再切换项目",
    });
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("只有高风险待裁决（库里没有进行中的单）：拒绝切换，N = 待裁决单数", async () => {
    // 高风险单在库里本是非终态；这里让 listTickets 里没有它们，专门走 pendingHighRisk 这一路
    const { sw, stop, start } = busyFake(
      [{ ticket_id: "T-9", status: "escalated" }],
      ["T-5", "T-6"],
    );
    await expect(sw.switchTo("/x")).resolves.toEqual({
      ok: false,
      reason: "还有 2 张单在进行中，完成后再切换项目",
    });
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("同一张单既在进行中又在等高风险裁决：只算 1 张", async () => {
    const { sw, stop } = busyFake([{ ticket_id: "T-1", status: "in_review" }], ["T-1"]);
    await expect(sw.switchTo("/x")).resolves.toEqual({
      ok: false,
      reason: "还有 1 张单在进行中，完成后再切换项目",
    });
    expect(stop).not.toHaveBeenCalled();
  });

  it("countBusy：并集计数；全部终态且无待裁决为 0", () => {
    expect(countBusy([{ ticket_id: "A", status: "coding" }], ["B"])).toBe(2);
    expect(
      countBusy(
        [
          { ticket_id: "A", status: "merged" },
          { ticket_id: "B", status: "escalated" },
        ],
        [],
      ),
    ).toBe(0);
  });

  it("新仓库没进 live：回到原仓库并返回原因", async () => {
    const a = repo();
    const b = repo();
    const start = (r: string) =>
      r === b
        ? startBackend({ argv: [], env: {}, cwd: r, lastRepo: r, logger: quiet })
        : startOn(r);
    const sw = new BackendSwitcher(await startOn(a), start, env);
    const r = await sw.switchTo(b);
    expect(r).toEqual({
      ok: false,
      reason: "新仓库没能启动（缺少环境变量 DEEPSEEK_API_KEY），已回到原仓库",
    });
    expect(sw.repoRoot()).toBe(a);
    expect(sw.status().mode).toBe("live");
    await sw.stop();
  });
});

describe("导出诊断包（T-072）", () => {
  it("11 完整脱敏：埋进事件的 GITHUB_TOKEN / DEEPSEEK_API_KEY 值不出现在导出文件里", async () => {
    const a = repo();
    const e = { DEEPSEEK_API_KEY: FAKE_DS, GITHUB_TOKEN: FAKE_GH };
    const { importProject } = await import("@bakacoding/config-budget");
    // 项目名里埋密钥值：project_created 落库后会进诊断包的事件里
    const name = `proj ${FAKE_GH} ${FAKE_DS}`;
    const be = await startBackend({
      argv: [],
      env: e,
      cwd: a,
      lastRepo: a,
      logger: quiet,
      importProject: (p, o) => importProject(p, { ...o, name }),
    });
    expect(be.status().mode).toBe("live");
    const p: Project = await be.importCurrentRepo();
    await tick();
    const out = tmp("bc-out-");
    const target = join(out, "diag.zip");
    await expect(be.exportDiagnostics(target)).resolves.toBe(target);
    await be.stop();
    const entries = readZip(readFileSync(target));
    const all = entries.map((x) => x.data.toString("utf8")).join("\n");
    expect(p.project_id).toBeTruthy();
    // 项目名（含密钥值）确实进了包，并被 11 遮掉
    expect(all).toContain("[REDACTED:github_token]");
    expect(all).not.toContain(FAKE_GH);
    expect(all).not.toContain(FAKE_DS);
  });

  it("只读后端导出：报错（IPC 层脱敏后显示）", async () => {
    const a = repo();
    const be = await startBackend({ argv: [], env: {}, cwd: a, lastRepo: a, logger: quiet });
    await expect(be.exportDiagnostics(join(tmp("bc-o-"), "x.zip"))).rejects.toThrow(/只读模式/);
    await be.stop();
  });
});

describe("project:import / diagnostics:export / settings:get IPC（T-072）", () => {
  function deps(over: Partial<ProjectSettingsDeps> = {}) {
    const project = { project_id: "p-1", name: "p", path: "/r" } as Project;
    const backend = {
      switchTo: vi.fn(async () => ({ ok: true as const, project })),
      repoRoot: () => "/repo",
      prMode: () => "local" as const,
      exportDiagnostics: vi.fn(async (t: string) => t),
      status: () => ({ mode: "live" as const }),
    };
    const saveLastRepo = vi.fn();
    const d: ProjectSettingsDeps = {
      backend,
      argv: [],
      env: { DEEPSEEK_API_KEY: FAKE_DS, GITHUB_TOKEN: FAKE_GH, BAKACODING_CONFIG: "" },
      pickDirectory: async () => null,
      pickSavePath: async () => null,
      downloadsDir: "/home/u/Downloads",
      saveLastRepo,
      now: () => new Date("2026-10-18T00:00:00.000Z"),
      ...over,
    };
    return { d, backend, saveLastRepo, project };
  }

  it("仓库被 --repo / 环境变量锁定：直接拒绝，不弹目录框", async () => {
    const absDb = join(tmpdir(), "shared.db");
    for (const lock of [
      { argv: ["--repo=/x"] },
      { env: { BAKACODING_REPO: "/x" } },
      { env: { BAKACODING_DB_PATH: absDb } },
      { argv: [`--db=${absDb}`] },
    ]) {
      const pick = vi.fn(async () => "/y");
      const { d, backend } = deps({ ...lock, pickDirectory: pick });
      const { ipc, invoke } = fakeIpc();
      serveProjectSettings(ipc, d);
      await expect(invoke(IPC_CHANNELS.projectImport)).resolves.toEqual({
        ok: false,
        reason: REPO_LOCKED_REASON,
      });
      expect(REPO_LOCKED_REASON).toContain("已被启动参数 / 环境变量锁定");
      expect(pick).not.toHaveBeenCalled();
      expect(backend.switchTo).not.toHaveBeenCalled();
    }
  });

  it("相对的 BAKACODING_DB_PATH 不锁：照常弹目录框", async () => {
    const pick = vi.fn(async () => null);
    const { d } = deps({ env: { BAKACODING_DB_PATH: "data/x.db" }, pickDirectory: pick });
    const { ipc, invoke } = fakeIpc();
    serveProjectSettings(ipc, d);
    await expect(invoke(IPC_CHANNELS.projectImport)).resolves.toEqual({
      ok: false,
      canceled: true,
    });
    expect(pick).toHaveBeenCalledTimes(1);
  });

  it("取消 / 缺文件 / 成功（记下路径）", async () => {
    const { ipc, invoke } = fakeIpc();
    const c = deps();
    serveProjectSettings(ipc, c.d);
    await expect(invoke(IPC_CHANNELS.projectImport)).resolves.toEqual({
      ok: false,
      canceled: true,
    });

    const bad = repo({ models: false });
    const { ipc: ipc2, invoke: invoke2 } = fakeIpc();
    const c2 = deps({ pickDirectory: async () => bad });
    serveProjectSettings(ipc2, c2.d);
    const r2 = await invoke2<{ ok: boolean; missing?: string[] }>(IPC_CHANNELS.projectImport);
    expect(r2.missing).toEqual(["config/models.json"]);
    expect(c2.backend.switchTo).not.toHaveBeenCalled();

    const good = repo();
    const { ipc: ipc3, invoke: invoke3, handlers } = fakeIpc();
    const c3 = deps({ pickDirectory: async () => good });
    const stop = serveProjectSettings(ipc3, c3.d);
    await expect(invoke3(IPC_CHANNELS.projectImport)).resolves.toEqual({
      ok: true,
      project: c3.project,
    });
    expect(c3.backend.switchTo).toHaveBeenCalledWith(good);
    expect(c3.saveLastRepo).toHaveBeenCalledWith(good);
    stop();
    expect(handlers.size).toBe(0);
  });

  it("切换被拒（忙）：原因原样返回，不记路径", async () => {
    const good = repo();
    const { ipc, invoke } = fakeIpc();
    const c = deps({ pickDirectory: async () => good });
    c.backend.switchTo.mockResolvedValueOnce({
      ok: false,
      reason: "还有 1 张单在进行中，完成后再切换项目",
    } as never);
    serveProjectSettings(ipc, c.d);
    await expect(invoke(IPC_CHANNELS.projectImport)).resolves.toEqual({
      ok: false,
      reason: "还有 1 张单在进行中，完成后再切换项目",
    });
    expect(c.saveLastRepo).not.toHaveBeenCalled();
  });

  it("导出：默认存到下载目录；取消；仓库里拒绝；出错脱敏", async () => {
    const seen: string[] = [];
    const { ipc, invoke } = fakeIpc();
    const c = deps({
      pickSavePath: async (p) => {
        seen.push(p);
        return null;
      },
    });
    serveProjectSettings(ipc, c.d);
    await expect(invoke(IPC_CHANNELS.diagnosticsExport)).resolves.toEqual({
      ok: false,
      canceled: true,
      reason: "已取消",
    });
    expect(seen[0]).toBe(join("/home/u/Downloads", "bakacoding-diag-20261018T000000000Z.zip"));

    const { ipc: i2, invoke: v2 } = fakeIpc();
    serveProjectSettings(i2, deps({ pickSavePath: async () => "/repo/sub/x.zip" }).d);
    await expect(v2(IPC_CHANNELS.diagnosticsExport)).resolves.toEqual({
      ok: false,
      reason: "不能把诊断包保存到仓库目录里，请换个位置",
    });

    const { ipc: i3, invoke: v3 } = fakeIpc();
    const c3 = deps({ pickSavePath: async () => "/out/x.zip" });
    serveProjectSettings(i3, c3.d);
    await expect(v3(IPC_CHANNELS.diagnosticsExport)).resolves.toEqual({
      ok: true,
      path: "/out/x.zip",
    });

    const { ipc: i4, invoke: v4 } = fakeIpc();
    const c4 = deps({ pickSavePath: async () => "/out/x.zip" });
    c4.backend.exportDiagnostics.mockRejectedValueOnce(new Error(`EACCES ${FAKE_DS}`));
    serveProjectSettings(i4, c4.d);
    const r4 = await v4<{ ok: false; reason: string }>(IPC_CHANNELS.diagnosticsExport);
    expect(r4.ok).toBe(false);
    expect(r4.reason).toContain("导出失败");
    expect(r4.reason).not.toContain(FAKE_DS);
  });

  it("settings:get：只给变量名和是否已设，值绝不过 IPC", async () => {
    const { ipc, invoke } = fakeIpc();
    serveProjectSettings(ipc, deps().d);
    const s = await invoke<DesktopSettings>(IPC_CHANNELS.settingsGet);
    expect(s).toEqual({
      repo: "/repo",
      mode: "local",
      env: [
        { name: "DEEPSEEK_API_KEY", set: true },
        { name: "GITHUB_TOKEN", set: true },
        { name: "BAKACODING_REPO", set: false },
        { name: "BAKACODING_CONFIG", set: false },
        { name: "BAKACODING_DB_PATH", set: false },
      ],
    });
    const raw = JSON.stringify(s);
    expect(raw).not.toContain(FAKE_DS);
    expect(raw).not.toContain(FAKE_GH);
    expect(envPresence({}).every((e) => !e.set)).toBe(true);
  });

  it("live 后端：无 GITHUB_TOKEN 时 prMode 为 local（取自 app.pr 是否 GithubPrProvider）", async () => {
    const a = repo();
    const be = await startOn(a);
    expect(be.prMode()).toBe("local");
    expect(be.busyCount()).toBe(0);
    await be.stop();
  });
});
