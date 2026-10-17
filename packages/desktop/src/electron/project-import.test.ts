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
import { inside } from "./project-settings-ipc.js";
import { copyExclusive, NotifyBuffer } from "./backend.js";
import type { App } from "@bakacoding/app";
import { symlinkSync } from "node:fs";
import path from "node:path";
import { serveProjectSettings } from "./ipc.js";
import { failureText } from "../shared/error-text.js";
import { envPresence, type ProjectSettingsDeps } from "./project-settings-ipc.js";
import { readLastRepo, writeLastRepo } from "./repo-store.js";

const examplePath = fileURLToPath(
  new URL("../../../../config/models.example.json", import.meta.url),
);
const pricingPath = fileURLToPath(new URL("../../../../config/pricing.json", import.meta.url));

// 按格式拼的假密钥（11 的完整脱敏按格式识别）
const FAKE_GH = `ghp_${"A1b2C3d4E5".repeat(4)}`;
const FAKE_DS = `sk-${"f00dfeed".repeat(4)}`;

function evilError(msg: string): Error {
  const e = new Error(msg);
  e.name = "Evil<img src=x>\n[REDACTED]ghp_" + "x".repeat(8);
  return e;
}

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
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
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

describe("BAKACODING_CONFIG（T-072）", () => {
  it("合法：不看仓库里的 models.json，校验环境变量指向的文件，结果写明在用它", () => {
    const r = repo({ models: false });
    const cfgDir = tmp("bc-cfg-");
    const cfg = join(cfgDir, "models.json");
    copyFileSync(examplePath, cfg);
    const c = checkProjectDir(r, { ...env, BAKACODING_CONFIG: cfg });
    expect(c).toEqual({ ok: true, note: `当前使用 BAKACODING_CONFIG 指定的配置：${cfg}` });
  });

  it("不合法：拒绝，错误经 redact(light)，带 [REDACTED:…]、不含原始密钥", () => {
    const r = repo();
    const cfg = join(tmp("bc-cfg-"), "models.json");
    // 键名不合规（被 validate 报出来），键名里带假密钥
    writeFileSync(cfg, JSON.stringify({ [FAKE_GH]: 1 }));
    const c = checkProjectDir(r, { BAKACODING_CONFIG: cfg });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.reason).toContain("BAKACODING_CONFIG");
    expect(c.reason).toContain("当前使用 BAKACODING_CONFIG 指定的配置");
    expect(c.reason).toMatch(/\[REDACTED:[a-z_]+\]/);
    expect(c.reason).not.toContain(FAKE_GH);
  });

  it("指向的文件不存在：拒绝", () => {
    const r = repo();
    const cfg = join(tmp("bc-cfg-"), "nope.json");
    const c = checkProjectDir(r, { ...env, BAKACODING_CONFIG: cfg });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.reason).toContain(`当前使用 BAKACODING_CONFIG 指定的配置，但文件不存在：${cfg}`);
    // 路径只出现一次
    expect(c.reason!.split(cfg).length - 1).toBe(1);
  });

  it("导入成功时 IPC 结果带上 note", async () => {
    const r = repo({ models: false });
    const cfg = join(tmp("bc-cfg-"), "models.json");
    copyFileSync(examplePath, cfg);
    const project = { project_id: "p", name: "p", path: r } as Project;
    const { ipc, invoke } = fakeIpc();
    serveProjectSettings(ipc, {
      backend: {
        switchTo: async () => ({ ok: true as const, project }),
        repoRoot: () => "/repo",
        prMode: () => "local" as const,
        exportDiagnostics: async (t: string) => t,
        status: () => ({ mode: "live" as const }),
      },
      argv: [],
      env: { BAKACODING_CONFIG: cfg },
      pickDirectory: async () => r,
      pickSavePath: async () => null,
      downloadsDir: "/dl",
      saveLastRepo: () => {},
    });
    await expect(invoke(IPC_CHANNELS.projectImport)).resolves.toEqual({
      ok: true,
      project,
      note: `当前使用 BAKACODING_CONFIG 指定的配置：${cfg}`,
    });
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

  it("#82 复查：project:import 把 argv 传给 checkProjectDir（--config 指向的文件不存在 → 拒绝并写明 --config）", async () => {
    const good = repo();
    const { ipc, invoke } = fakeIpc();
    const c = deps({ pickDirectory: async () => good, argv: ["--config", "nope/models.json"] });
    serveProjectSettings(ipc, c.d);
    const r = await invoke<{ ok: false; reason: string }>(IPC_CHANNELS.projectImport);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("当前使用 --config 指定的配置，但文件不存在");
    expect(c.backend.switchTo).not.toHaveBeenCalled();
  });

  it("#82 复查：新后端已在运行但导入失败 → 仍记下路径，原因原样返回", async () => {
    const good = repo();
    const { ipc, invoke } = fakeIpc();
    const c = deps({ pickDirectory: async () => good });
    c.backend.switchTo.mockResolvedValueOnce({
      ok: false,
      switched: true,
      reason: "已切换到新仓库，但导入项目失败：Error：bad",
    } as never);
    serveProjectSettings(ipc, c.d);
    const r = await invoke<{ ok: false; reason: string }>(IPC_CHANNELS.projectImport);
    expect(r.reason).toContain("导入项目失败");
    expect(c.saveLastRepo).toHaveBeenCalledWith(good);
  });

  it("#82 复查：导出出错时恶意 e.name 经 sanitizeErrorName 过滤", async () => {
    const outZip = join(tmp("bc-out-"), "x.zip");
    const { ipc, invoke } = fakeIpc();
    const c = deps({ pickSavePath: async () => outZip });
    c.backend.exportDiagnostics.mockRejectedValueOnce(evilError("boom"));
    serveProjectSettings(ipc, c.d);
    const r = await invoke<{ ok: false; reason: string }>(IPC_CHANNELS.diagnosticsExport);
    expect(r.reason).toContain("boom");
    expect(r.reason).not.toMatch(/[<>\n]/);
    expect(r.reason).not.toContain("<img");
  });

  it("#82 复查：导出目标是符号链接 → 拒绝，不跟进去", async () => {
    const base = tmp("bc-sl-");
    const target = join(base, "x.zip");
    symlinkSync(join(base, "elsewhere.zip"), target);
    const { ipc, invoke } = fakeIpc();
    const c = deps({ pickSavePath: async () => target });
    serveProjectSettings(ipc, c.d);
    await expect(invoke(IPC_CHANNELS.diagnosticsExport)).resolves.toEqual({
      ok: false,
      reason: "保存位置是符号链接，请换个位置",
    });
    expect(c.backend.exportDiagnostics).not.toHaveBeenCalled();
  });

  it("T-077：只读时导出先拒绝、不弹保存框；界面最终文案只有一个前缀", async () => {
    const { ipc, invoke } = fakeIpc();
    const pick = vi.fn(async () => "/x.zip");
    const c = deps({ pickSavePath: pick });
    (c.backend as { status: () => unknown }).status = () => ({
      mode: "readonly",
      reason: "配置校验失败（ConfigError）",
    });
    serveProjectSettings(ipc, c.d);
    const r = await invoke<{ ok: false; reason: string }>(IPC_CHANNELS.diagnosticsExport);
    expect(r).toEqual({ ok: false, reason: "只读模式：配置校验失败（ConfigError）" });
    expect(pick).not.toHaveBeenCalled();
    expect(failureText("导出失败", r.reason)).toBe(
      "导出失败：只读模式：配置校验失败（ConfigError）",
    );
  });

  it("T-077：导出抛泛化 Error（只读）时原因不带 Error：、不带前缀", async () => {
    const outZip = join(tmp("bc-out-"), "x.zip");
    const { ipc, invoke } = fakeIpc();
    const c = deps({ pickSavePath: async () => outZip });
    c.backend.exportDiagnostics.mockRejectedValueOnce(
      new Error("只读模式：配置校验失败（ConfigError）"),
    );
    serveProjectSettings(ipc, c.d);
    const r = await invoke<{ ok: false; reason: string }>(IPC_CHANNELS.diagnosticsExport);
    expect(failureText("导出失败", r.reason)).toBe(
      "导出失败：只读模式：配置校验失败（ConfigError）",
    );
    expect(r.reason).toBe("只读模式：配置校验失败（ConfigError）");
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

    const outZip = join(tmp("bc-out-"), "x.zip");
    const { ipc: i3, invoke: v3 } = fakeIpc();
    const c3 = deps({ pickSavePath: async () => outZip });
    serveProjectSettings(i3, c3.d);
    await expect(v3(IPC_CHANNELS.diagnosticsExport)).resolves.toEqual({
      ok: true,
      path: outZip,
    });

    const { ipc: i4, invoke: v4 } = fakeIpc();
    const c4 = deps({ pickSavePath: async () => outZip });
    c4.backend.exportDiagnostics.mockRejectedValueOnce(new Error(`EACCES ${FAKE_DS}`));
    serveProjectSettings(i4, c4.d);
    const r4 = await v4<{ ok: false; reason: string }>(IPC_CHANNELS.diagnosticsExport);
    expect(r4.ok).toBe(false);
    expect(r4.reason).toContain("EACCES");
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

  it("settings:get：后端只读时 mode 为 readonly（不显示成 local）", async () => {
    const { ipc, invoke } = fakeIpc();
    const c = deps();
    (c.backend as { status: () => { mode: string } }).status = () => ({ mode: "readonly" });
    serveProjectSettings(ipc, c.d);
    const s = await invoke<DesktopSettings>(IPC_CHANNELS.settingsGet);
    expect(s.mode).toBe("readonly");
  });

  it("live 后端：无 GITHUB_TOKEN 时 prMode 为 local（取自 app.pr 是否 GithubPrProvider）", async () => {
    const a = repo();
    const be = await startOn(a);
    expect(be.prMode()).toBe("local");
    expect(be.busyCount()).toBe(0);
    await be.stop();
  });
});

describe("评审跟进（T-072 #82）", () => {
  // ---- 1. 组装失败：先用原仓库重组；也失败就只读 ----
  it("新仓库组装抛错 → 用原仓库重组成功：如实说已回到原仓库，仍 live", async () => {
    const a = repo();
    const b = repo();
    const start = async (r: string) => {
      if (r === b) throw new Error("boom");
      return startOn(r);
    };
    const sw = new BackendSwitcher(await startOn(a), start, env);
    const r = await sw.switchTo(b);
    expect(r).toEqual({ ok: false, reason: "新仓库没能启动（boom），已回到原仓库" });
    expect(sw.status().mode).toBe("live");
    expect(sw.repoRoot()).toBe(a);
    await sw.stop();
  });

  it("新仓库和原仓库都组装失败 → 只读，消息如实（不说已回到原仓库）", async () => {
    const a = repo();
    const b = repo();
    let calls = 0;
    const start = async (r: string) => {
      calls++;
      throw new Error(`fail-${r === b ? "new" : "old"}`);
    };
    const sw = new BackendSwitcher(await startOn(a), start, env);
    const r = await sw.switchTo(b);
    expect(calls).toBe(2);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("新仓库没能启动（fail-new）");
    expect(r.reason).toContain("原仓库也没能重新启动（fail-old）");
    expect(r.reason).toContain("只读模式");
    expect(r.reason).not.toContain("已回到原仓库");
    expect(sw.status().mode).toBe("readonly");
    await sw.stop();
  });

  it("拆下来的后端 status 不再是 live", async () => {
    const be = await startOn(repo());
    expect(be.status().mode).toBe("live");
    await be.stop();
    expect(be.status().mode).toBe("readonly");
  });

  // ---- 2. 切换 / 导入失败后保留渲染就绪 ----
  function fakeBackend(
    repoRoot: string,
    opts: { mode?: "live" | "readonly"; importFails?: boolean | Error } = {},
  ) {
    const buf = new NotifyBuffer(200);
    const handle = {
      status: () => ({ mode: opts.mode ?? "live" }),
      markRendererReady: () => buf.markReady(),
      onNotify: (l: (m: NotifyMessage) => void) => buf.onNotify(l),
      onPendingHighRisk: () => () => {},
      busyCount: () => 0,
      repoRoot: () => repoRoot,
      importCurrentRepo: async () => {
        if (opts.importFails) throw opts.importFails === true ? new Error("bad") : opts.importFails;
        return { project_id: "p", name: "p", path: repoRoot } as Project;
      },
      stop: async () => {},
    } as unknown as BackendHandle;
    return { handle, emit: (text: string) => buf.push({ text }) };
  }

  it("导入失败（新后端 live 但 importProject 抛错）：渲染就绪保留，之后的通知直接送达", async () => {
    const old = fakeBackend("/a");
    const next = fakeBackend("/b", { importFails: true });
    const sw = new BackendSwitcher(old.handle, async () => next.handle);
    const got: string[] = [];
    sw.onNotify((m) => got.push(m.text));
    sw.markRendererReady();
    next.emit("切换中缓冲的");
    const r = await sw.switchTo("/b");
    expect(r.ok).toBe(false);
    next.emit("之后的");
    expect(got).toEqual(["切换中缓冲的", "之后的"]);
  });

  it("切换失败回到原仓库：渲染就绪保留，之后的通知直接送达", async () => {
    const old = fakeBackend("/a");
    const back = fakeBackend("/a");
    const sw = new BackendSwitcher(old.handle, async (r) =>
      r === "/b" ? fakeBackend("/b", { mode: "readonly" }).handle : back.handle,
    );
    const got: string[] = [];
    sw.onNotify((m) => got.push(m.text));
    sw.markRendererReady();
    const r = await sw.switchTo("/b");
    expect(r.ok === false && r.reason).toContain("已回到原仓库");
    back.emit("回来之后");
    expect(got).toEqual(["回来之后"]);
  });

  it("#82 复查：导入失败时恶意 e.name 被过滤，switched 为 true，消息写明导入失败", async () => {
    const old = fakeBackend("/a");
    const next = fakeBackend("/b", { importFails: evilError("bad") });
    const sw = new BackendSwitcher(old.handle, async () => next.handle);
    const r = await sw.switchTo("/b");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.switched).toBe(true);
    expect(r.reason).toContain("导入项目失败");
    expect(r.reason).not.toContain("<img");
    expect(r.reason).not.toMatch(/[<>\n]/);
  });

  it("#82 复查：新仓库组装抛错时恶意 e.name 被过滤", async () => {
    const old = fakeBackend("/a");
    const back = fakeBackend("/a");
    const sw = new BackendSwitcher(old.handle, async (r) => {
      if (r === "/b") throw evilError("start failed");
      return back.handle;
    });
    const r = await sw.switchTo("/b");
    expect(r.ok === false && r.reason).toContain("已回到原仓库");
    if (r.ok) return;
    expect(r.reason).not.toContain("<img");
    expect(r.reason).not.toMatch(/[<>\n]/);
  });

  it("切换成功：就绪清掉，新后端先缓冲，等渲染进程重载后 ready 再回放", async () => {
    const old = fakeBackend("/a");
    const next = fakeBackend("/b");
    const sw = new BackendSwitcher(old.handle, async () => next.handle);
    const got: string[] = [];
    sw.onNotify((m) => got.push(m.text));
    sw.markRendererReady();
    expect((await sw.switchTo("/b")).ok).toBe(true);
    next.emit("已导入");
    expect(got).toEqual([]);
    expect(sw.markRendererReady().map((m) => m.text)).toEqual(["已导入"]);
  });

  // ---- 3. inside()：realpath + relative ----
  it("inside：..foo 目录、指进仓库的符号链接算在里面；../x、别处的绝对路径、同前缀的兄弟目录不算", () => {
    const base = tmp("bc-in-");
    const r = join(base, "repo");
    mkdirSync(join(r, "..foo"), { recursive: true });
    mkdirSync(join(base, "repo-other"), { recursive: true });
    const link = join(base, "link");
    symlinkSync(r, link, "dir");
    expect(inside(join(r, "..foo", "x.zip"), r)).toBe(true);
    expect(inside(join(r, "new-dir", "x.zip"), r)).toBe(true);
    expect(inside(join(link, "x.zip"), r)).toBe(true);
    expect(inside(join(r, "..", "x.zip"), r)).toBe(false);
    expect(inside(join(base, "repo-other", "x.zip"), r)).toBe(false);
    expect(inside(join(tmp("bc-else-"), "x.zip"), r)).toBe(false);
    expect(inside(r, r)).toBe(true);
  });

  it("#82 复查：悬空符号链接指向仓库里还不存在的文件 → 算在里面", () => {
    const base = tmp("bc-dl-");
    const r = join(base, "repo");
    const out = join(base, "out");
    mkdirSync(r, { recursive: true });
    mkdirSync(out, { recursive: true });
    symlinkSync(join(r, "new.zip"), join(out, "x.zip"));
    expect(inside(join(out, "x.zip"), r)).toBe(true);
  });

  it("#82 复查：<out>/link/../x.zip（link 指向 <repo>/sub）不做词法规范化 → 算在里面", () => {
    const base = tmp("bc-dd-");
    const r = join(base, "repo");
    const out = join(base, "out");
    mkdirSync(join(r, "sub"), { recursive: true });
    mkdirSync(out, { recursive: true });
    symlinkSync(join(r, "sub"), join(out, "link"), "dir");
    // 不能用 join（会先把 .. 消掉）
    expect(inside(`${out}/link/../x.zip`, r)).toBe(true);
    expect(inside(`${out}/x.zip`, r)).toBe(false);
  });

  it("#82 复查：配置来源写进错误信息（--config / BAKACODING_CONFIG）", () => {
    const d = repo();
    const a = checkProjectDir(d, { BAKACODING_CONFIG: "env-missing.json" }, []);
    expect(a.ok === false && a.reason).toContain(
      "当前使用 BAKACODING_CONFIG 指定的配置，但文件不存在",
    );
    const b = checkProjectDir(d, { BAKACODING_CONFIG: "env-missing.json" }, [
      "--config=cli-missing.json",
    ]);
    expect(b.ok === false && b.reason).toContain("当前使用 --config 指定的配置，但文件不存在");
    expect(b.ok === false && b.reason).toContain("cli-missing.json");
  });

  it("#82 复查：copyExclusive 不跟随符号链接（含悬空），普通文件可覆盖", async () => {
    const base = tmp("bc-cx-");
    const src = join(base, "src.zip");
    writeFileSync(src, "new");
    const link = join(base, "link.zip");
    symlinkSync(join(base, "victim.zip"), link);
    await expect(copyExclusive(src, link)).rejects.toThrow("不是普通文件");
    expect(existsSync(join(base, "victim.zip"))).toBe(false);
    const plain = join(base, "plain.zip");
    writeFileSync(plain, "old");
    await copyExclusive(src, plain);
    expect(readFileSync(plain, "utf8")).toBe("new");
  });

  it("inside：Windows 不区分大小写（可注入平台）", () => {
    const id = (p: string) => p;
    const win = { pathImpl: path.win32, realpath: id, platform: "win32" as const };
    expect(inside("C:\\Repo\\out\\x.zip", "c:\\repo", win)).toBe(true);
    expect(inside("C:\\Repo2\\x.zip", "c:\\repo", win)).toBe(false);
    // 大小写处理来自 platform 判断本身（不依赖 path.win32 的比较）
    const posix = { pathImpl: path.posix, realpath: id };
    expect(inside("/Repo/out/x.zip", "/repo", { ...posix, platform: "win32" })).toBe(true);
    expect(inside("/Repo/out/x.zip", "/repo", { ...posix, platform: "linux" })).toBe(false);
  });

  // ---- 4. 拆除：10 退订、9 停定时 sync ----
  async function liveWithApp(r: string) {
    let app!: App;
    const be = await startBackend({
      argv: [],
      env,
      cwd: r,
      lastRepo: r,
      logger: quiet,
      onAssembled: (x) => (app = x),
    });
    const schedStop = vi.spyOn(app.scheduler, "stop");
    const got: NotifyMessage[] = [];
    be.onNotify((m) => got.push(m));
    be.markRendererReady();
    const publishProject = () =>
      app.bus.publish({
        type: "project_created",
        trace_id: "t",
        span_id: "s",
        parent_span_id: null,
        requirement_id: null,
        ticket_id: null,
        payload: { project_id: "p-x", name: "x", language: "unknown", has_github_remote: false },
      } as never);
    return { be, app, schedStop, got, publishProject };
  }

  it("stop()（cleanupPartial）：9 的 stop（含定时 sync）被调，10 不再收 project_created", async () => {
    const t = await liveWithApp(repo());
    await t.publishProject();
    await tick();
    expect(t.got.filter((m) => m.text.includes("已导入"))).toHaveLength(1);
    await t.be.stop();
    expect(t.schedStop).toHaveBeenCalled();
    await t.publishProject();
    await tick();
    expect(t.got.filter((m) => m.text.includes("已导入"))).toHaveLength(1);
  });

  it("切换时旧后端被拆：9 stop 被调，旧总线上的 project_created 不再通知", async () => {
    const a = repo();
    const t = await liveWithApp(a);
    const sw = new BackendSwitcher(t.be, startOn, env);
    expect((await sw.switchTo(repo())).ok).toBe(true);
    expect(t.schedStop).toHaveBeenCalled();
    await t.publishProject();
    await tick();
    expect(t.got).toHaveLength(0);
    await sw.stop();
  });

  // ---- 5. --config 优先于 BAKACODING_CONFIG；相对路径；空值 ----
  it("--config 优先于 BAKACODING_CONFIG，说明里写 --config", () => {
    const r = repo({ models: false });
    const good = join(tmp("bc-cfg-"), "good.json");
    copyFileSync(examplePath, good);
    const bad = join(tmp("bc-cfg-"), "bad.json");
    writeFileSync(bad, "{}");
    expect(checkProjectDir(r, { ...env, BAKACODING_CONFIG: bad }, ["--config", good])).toEqual({
      ok: true,
      note: `当前使用 --config 指定的配置：${good}`,
    });
    expect(checkProjectDir(r, { ...env, BAKACODING_CONFIG: good }, [`--config=${bad}`]).ok).toBe(
      false,
    );
  });

  it("相对路径的 BAKACODING_CONFIG：相对所选目录解析", () => {
    const r = repo({ models: false });
    mkdirSync(join(r, "cfg"));
    copyFileSync(examplePath, join(r, "cfg", "m.json"));
    expect(checkProjectDir(r, { ...env, BAKACODING_CONFIG: "cfg/m.json" })).toEqual({
      ok: true,
      note: `当前使用 BAKACODING_CONFIG 指定的配置：${join(r, "cfg", "m.json")}`,
    });
  });

  it("BAKACODING_CONFIG 为空串：当没设，查仓库里的 config/models.json", () => {
    const r = repo({ models: false });
    const c = checkProjectDir(r, { ...env, BAKACODING_CONFIG: "" });
    expect(c).toEqual({
      ok: false,
      missing: ["config/models.json"],
      reason: "缺少 config/models.json",
    });
  });
});
