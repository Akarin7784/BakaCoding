// UI-08 主进程部分：只读详情的错误整理、主题偏好落盘（启动不闪）、window:theme 失败只回固定文案（T-105）。
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../shared/api";
import { startBackend } from "./backend";
import { backendErrorDetail } from "./backend-error";
import { serveWindowTheme, WINDOW_THEME_FAILED, type IpcMainLike } from "./ipc";
import { readSavedTheme, THEME_STORE_FILE, writeSavedTheme } from "./theme-store";

const here = dirname(fileURLToPath(import.meta.url));
const mainSrc = readFileSync(join(here, "main.ts"), "utf8");
const examplePath = join(here, "../../../../config/models.example.json");
const pricingPath = join(here, "../../../../config/pricing.json");

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

describe("只读详情：错误整理（§4.7）", () => {
  it("错误名、信息、错误码、一层 cause；路径和密钥值都遮掉", () => {
    const secret = "sk-planted-secret-value-123456";
    const cause = Object.assign(
      new Error(`open /home/eva/repo/.bakacoding/x.db failed ${secret}`),
      {
        name: "SqliteError",
      },
    );
    const e = Object.assign(
      new Error("库打不开：/home/eva/repo/.bakacoding/bakacoding.db", { cause }),
      {
        name: "StorageOpenError",
        code: "SQLITE_CANTOPEN",
      },
    );
    const d = backendErrorDetail(e, "/home/eva/repo", { DEEPSEEK_API_KEY: secret });
    expect(d.name).toBe("StorageOpenError");
    expect(d.code).toBe("SQLITE_CANTOPEN");
    expect(d.message).toContain("<仓库>");
    expect(d.message).not.toContain("/home/eva");
    expect(d.cause?.name).toBe("SqliteError");
    expect(d.cause?.message).not.toContain(secret);
    expect(d.cause?.message).not.toContain("/home/eva");
    expect(JSON.stringify(d)).not.toContain(secret);
  });

  it("错误码不是标识符就不带；错误名去掉怪字符；非 Error 也能整理", () => {
    const e = Object.assign(new Error("x"), { name: "Bad<Name>!", code: "has space" });
    const d = backendErrorDetail(e, "/r");
    expect(d.name).toBe("BadName");
    expect(d.code).toBeUndefined();
    expect(d.cause).toBeUndefined();
    expect(backendErrorDetail("plain", "/r")).toEqual({ name: "Error", message: "plain" });
    expect(Array.from(backendErrorDetail(new Error("长".repeat(5000)), "/r").message).length).toBe(
      2001,
    );
  });

  it("后端起不来时 backend:status 带 error；密钥值不出现", async () => {
    const root = tmp("bc-ui08-");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    mkdirSync(join(root, "config"), { recursive: true });
    copyFileSync(examplePath, join(root, "config", "models.json"));
    const secret = "planted-ui08-secret-VALUE";
    const backend = await startBackend({
      argv: [`--repo=${root}`],
      env: { DEEPSEEK_API_KEY: secret },
      cwd: root,
      pricingPath,
      logger: { warn: () => {} },
      openStorage: () => {
        throw Object.assign(new Error(`cannot open ${root}/.bakacoding/bakacoding.db ${secret}`), {
          name: "DiskError",
          code: "EACCES",
        });
      },
    });
    const st = backend.status();
    expect(st.mode).toBe("readonly");
    expect(st.reason).toBe("启动失败（DiskError）");
    expect(st.error).toMatchObject({ name: "DiskError", code: "EACCES" });
    expect(st.error?.message).toContain("<仓库>");
    expect(JSON.stringify(st)).not.toContain(secret);
    expect(JSON.stringify(st)).not.toContain(root);
    await backend.stop();
  });
});

describe("主题偏好落盘：启动时标题栏不闪", () => {
  it("写了读回；没有文件、坏文件、不认识的值都按跟随系统", () => {
    const dir = tmp("bc-theme-");
    expect(readSavedTheme(dir)).toBe("system");
    writeSavedTheme(dir, "dark");
    expect(readSavedTheme(dir)).toBe("dark");
    writeSavedTheme(join(dir, "nested"), "light");
    expect(readSavedTheme(join(dir, "nested"))).toBe("light");
    writeFileSync(join(dir, THEME_STORE_FILE), "{oops");
    expect(readSavedTheme(dir)).toBe("system");
    writeFileSync(join(dir, THEME_STORE_FILE), JSON.stringify({ theme: "blue" }));
    expect(readSavedTheme(dir)).toBe("system");
  });

  it("main.ts 在建窗口前同步读出偏好并设 themeSource，再按结果给叠层和底色", () => {
    const create = mainSrc.slice(mainSrc.indexOf("function createWindow"));
    const read = create.indexOf("nativeTheme.themeSource = readSavedTheme(");
    const newWin = create.indexOf("new BrowserWindow(");
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(newWin);
    expect(create.slice(newWin)).toMatch(
      /windowChromeOptions\(process\.platform, nativeTheme\.shouldUseDarkColors\)/,
    );
    // window:theme 成功后记下来
    expect(mainSrc).toMatch(/saveTheme: \(source\) => writeSavedTheme\(userData, source\)/);
  });
});

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = {
    handle: (ch, fn) => void handlers.set(ch, fn),
    removeHandler: (ch) => void handlers.delete(ch),
  };
  return { ipc, call: (...a: unknown[]) => handlers.get(IPC_CHANNELS.windowTheme)!({}, ...a) };
}

describe("window:theme：记住偏好、失败只回固定文案", () => {
  it("成功后调 saveTheme；saveTheme 抛错不算失败", () => {
    const { ipc, call } = fakeIpc();
    const saveTheme = vi.fn(() => {
      throw new Error("EROFS");
    });
    serveWindowTheme(ipc, { setThemeSource: () => true, applyTitleBar: () => {}, saveTheme });
    expect(call("dark")).toEqual({ ok: true, dark: true });
    expect(saveTheme).toHaveBeenCalledWith("dark");
  });

  it("不认识的取值不保存", () => {
    const { ipc, call } = fakeIpc();
    const saveTheme = vi.fn();
    serveWindowTheme(ipc, { setThemeSource: () => true, applyTitleBar: () => {}, saveTheme });
    call("blue");
    expect(saveTheme).not.toHaveBeenCalled();
  });

  it("T-105：失败时只回固定文案，密钥值、令牌、原始错误一概不带", () => {
    const { ipc, call } = fakeIpc();
    const secret = "planted-theme-secret-ABCDEF";
    serveWindowTheme(ipc, {
      setThemeSource: () => true,
      applyTitleBar: () => {
        throw new Error(
          `overlay failed ${secret} https://user:ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@github.com /home/eva/repo ${"x".repeat(2000)}`,
        );
      },
    });
    const r = call("dark") as { ok: false; reason: string };
    expect(r).toEqual({ ok: false, reason: WINDOW_THEME_FAILED });
    expect(r.reason).not.toContain(secret);
    expect(r.reason).not.toContain("ghp_aaaa");
    expect(r.reason).not.toContain("overlay failed");
    expect(r.reason).not.toContain("/home/eva");
  });
});
