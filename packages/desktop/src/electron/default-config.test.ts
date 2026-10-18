// T-081：导入缺配置时用默认模板创建（模板复制、不覆盖、--config、符号链接、exclude 注入、IPC）。
// T-082 起 ensureExcludeLines 已合入，这里补真实实现（@bakacoding/app 再导出）与创建结果对接的测试。
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureExcludeLines } from "@bakacoding/app";
import type { Project } from "@bakacoding/config-budget";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type DesktopImportResult } from "../shared/api.js";
import {
  canCreateDefaultConfig,
  createDefaultConfigFiles,
  defaultTemplateDir,
} from "./default-config.js";
import { serveProjectSettings, type IpcMainLike } from "./ipc.js";
import { checkProjectDir } from "./project-import.js";
import type { ProjectSettingsDeps } from "./project-settings-ipc.js";

const TEMPLATES = fileURLToPath(new URL("../../../../config/", import.meta.url));
const MODELS = join(TEMPLATES, "models.example.json");
const PRICING = join(TEMPLATES, "pricing.json");

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "bc-t081-"));
  dirs.push(d);
  return d;
}
function repo(opts: { git?: boolean; models?: string; pricing?: string } = {}): string {
  const root = tmp();
  if (opts.git !== false) execFileSync("git", ["init", "-q"], { cwd: root });
  if (opts.models !== undefined || opts.pricing !== undefined) mkdirSync(join(root, "config"));
  if (opts.models !== undefined) writeFileSync(join(root, "config/models.json"), opts.models);
  if (opts.pricing !== undefined) writeFileSync(join(root, "config/pricing.json"), opts.pricing);
  return root;
}
const read = (p: string) => readFileSync(p, "utf8");

/**
 * 本机能不能建符号链接：Windows 没开发者模式 / 权限时 symlinkSync 抛 EPERM。
 * 符号链接用例在不能建的机器上 skip，避免环境问题被算成「新增失败」。
 */
function canCreateSymlink(): boolean {
  const d = mkdtempSync(join(tmpdir(), "bc-sym-probe-"));
  try {
    symlinkSync(d, join(d, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
const SYMLINK_OK = canCreateSymlink();

describe("createDefaultConfigFiles（T-081）", () => {
  it("两个都缺：都从模板创建，导入校验通过", () => {
    const d = repo();
    expect(createDefaultConfigFiles(d, TEMPLATES)).toEqual({
      ok: true,
      created: ["config/models.json", "config/pricing.json"],
    });
    expect(read(join(d, "config/models.json"))).toBe(read(MODELS));
    expect(read(join(d, "config/pricing.json"))).toBe(read(PRICING));
    expect(checkProjectDir(d)).toEqual({ ok: true });
  });

  it("只缺 models.json / 只缺 pricing.json：只补缺的，已有的内容不变", () => {
    const a = repo({ pricing: "MINE-P" });
    expect(createDefaultConfigFiles(a, TEMPLATES)).toEqual({
      ok: true,
      created: ["config/models.json"],
    });
    expect(read(join(a, "config/pricing.json"))).toBe("MINE-P");
    const b = repo({ models: "MINE-M" });
    expect(createDefaultConfigFiles(b, TEMPLATES)).toEqual({
      ok: true,
      created: ["config/pricing.json"],
    });
    expect(read(join(b, "config/models.json"))).toBe("MINE-M");
  });

  it("两个都在：什么都不写，内容不变", () => {
    const d = repo({ models: "M", pricing: "P" });
    expect(createDefaultConfigFiles(d, TEMPLATES)).toEqual({ ok: true, created: [] });
    expect(read(join(d, "config/models.json"))).toBe("M");
    expect(read(join(d, "config/pricing.json"))).toBe("P");
  });

  it("--config / BAKACODING_CONFIG 指定了配置：只建 pricing.json", () => {
    for (const [argv, env] of [
      [["--config", "/elsewhere/m.json"], {}],
      [[], { BAKACODING_CONFIG: "/elsewhere/m.json" }],
    ] as const) {
      const d = repo();
      expect(createDefaultConfigFiles(d, TEMPLATES, argv, env)).toEqual({
        ok: true,
        created: ["config/pricing.json"],
      });
      expect(existsSync(join(d, "config/models.json"))).toBe(false);
    }
  });

  it("不是 git 仓库：拒绝，一个文件都不写", () => {
    const d = repo({ git: false });
    const r = createDefaultConfigFiles(d, TEMPLATES);
    expect(r.ok).toBe(false);
    expect(existsSync(join(d, "config"))).toBe(false);
  });

  it.skipIf(!SYMLINK_OK)("config/ 或目标文件是符号链接：拒绝，不写到链接另一头", () => {
    const outside = tmp();
    const a = repo();
    symlinkSync(outside, join(a, "config"));
    expect(createDefaultConfigFiles(a, TEMPLATES)).toMatchObject({ ok: false });
    expect(existsSync(join(outside, "models.json"))).toBe(false);

    const b = repo({ pricing: "P" });
    symlinkSync(join(outside, "dangling.json"), join(b, "config/models.json"));
    expect(createDefaultConfigFiles(b, TEMPLATES)).toMatchObject({ ok: false });
    expect(existsSync(join(outside, "dangling.json"))).toBe(false);
  });

  it("模板缺失：拒绝，不建半套", () => {
    const d = repo();
    const t = tmp();
    copyFileSync(PRICING, join(t, "pricing.json"));
    expect(createDefaultConfigFiles(d, t)).toMatchObject({ ok: false });
    expect(existsSync(join(d, "config/pricing.json"))).toBe(false);
  });

  it("按钮条件与模板目录", () => {
    expect(canCreateDefaultConfig(["config/models.json", "config/pricing.json"])).toBe(true);
    expect(canCreateDefaultConfig(["config/pricing.json"])).toBe(true);
    expect(canCreateDefaultConfig([".git", "config/pricing.json"])).toBe(false);
    expect(canCreateDefaultConfig(undefined)).toBe(false);
    expect(defaultTemplateDir(true, "/opt/bc/BakaCoding.exe", "/src")).toBe(
      join("/opt/bc", "config-templates"),
    );
    expect(defaultTemplateDir(false, "/x/electron", "/src")).toBe(join("/src", "config"));
  });

  it("T-082 接上真实 ensureExcludeLines：只把本次新建的文件写进 .git/info/exclude，幂等", async () => {
    const d = repo({ pricing: "MINE-P" });
    const made = createDefaultConfigFiles(d, TEMPLATES);
    expect(made).toEqual({ ok: true, created: ["config/models.json"] });
    expect(made.ok).toBe(true);
    // main.ts 的接线就是把新建的相对路径加个前导斜杠交给 T-082
    if (made.ok)
      await ensureExcludeLines(
        d,
        made.created.map((f) => `/${f}`),
      );
    const exclude = read(join(d, ".git", "info", "exclude"));
    expect(exclude).toContain("/config/models.json");
    expect(exclude).not.toContain("/config/pricing.json");
    // 再调一次不重复写（T-082 按 git 语义判重）
    await ensureExcludeLines(d, ["/config/models.json"]);
    expect(read(join(d, ".git", "info", "exclude")).match(/\/config\/models\.json/g)).toHaveLength(
      1,
    );
  });
});

function fakeIpc() {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const ipc: IpcMainLike = {
    handle: (c, l) => void handlers.set(c, l),
    removeHandler: (c) => void handlers.delete(c),
  };
  // ipcMain.handle 的第一个参数是 event
  const invoke = (c: string, ...args: unknown[]) =>
    handlers.get(c)!({ sender: {} }, ...args) as Promise<DesktopImportResult>;
  return { ipc, handlers, invoke };
}

describe("project:createDefaultConfig IPC（T-081）", () => {
  function setup(dir: string, over: Partial<ProjectSettingsDeps> = {}) {
    const project = { project_id: "p-1", name: "p", path: dir } as Project;
    const backend = {
      switchTo: vi.fn(async () => ({ ok: true as const, project })),
      repoRoot: () => "/repo",
      prMode: () => "local" as const,
      exportDiagnostics: vi.fn(async (t: string) => t),
      status: () => ({ mode: "live" as const }),
    };
    const saveLastRepo = vi.fn();
    const ensureExcludeLines = vi.fn(async () => true);
    const { ipc, invoke, handlers } = fakeIpc();
    const stop = serveProjectSettings(ipc, {
      backend,
      argv: [],
      env: {},
      pickDirectory: async () => dir,
      pickSavePath: async () => null,
      downloadsDir: "/dl",
      saveLastRepo,
      templateDir: TEMPLATES,
      ensureExcludeLines,
      ...over,
    });
    return { invoke, backend, saveLastRepo, ensureExcludeLines, stop, handlers, project };
  }

  it("只缺配置：导入结果带按钮标记，缺失清单只说一遍并写明模板位置", async () => {
    const d = repo();
    const { invoke } = setup(d);
    const r = await invoke(IPC_CHANNELS.projectImport);
    expect(r).toEqual({
      ok: false,
      missing: ["config/models.json", "config/pricing.json"],
      reason:
        "缺少 config/models.json、config/pricing.json。模板在安装目录的 config-templates 文件夹，可点「用默认模板创建」",
      canCreateDefaultConfig: true,
    });
    expect(r.ok === false && r.reason!.match(/config\/models\.json/g)).toHaveLength(1);
  });

  it("不是 git 仓库：没有按钮标记，createDefaultConfig 拒绝且不写", async () => {
    const d = repo({ git: false });
    const { invoke } = setup(d);
    const r = await invoke(IPC_CHANNELS.projectImport);
    expect(r).not.toHaveProperty("canCreateDefaultConfig");
    const c = await invoke(IPC_CHANNELS.projectCreateDefaultConfig);
    expect(c.ok).toBe(false);
    expect(existsSync(join(d, "config"))).toBe(false);
  });

  it("没先导入就调用 / 渲染进程传路径：都不写（目录只认主进程记下的）", async () => {
    const d = repo();
    const other = repo();
    const { invoke, backend } = setup(d);
    const c = await invoke(IPC_CHANNELS.projectCreateDefaultConfig, other);
    expect(c.ok).toBe(false);
    expect(existsSync(join(other, "config"))).toBe(false);
    expect(existsSync(join(d, "config"))).toBe(false);
    expect(backend.switchTo).not.toHaveBeenCalled();
  });

  it("点按钮：建文件、只为新建的文件调 ensureExcludeLines、再校验并完成导入", async () => {
    const d = repo({ pricing: read(PRICING) });
    const { invoke, backend, saveLastRepo, ensureExcludeLines, project } = setup(d);
    await invoke(IPC_CHANNELS.projectImport);
    const r = await invoke(IPC_CHANNELS.projectCreateDefaultConfig);
    expect(r).toEqual({
      ok: true,
      project,
      note: "已用默认模板创建 config/models.json",
    });
    expect(ensureExcludeLines).toHaveBeenCalledTimes(1);
    expect(ensureExcludeLines).toHaveBeenCalledWith(d, ["/config/models.json"]);
    expect(backend.switchTo).toHaveBeenCalledWith(d);
    expect(saveLastRepo).toHaveBeenCalledWith(d);
    // 用过一次就清掉：再点不会再写
    const again = await invoke(IPC_CHANNELS.projectCreateDefaultConfig);
    expect(again.ok).toBe(false);
  });

  it("exclude 失败只提醒、不挡导入；提醒已脱敏", async () => {
    const d = repo();
    const secret = `sk-${"f00dfeed".repeat(4)}`;
    const { invoke } = setup(d, {
      env: { DEEPSEEK_API_KEY: secret },
      ensureExcludeLines: () => {
        throw new Error(`boom ${secret}`);
      },
    });
    await invoke(IPC_CHANNELS.projectImport);
    const r = await invoke(IPC_CHANNELS.projectCreateDefaultConfig);
    expect(r.ok).toBe(true);
    expect(r.ok && r.note).toContain("没能写入 .git/info/exclude");
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  it("ensureExcludeLines 返回 false（T-082 约定：不是 git 仓库、不抛错）：同样只提醒、不挡导入", async () => {
    const d = repo();
    const { invoke } = setup(d, { ensureExcludeLines: async () => false });
    await invoke(IPC_CHANNELS.projectImport);
    const r = await invoke(IPC_CHANNELS.projectCreateDefaultConfig);
    expect(r.ok).toBe(true);
    expect(r.ok && r.note).toContain("没能写入 .git/info/exclude（不是 Git 仓库）");
  });

  it("建完后内容校验不过：返回失败，不切换", async () => {
    const d = repo({ pricing: "{ not json" });
    const { invoke, backend } = setup(d);
    await invoke(IPC_CHANNELS.projectImport);
    const r = await invoke(IPC_CHANNELS.projectCreateDefaultConfig);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("pricing.json");
    expect(read(join(d, "config/pricing.json"))).toBe("{ not json");
    expect(backend.switchTo).not.toHaveBeenCalled();
  });

  it("--config / BAKACODING_CONFIG 指向的文件不存在：不给按钮，报错说指定的配置不存在", async () => {
    for (const over of [
      { argv: ["--config", "/nope/models.json"] },
      { env: { BAKACODING_CONFIG: "/nope/models.json" } },
    ]) {
      const d = repo();
      const { invoke } = setup(d, over);
      const r = await invoke(IPC_CHANNELS.projectImport);
      expect(r).not.toHaveProperty("canCreateDefaultConfig");
      expect(r.ok === false && r.reason).toContain("指定的配置，但文件不存在");
      expect((await invoke(IPC_CHANNELS.projectCreateDefaultConfig)).ok).toBe(false);
      expect(existsSync(join(d, "config"))).toBe(false);
    }
  });

  it("没注入模板目录：不给按钮", async () => {
    const d = repo();
    const { invoke } = setup(d, { templateDir: undefined });
    expect(await invoke(IPC_CHANNELS.projectImport)).not.toHaveProperty("canCreateDefaultConfig");
  });

  it("T-082 接线：只把本次新建的配置文件写进 .git/info/exclude", async () => {
    const d = repo({ pricing: read(PRICING) });
    const { invoke } = setup(d, { ensureExcludeLines });
    await invoke(IPC_CHANNELS.projectImport);
    const r = await invoke(IPC_CHANNELS.projectCreateDefaultConfig);
    expect(r.ok).toBe(true);
    const exclude = read(join(d, ".git", "info", "exclude"));
    expect(exclude).toContain("/config/models.json");
    // pricing.json 本来就有，不是本次新建的，不写
    expect(exclude).not.toContain("/config/pricing.json");
  });

  it("取消导入会清掉上次记下的目录：随后点按钮 / 再导入都不能写旧目录", async () => {
    const d = repo();
    const pickDirectory = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(d)
      .mockResolvedValueOnce(null);
    const { invoke } = setup(d, { pickDirectory });
    expect(await invoke(IPC_CHANNELS.projectImport)).toMatchObject({
      canCreateDefaultConfig: true,
    });
    expect(await invoke(IPC_CHANNELS.projectImport)).toEqual({ ok: false, canceled: true });
    expect(existsSync(join(d, "config"))).toBe(false);
    const c = await invoke(IPC_CHANNELS.projectCreateDefaultConfig);
    expect(c.ok).toBe(false);
    expect(existsSync(join(d, "config"))).toBe(false);
  });

  it("创建完仍没准备好（UI-03b needsPrep）：原样交给准备页流程，不当成成功", async () => {
    const d = repo();
    const backend = {
      switchTo: vi.fn(async () => ({
        ok: false as const,
        switched: true as const,
        needsPrep: true as const,
        reason: "不是 Git 仓库",
      })),
      repoRoot: () => d,
      prMode: () => "local" as const,
      exportDiagnostics: vi.fn(async (t: string) => t),
      status: () => ({ mode: "live" as const }),
    };
    const saveLastRepo = vi.fn();
    const { invoke } = setup(d, { backend, saveLastRepo });
    await invoke(IPC_CHANNELS.projectImport);
    const r = await invoke(IPC_CHANNELS.projectCreateDefaultConfig);
    expect(r).toMatchObject({ ok: false, needsPrep: true, reason: "不是 Git 仓库" });
    expect(r.ok === false && "note" in r && r.note).toContain("已用默认模板创建");
    expect(saveLastRepo).toHaveBeenCalledWith(d);
  });

  it("停止时注销新通道", () => {
    const { stop, handlers } = setup(repo());
    expect(handlers.has(IPC_CHANNELS.projectCreateDefaultConfig)).toBe(true);
    stop();
    expect(handlers.size).toBe(0);
  });
});
