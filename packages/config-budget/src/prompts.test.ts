import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROLES } from "@bakacoding/types";
import { describe, expect, it } from "vitest";
import { PROMPTS_DIR, PromptTemplateError, promptTemplate } from "./prompts.js";

describe("promptTemplate（T-008）", () => {
  it("四个角色都有内置模板，非空且每次逐字节相同", async () => {
    for (const role of ROLES) {
      const a = await promptTemplate(role);
      expect(a.length).toBeGreaterThan(0);
      expect(await promptTemplate(role)).toBe(a);
      expect(a).not.toMatch(/\r/);
    }
  });

  it("reviewer 模板带一个 {{input}} 占位符", async () => {
    const t = await promptTemplate("reviewer");
    expect(t.split("{{input}}")).toHaveLength(2);
  });

  it("架构约束放在 {{input}} 前面", async () => {
    const t = await promptTemplate("reviewer", {
      architecture_constraints: ["只用 zod 校验", "  "],
    });
    const at = t.indexOf("## 项目架构约束\n- 只用 zod 校验");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(t.indexOf("{{input}}"));
    expect(t).not.toContain("- \n");
  });

  it("没有 {{input}} 的模板，约束接在末尾；没给约束时原样返回", async () => {
    const plain = await promptTemplate("coder");
    expect(await promptTemplate("coder", { architecture_constraints: [] })).toBe(plain);
    const withC = await promptTemplate("coder", { architecture_constraints: ["a"] });
    expect(withC).toBe(`${plain}\n\n## 项目架构约束\n- a`);
  });

  it("自定义目录：去 BOM、CRLF 换成 LF、去首尾空白", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-prompts-"));
    await writeFile(join(dir, "coder.md"), "\uFEFF\r\n第一行\r\n第二行\r\n\r\n");
    expect(await promptTemplate("coder", { dir })).toBe("第一行\n第二行");
  });

  it("未知角色、缺文件都报 PromptTemplateError", async () => {
    await expect(promptTemplate("boss" as never)).rejects.toBeInstanceOf(PromptTemplateError);
    const dir = await mkdtemp(join(tmpdir(), "bc-prompts-"));
    await expect(promptTemplate("coder", { dir })).rejects.toBeInstanceOf(PromptTemplateError);
  });

  it("内置目录就是包里的 prompts/", async () => {
    expect(await readFile(join(PROMPTS_DIR, "languages.json"), "utf8")).toContain("TypeScript");
  });
});
