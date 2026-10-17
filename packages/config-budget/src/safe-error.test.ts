import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "./config.js";
import { loadPricing } from "./pricing.js";
import { importProject, loadLanguageManifests, ProjectImportError } from "./project.js";
import { PromptTemplateError, promptTemplate } from "./prompts.js";

// T-099：模块 3 其余读文件的错误也不带原值、文件内容和完整路径
const SECRET = "sk-mySecretishValue12345";
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const tmp = async (prefix = "bc-t099-") => {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const put = async (name: string, text: string) => {
  const dir = await tmp();
  const p = join(dir, name);
  await writeFile(p, text);
  return { dir, p };
};
const clean = (msg: string, ...raws: string[]) => {
  for (const r of raws) expect(msg).not.toContain(r);
  expect(msg).not.toMatch(/received|is not valid JSON|Unexpected token/i);
};
const caught = async (fn: () => unknown): Promise<Error> => {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("应当抛错");
};

describe("loadPricing（T-099）", () => {
  it("坏 JSON：ConfigError，只报行列号", async () => {
    const { p, dir } = await put("pricing.json", `{\n  "x": "${SECRET}" y\n}`);
    const e = await caught(() => loadPricing(p));
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as ConfigError).errors).toEqual([
      "价格表 pricing.json 不是合法 JSON（第 2 行第 35 列）",
    ]);
    clean(e.message, SECRET, dir);
  });
  it("整个文件是密钥：只说不是合法 JSON", async () => {
    const { p } = await put("pricing.json", SECRET);
    const e = await caught(() => loadPricing(p));
    expect((e as ConfigError).errors).toEqual(["价格表 pricing.json 不是合法 JSON"]);
    clean(e.message, SECRET, "sk-");
  });
  it("校验失败：怪值和像密钥的键名都不出现", async () => {
    const { p } = await put("pricing.json", JSON.stringify({ [SECRET]: SECRET, currency: SECRET }));
    const e = await caught(() => loadPricing(p));
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as ConfigError).errors.length).toBeGreaterThan(0);
    for (const m of (e as ConfigError).errors) expect(m.startsWith("pricing.json ")).toBe(true);
    clean(e.message, SECRET);
  });
  it("读不到：只报文件名和错误码", async () => {
    const e = await caught(() => loadPricing("/nonexistent/dir-abc/pricing.json"));
    expect((e as ConfigError).errors).toEqual(["无法读取价格表 pricing.json（ENOENT）"]);
    clean(e.message, "dir-abc");
  });
});

describe("loadLanguageManifests（T-099）", () => {
  it("坏 JSON：ProjectImportError，只报行列号", async () => {
    const { p, dir } = await put("languages.json", `{"languages": ${SECRET}}`);
    const e = await caught(() => loadLanguageManifests(p));
    expect(e).toBeInstanceOf(ProjectImportError);
    expect(e.message).toMatch(/^语言清单 languages\.json 不是合法 JSON/);
    clean(e.message, SECRET, dir);
  });
  it("校验失败：怪值和像密钥的键名都不出现", async () => {
    const { p } = await put(
      "languages.json",
      JSON.stringify({ languages: [{ language: 1, files: SECRET, [SECRET]: 1 }] }),
    );
    const e = await caught(() => loadLanguageManifests(p));
    expect(e).toBeInstanceOf(ProjectImportError);
    expect(e.message).toMatch(/^语言清单 languages\.json 格式不对：/);
    clean(e.message, SECRET);
  });
  it("读不到：只报文件名和错误码", async () => {
    const e = await caught(() => loadLanguageManifests("/nonexistent/dir-abc/languages.json"));
    expect(e.message).toBe("读不到语言清单 languages.json（ENOENT）");
  });
});

describe("importProject 路径错误（T-099）", () => {
  it("路径不存在：不带路径和 String(e)", async () => {
    const e = await caught(() => importProject("/nonexistent/dir-abc/proj"));
    expect(e).toBeInstanceOf(ProjectImportError);
    expect(e.message).toBe("项目路径不存在或无法访问（ENOENT）");
  });
  it("不是目录：不带路径", async () => {
    const { p, dir } = await put("a.txt", "");
    const e = await caught(() => importProject(p));
    expect(e.message).toBe("项目路径不是目录");
    clean(e.message, dir);
  });
});

describe("promptTemplate 读不到（T-099）", () => {
  it("只报角色、文件名和错误码", async () => {
    const dir = await tmp("bc-t099-secret-dir-");
    const e = await caught(() => promptTemplate("coder", { dir }));
    expect(e).toBeInstanceOf(PromptTemplateError);
    expect(e.message).toBe("读不到 coder 的提示词模板 coder.md（ENOENT）");
    clean(e.message, dir, "Error:");
  });
});
