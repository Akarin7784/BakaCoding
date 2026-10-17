import { mkdtemp, readFile, readdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSecret } from "./config.js";
import {
  SECRET_MARKER_FILE,
  clearUserSecret,
  secretStatus,
  setUserSecret,
  type SecretDeps,
  type UserEnvStore,
} from "./secrets.js";

const KEY = "sk-test-T088-0123456789abcdefWXYZ";

function fakeUserEnv(init: Record<string, string> = {}) {
  const store = new Map(Object.entries(init));
  const calls: string[] = [];
  const u: UserEnvStore & { store: Map<string, string>; failSet?: boolean; failRemove?: boolean } =
    {
      store,
      async get(n) {
        return store.get(n);
      },
      async set(n, v) {
        calls.push(`set:${n}`);
        if (u.failSet) throw new Error("boom");
        store.set(n, v);
      },
      async remove(n) {
        calls.push(`remove:${n}`);
        if (u.failRemove) throw new Error("boom");
        store.delete(n);
      },
    };
  return u;
}

let dir: string;
let markerPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bc-secrets-"));
  markerPath = join(dir, "userData", SECRET_MARKER_FILE);
});
afterEach(async () => {
  await chmod(dir, 0o700).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

const deps = (env: NodeJS.ProcessEnv, userEnv: UserEnvStore, extra: Partial<SecretDeps> = {}) => ({
  env,
  userEnv,
  markerPath,
  now: () => new Date("2026-10-18T00:00:00.000Z"),
  ...extra,
});

describe("setUserSecret", () => {
  it("写 HKCU、更新 env、写标记；getSecret 立即可读；只回末 4 位", async () => {
    const env: NodeJS.ProcessEnv = {};
    const u = fakeUserEnv();
    const r = await setUserSecret("DEEPSEEK_API_KEY", `  ${KEY}  `, deps(env, u));
    expect(r).toEqual({ ok: true, last4: "WXYZ" });
    expect(u.store.get("DEEPSEEK_API_KEY")).toBe(KEY);
    expect(getSecret("DEEPSEEK_API_KEY", env)).toBe(KEY);
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    expect(marker).toEqual({
      DEEPSEEK_API_KEY: {
        source: "bakacoding",
        saved_at: "2026-10-18T00:00:00.000Z",
        last4: "WXYZ",
      },
    });
    expect(await secretStatus("DEEPSEEK_API_KEY", deps(env, u))).toEqual({
      set: true,
      source: "bakacoding",
      last4: "WXYZ",
    });
  });

  it("值短于 8 位时不记 last4", async () => {
    const env: NodeJS.ProcessEnv = {};
    const u = fakeUserEnv();
    expect(await setUserSecret("DEEPSEEK_API_KEY", "abc1234", deps(env, u))).toEqual({ ok: true });
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    expect(marker.DEEPSEEK_API_KEY.last4).toBeUndefined();
    expect(await readFile(markerPath, "utf8")).not.toContain("1234");
    expect(await secretStatus("DEEPSEEK_API_KEY", deps(env, u))).toEqual({
      set: true,
      source: "bakacoding",
    });
  });

  it.each(["", "   ", "a\nb", "a\rb", "a\0b", "x".repeat(4097)])(
    "非法值 → invalid_value，不写任何东西",
    async (v) => {
      const env: NodeJS.ProcessEnv = {};
      const u = fakeUserEnv();
      expect(await setUserSecret("DEEPSEEK_API_KEY", v, deps(env, u))).toEqual({
        ok: false,
        reason: "invalid_value",
      });
      expect(u.store.size).toBe(0);
      expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    },
  );

  it("HKCU 写失败 → write_failed，env 不变", async () => {
    const env: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: "old-value-1234" };
    const u = fakeUserEnv({ DEEPSEEK_API_KEY: "old-value-1234" });
    u.failSet = true;
    expect(await setUserSecret("DEEPSEEK_API_KEY", KEY, deps(env, u))).toEqual({
      ok: false,
      reason: "write_failed",
    });
    expect(env.DEEPSEEK_API_KEY).toBe("old-value-1234");
    expect(u.store.get("DEEPSEEK_API_KEY")).toBe("old-value-1234");
  });

  it.skipIf(process.getuid?.() === 0)(
    "标记写失败 → 回滚 HKCU 和 env 到原值（原来有值）",
    async () => {
      await chmod(dir, 0o500);
      const env: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: "old-value-1234" };
      const u = fakeUserEnv({ DEEPSEEK_API_KEY: "old-value-1234" });
      expect(await setUserSecret("DEEPSEEK_API_KEY", KEY, deps(env, u))).toEqual({
        ok: false,
        reason: "write_failed",
      });
      expect(env.DEEPSEEK_API_KEY).toBe("old-value-1234");
      expect(u.store.get("DEEPSEEK_API_KEY")).toBe("old-value-1234");
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "标记写失败 → 回滚（原来没有值：删掉 HKCU、删掉 env）",
    async () => {
      await chmod(dir, 0o500);
      const env: NodeJS.ProcessEnv = {};
      const u = fakeUserEnv();
      expect(await setUserSecret("DEEPSEEK_API_KEY", KEY, deps(env, u))).toEqual({
        ok: false,
        reason: "write_failed",
      });
      expect("DEEPSEEK_API_KEY" in env).toBe(false);
      expect(u.store.has("DEEPSEEK_API_KEY")).toBe(false);
      await chmod(dir, 0o700);
      expect(await secretStatus("DEEPSEEK_API_KEY", deps(env, u))).toEqual({
        set: false,
        source: null,
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "非 Windows 且没注入 userEnv → unsupported_platform",
    async () => {
      const env: NodeJS.ProcessEnv = {};
      expect(await setUserSecret("DEEPSEEK_API_KEY", KEY, { env, markerPath })).toEqual({
        ok: false,
        reason: "unsupported_platform",
      });
      expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    },
  );

  it("不支持的密钥名抛错，文案不含值", async () => {
    await expect(setUserSecret("NOPE" as never, KEY, deps({}, fakeUserEnv()))).rejects.toThrow(
      /^不支持的密钥名$/,
    );
  });
});

describe("secretStatus", () => {
  it("没有标记、变量在 → system，不回 last4", async () => {
    expect(
      await secretStatus("DEEPSEEK_API_KEY", deps({ DEEPSEEK_API_KEY: KEY }, fakeUserEnv())),
    ).toEqual({
      set: true,
      source: "system",
    });
  });

  it("都没有 → 未设置", async () => {
    expect(await secretStatus("GITHUB_TOKEN", deps({}, fakeUserEnv()))).toEqual({
      set: false,
      source: null,
    });
  });

  it("标记在、变量没了 → 未设置并清掉标记", async () => {
    const env: NodeJS.ProcessEnv = {};
    const u = fakeUserEnv();
    await setUserSecret("DEEPSEEK_API_KEY", KEY, deps(env, u));
    delete env.DEEPSEEK_API_KEY;
    expect(await secretStatus("DEEPSEEK_API_KEY", deps(env, u))).toEqual({
      set: false,
      source: null,
    });
    expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual({});
  });

  it("标记在但末 4 位对不上（外面改过）→ system 并清掉标记", async () => {
    const env: NodeJS.ProcessEnv = {};
    const u = fakeUserEnv();
    await setUserSecret("DEEPSEEK_API_KEY", KEY, deps(env, u));
    env.DEEPSEEK_API_KEY = "sk-changed-outside-9999";
    expect(await secretStatus("DEEPSEEK_API_KEY", deps(env, u))).toEqual({
      set: true,
      source: "system",
    });
    expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual({});
  });

  it("标记文件损坏 → 当作没有标记", async () => {
    await writeFile(join(dir, "bad.json"), "{not json");
    expect(
      await secretStatus(
        "DEEPSEEK_API_KEY",
        deps({ DEEPSEEK_API_KEY: KEY }, fakeUserEnv(), { markerPath: join(dir, "bad.json") }),
      ),
    ).toEqual({ set: true, source: "system" });
  });

  it("两个密钥的标记互不影响", async () => {
    const env: NodeJS.ProcessEnv = {};
    const u = fakeUserEnv();
    await setUserSecret("DEEPSEEK_API_KEY", KEY, deps(env, u));
    await setUserSecret("GITHUB_TOKEN", "ghp_abcdefghijklmnop1111", deps(env, u));
    expect((await secretStatus("GITHUB_TOKEN", deps(env, u))).last4).toBe("1111");
    expect((await secretStatus("DEEPSEEK_API_KEY", deps(env, u))).last4).toBe("WXYZ");
  });
});

describe("clearUserSecret", () => {
  it("自己存的 → 清 HKCU、env、标记", async () => {
    const env: NodeJS.ProcessEnv = {};
    const u = fakeUserEnv();
    await setUserSecret("DEEPSEEK_API_KEY", KEY, deps(env, u));
    expect(await clearUserSecret("DEEPSEEK_API_KEY", deps(env, u))).toEqual({ ok: true });
    expect(u.store.has("DEEPSEEK_API_KEY")).toBe(false);
    expect("DEEPSEEK_API_KEY" in env).toBe(false);
    expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual({});
    expect(() => getSecret("DEEPSEEK_API_KEY", env)).toThrow();
  });

  it("系统环境变量 → not_owned，什么都不动", async () => {
    const env: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: KEY };
    const u = fakeUserEnv({ DEEPSEEK_API_KEY: KEY });
    expect(await clearUserSecret("DEEPSEEK_API_KEY", deps(env, u))).toEqual({
      ok: false,
      reason: "not_owned",
    });
    expect(env.DEEPSEEK_API_KEY).toBe(KEY);
    expect(u.store.get("DEEPSEEK_API_KEY")).toBe(KEY);
  });

  it("外面改过（末 4 位对不上）→ not_owned", async () => {
    const env: NodeJS.ProcessEnv = {};
    const u = fakeUserEnv();
    await setUserSecret("DEEPSEEK_API_KEY", KEY, deps(env, u));
    env.DEEPSEEK_API_KEY = "sk-changed-outside-9999";
    expect(await clearUserSecret("DEEPSEEK_API_KEY", deps(env, u))).toEqual({
      ok: false,
      reason: "not_owned",
    });
    expect(env.DEEPSEEK_API_KEY).toBe("sk-changed-outside-9999");
  });

  it("没设置 → not_set", async () => {
    expect(await clearUserSecret("DEEPSEEK_API_KEY", deps({}, fakeUserEnv()))).toEqual({
      ok: false,
      reason: "not_set",
    });
  });

  it("HKCU 删除失败 → write_failed，env 和标记不变", async () => {
    const env: NodeJS.ProcessEnv = {};
    const u = fakeUserEnv();
    await setUserSecret("DEEPSEEK_API_KEY", KEY, deps(env, u));
    u.failRemove = true;
    expect(await clearUserSecret("DEEPSEEK_API_KEY", deps(env, u))).toEqual({
      ok: false,
      reason: "write_failed",
    });
    expect(env.DEEPSEEK_API_KEY).toBe(KEY);
    expect((await secretStatus("DEEPSEEK_API_KEY", deps(env, u))).source).toBe("bakacoding");
  });
});

describe("密钥值不外泄（反向）", () => {
  it("保存 / 查询 / 清除全程：返回值、标记文件、目录里所有文件、console 都搜不到测试密钥", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const env: NodeJS.ProcessEnv = {};
    const u = fakeUserEnv();
    const results: unknown[] = [];
    results.push(await setUserSecret("DEEPSEEK_API_KEY", KEY, deps(env, u)));
    results.push(await secretStatus("DEEPSEEK_API_KEY", deps(env, u)));
    const files = await readdir(join(dir, "userData"));
    for (const f of files) {
      const text = await readFile(join(dir, "userData", f), "utf8");
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(KEY.slice(0, -4));
    }
    results.push(await clearUserSecret("DEEPSEEK_API_KEY", deps(env, u)));
    results.push(await clearUserSecret("DEEPSEEK_API_KEY", deps(env, u)));
    results.push(await setUserSecret("DEEPSEEK_API_KEY", `${KEY}\n`, deps(env, u)));
    for (const r of results) expect(JSON.stringify(r)).not.toContain(KEY.slice(0, -4));
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
  });
});
