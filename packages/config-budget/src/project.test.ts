import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectCreatedSchema } from "@bakacoding/types";
import { describe, expect, it } from "vitest";
import {
  ProjectImportError,
  detectLanguages,
  importProject,
  isGithubUrl,
  loadLanguageManifests,
  remoteUrls,
  type ProjectCreatedInput,
} from "./project.js";

async function repo(files: Record<string, string>, name = "demo"): Promise<string> {
  const root = join(await mkdtemp(join(tmpdir(), "bc-import-")), name);
  await mkdir(root, { recursive: true });
  for (const [p, c] of Object.entries(files)) {
    await mkdir(join(root, p, ".."), { recursive: true });
    await writeFile(join(root, p), c);
  }
  return root;
}

const GITHUB_CONFIG = `[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:a/b.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;

describe("detectLanguages", () => {
  it("TypeScript 优先于 JavaScript，按清单顺序列出全部语言", async () => {
    const m = await loadLanguageManifests();
    expect(detectLanguages(["package.json", "tsconfig.json", "go.mod", "README.md"], m)).toEqual({
      language: "TypeScript",
      languages: ["TypeScript", "JavaScript", "Go"],
      manifests: ["tsconfig.json", "package.json", "go.mod"],
    });
  });

  it("*.ext 按后缀匹配；什么都没命中是 unknown", async () => {
    const m = await loadLanguageManifests();
    expect(detectLanguages(["App.csproj"], m).language).toBe("C#");
    expect(detectLanguages([".csproj"], m).language).toBe("unknown");
    expect(detectLanguages(["README.md"], m)).toEqual({
      language: "unknown",
      languages: [],
      manifests: [],
    });
  });
});

describe("GitHub 远程识别", () => {
  it.each([
    ["git@github.com:a/b.git", true],
    ["https://github.com/a/b", true],
    ["https://user@GitHub.com/a/b.git", true],
    ["ssh://git@github.com:22/a/b.git", true],
    ["https://github.com.evil.example/a/b", false],
    ["https://gitlab.com/a/b", false],
    ["https://example.com/github.com/a", false],
    ["/srv/git/b.git", false],
  ])("%s → %s", (url, want) => expect(isGithubUrl(url)).toBe(want));

  it("只取 [remote] 段的 url", () => {
    const text = `[url "git@github.com:"]\n\tinsteadOf = gh:\n[remote "up"]\n  url = "https://github.com/x/y"\n[branch "main"]\n\turl = nope\n`;
    expect(remoteUrls(text)).toEqual(["https://github.com/x/y"]);
  });
});

describe("importProject（T-008）", () => {
  it("识别语言和 GitHub 远程，发一条合法的 project_created", async () => {
    const root = await repo(
      { "package.json": "{}", "tsconfig.json": "{}", ".git/config": GITHUB_CONFIG },
      "My App",
    );
    const events: ProjectCreatedInput[] = [];
    const p = await importProject(root, { publish: (e) => void events.push(e) });
    expect(p).toMatchObject({ name: "My App", language: "TypeScript", has_github_remote: true });
    expect(p.project_id).toMatch(/^my-app-[0-9a-f]{8}$/);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.requirement_id).toBeNull();
    expect(e.ticket_id).toBeNull();
    expect(e.payload).toEqual({
      project_id: p.project_id,
      name: "My App",
      language: "TypeScript",
      has_github_remote: true,
    });
    expect(
      ProjectCreatedSchema.safeParse({ ...e, seq: 0, event_id: "e1", ts: "2026-10-17T00:00:00Z" })
        .success,
    ).toBe(true);
  });

  it("同一路径重复导入（含经符号链接）得到同一个 project_id", async () => {
    const root = await repo({ "go.mod": "module x" });
    const link = `${root}-link`;
    await symlink(root, link);
    const a = await importProject(root);
    const b = await importProject(link);
    expect(b.project_id).toBe(a.project_id);
    expect(b.path).toBe(a.path);
  });

  it("不是 git 仓库、没有 GitHub 远程都算 false；不给 publish 不发事件", async () => {
    expect((await importProject(await repo({ "Cargo.toml": "" }))).has_github_remote).toBe(false);
    const gitlab = await repo({
      ".git/config": `[remote "origin"]\n\turl = https://gitlab.com/a/b\n`,
    });
    expect(await importProject(gitlab)).toMatchObject({
      has_github_remote: false,
      language: "unknown",
    });
  });

  it("worktree：跟着 .git 文件的 gitdir 和 commondir 找到主仓库的 config", async () => {
    const base = await mkdtemp(join(tmpdir(), "bc-wt-"));
    await mkdir(join(base, "main/.git/worktrees/wt"), { recursive: true });
    await writeFile(join(base, "main/.git/config"), GITHUB_CONFIG);
    await writeFile(join(base, "main/.git/worktrees/wt/commondir"), "../..\n");
    await mkdir(join(base, "wt"));
    await writeFile(join(base, "wt/.git"), `gitdir: ${join(base, "main/.git/worktrees/wt")}\n`);
    expect((await importProject(join(base, "wt"))).has_github_remote).toBe(true);
  });

  it("可以指定名字和追踪字段", async () => {
    const root = await repo({});
    const trace = { trace_id: "t1", span_id: "s1", parent_span_id: "p0" };
    const events: ProjectCreatedInput[] = [];
    const p = await importProject(root, {
      name: "笨蛋",
      trace,
      publish: (e) => void events.push(e),
    });
    expect(p.name).toBe("笨蛋");
    expect(p.project_id).toMatch(/^project-[0-9a-f]{8}$/);
    expect(events[0]).toMatchObject(trace);
  });

  it("路径不存在或不是目录时报 ProjectImportError，不发事件", async () => {
    const events: unknown[] = [];
    const publish = (e: unknown) => void events.push(e);
    await expect(importProject("/nonexistent/bc-x", { publish })).rejects.toBeInstanceOf(
      ProjectImportError,
    );
    const root = await repo({ "a.txt": "" });
    await expect(importProject(join(root, "a.txt"), { publish })).rejects.toBeInstanceOf(
      ProjectImportError,
    );
    expect(events).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "目录没有读权限（真实 EACCES）：只报错误码，不带路径",
    async () => {
      const root = await repo({ "a.txt": "" });
      await chmod(root, 0o000);
      try {
        const e = await importProject(root).catch((x: unknown) => x);
        expect(e).toBeInstanceOf(ProjectImportError);
        expect((e as Error).message).toBe("读不到项目目录（EACCES）");
      } finally {
        await chmod(root, 0o755);
      }
    },
  );

  describe("不可信项目里的 git 元数据（#52 评审）", () => {
    const fifo = (p: string) => execFileSync("mkfifo", [p]);
    const fast = { timeout: 3000 };

    it("`.git/config` 是命名管道：不卡住，按没有远程处理", fast, async () => {
      const root = await repo({ "go.mod": "" });
      await mkdir(join(root, ".git"));
      fifo(join(root, ".git/config"));
      expect((await importProject(root)).has_github_remote).toBe(false);
    });

    it("`.git/config` 指向 /dev/zero：不读，按没有远程处理", fast, async () => {
      const root = await repo({});
      await mkdir(join(root, ".git"));
      await symlink("/dev/zero", join(root, ".git/config"));
      expect((await importProject(root)).has_github_remote).toBe(false);
    });

    it("`.git/config` 超过 1 MiB：不读", fast, async () => {
      const root = await repo({ ".git/config": GITHUB_CONFIG + "#".repeat(1024 * 1024) });
      expect((await importProject(root)).has_github_remote).toBe(false);
    });

    it(
      "worktree 的 `.git` 文件是命名管道或指向 /dev/zero：不卡住，按没有远程处理",
      fast,
      async () => {
        const a = await repo({});
        fifo(join(a, ".git"));
        expect((await importProject(a)).has_github_remote).toBe(false);
        const b = await repo({});
        await symlink("/dev/zero", join(b, ".git"));
        expect((await importProject(b)).has_github_remote).toBe(false);
      },
    );

    it("commondir 是命名管道：不卡住，退回读 gitdir 自己的 config", fast, async () => {
      const root = await repo({ ".git/config": GITHUB_CONFIG });
      fifo(join(root, ".git/commondir"));
      expect((await importProject(root)).has_github_remote).toBe(true);
    });
  });
});
