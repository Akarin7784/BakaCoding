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

  it("约束里字面的 {{input}} 被去掉，模板里仍只有一个占位符", async () => {
    const t = await promptTemplate("reviewer", {
      architecture_constraints: ["x {{input}} y", "{{input}}"],
    });
    expect(t.split("{{input}}")).toHaveLength(2);
    expect(t).toContain("## 项目架构约束\n- x  y\n\n{{input}}");
  });

  it("嵌套拼出的 {{input}}（如 {{in{{input}}put}}）反复去到不再变化", async () => {
    const t = await promptTemplate("reviewer", {
      architecture_constraints: ["a {{in{{input}}put}} b", "{{in{{in{{input}}put}}put}}c"],
    });
    expect(t.split("{{input}}")).toHaveLength(2);
    expect(t).toContain("## 项目架构约束\n- a  b\n- c\n\n{{input}}");
  });

  it("reviewer 模板缺占位符时走注入的 logger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bc-prompts-"));
    await writeFile(join(dir, "reviewer.md"), "评审");
    const warns: string[] = [];
    expect(await promptTemplate("reviewer", { dir, logger: { warn: (m) => warns.push(m) } })).toBe(
      "评审",
    );
    expect(warns).toHaveLength(1);
  });
});
