import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// T-107：密钥值只经 stdin 传给 PowerShell，启动参数和脚本文本里都不能有。
const h = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: string[]; opts: unknown; stdin: string }[],
  stdout: "",
  exitCode: 0 as number | null,
}));

vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[], opts: unknown) => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough };
    const call = { cmd, args, opts, stdin: "" };
    h.calls.push(call);
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stdin.on("data", (d: Buffer) => (call.stdin += d.toString("utf8")));
    child.stdin.on("finish", () => {
      child.stdout.end(h.stdout);
      setImmediate(() => child.emit("close", h.exitCode));
    });
    return child;
  },
}));

const { powershellUserEnv } = await import("./secrets-powershell.js");
const { setUserSecret, clearUserSecret } = await import("./secrets.js");

const KEY = "sk-test-T107-stdin-only-0123456789QRST";
const allText = (c: (typeof h.calls)[number]) =>
  [c.cmd, ...c.args, JSON.stringify(c.opts)].join("\n");

beforeEach(() => {
  h.calls.length = 0;
  h.stdout = "";
  h.exitCode = 0;
});

describe("powershellUserEnv", () => {
  it("set：值只在 stdin 里，启动参数 / 脚本 / 选项里都没有", async () => {
    await powershellUserEnv().set("DEEPSEEK_API_KEY", KEY);
    expect(h.calls).toHaveLength(1);
    const c = h.calls[0]!;
    expect(c.cmd).toBe("powershell.exe");
    expect(allText(c)).not.toContain(KEY);
    expect(allText(c)).not.toContain(KEY.slice(0, -4));
    expect(c.stdin).toBe(KEY);
    expect(c.args.at(-1)).toContain("'DEEPSEEK_API_KEY'");
    expect(c.args.at(-1)).toContain("[Console]::In.ReadToEnd()");
  });

  it("get / remove：不带值，stdin 为空", async () => {
    h.stdout = `1${KEY}`;
    const u = powershellUserEnv();
    expect(await u.get("GITHUB_TOKEN")).toBe(KEY);
    h.stdout = "";
    expect(await u.get("GITHUB_TOKEN")).toBeUndefined();
    await u.remove("GITHUB_TOKEN");
    for (const c of h.calls) {
      expect(allText(c)).not.toContain(KEY);
      expect(c.stdin).toBe("");
      expect(c.args.at(-1)).toContain("'GITHUB_TOKEN'");
    }
  });

  it.each(["NOPE", "DEEPSEEK_API_KEY'); Remove-Item C:\\ #", ""])(
    "名字不在白名单里直接拒绝，不启动 PowerShell：%s",
    async (bad) => {
      const u = powershellUserEnv();
      await expect(u.set(bad as never, KEY)).rejects.toThrow(/^不支持的密钥名$/);
      await expect(u.get(bad as never)).rejects.toThrow(/^不支持的密钥名$/);
      await expect(u.remove(bad as never)).rejects.toThrow(/^不支持的密钥名$/);
      expect(h.calls).toHaveLength(0);
    },
  );

  it("非 0 退出：错误只有退出码，不带值", async () => {
    h.exitCode = 1;
    const err = await powershellUserEnv()
      .set("DEEPSEEK_API_KEY", KEY)
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("PowerShell 退出码 1");
  });
});

describe("Windows 默认路径（setUserSecret / clearUserSecret 不注入 userEnv）", () => {
  let dir: string;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bc-t107-"));
    Object.defineProperty(process, "platform", { value: "win32" });
  });
  afterEach(async () => {
    Object.defineProperty(process, "platform", platform);
    await rm(dir, { recursive: true, force: true });
  });

  it("保存再清除：每次启动 PowerShell 的参数里都没有密钥值，值只在 set 的 stdin 里出现一次", async () => {
    const env: NodeJS.ProcessEnv = {};
    const markerPath = join(dir, "secret-markers.json");
    expect(await setUserSecret("DEEPSEEK_API_KEY", KEY, { env, markerPath })).toEqual({
      ok: true,
      last4: "QRST",
    });
    expect(await clearUserSecret("DEEPSEEK_API_KEY", { env, markerPath })).toEqual({ ok: true });
    expect(h.calls.length).toBeGreaterThanOrEqual(3); // get 旧值、set、remove
    for (const c of h.calls) expect(allText(c)).not.toContain(KEY);
    expect(h.calls.filter((c) => c.stdin.includes(KEY))).toHaveLength(1);
  });

  it("不支持的名字：不启动 PowerShell", async () => {
    await expect(
      setUserSecret("NOPE" as never, KEY, { env: {}, markerPath: join(dir, "m.json") }),
    ).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
  });
});
