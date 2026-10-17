// T-008：项目导入。按根目录下的清单文件识别语言，判断有没有 GitHub 远程，完成后发 project_created。
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { EventOf, Trace } from "@bakacoding/types";
import { PROMPTS_DIR } from "./prompts.js";

export interface Project {
  /** `<名称 slug>-<真实路径 sha256 前 8 位>`：同一路径重复导入得到同一个 id（2 落库 INSERT OR IGNORE） */
  project_id: string;
  name: string;
  /** 真实路径（解析过符号链接） */
  path: string;
  /** 主语言：第一个命中的清单对应的语言；都没命中为 "unknown" */
  language: string;
  /** 所有命中的语言，按识别顺序 */
  languages: string[];
  /** 命中的清单文件名，按识别顺序 */
  manifests: string[];
  has_github_remote: boolean;
}

/** project_created 的发布入参：形状同 0 的 `PublishInput`（seq / event_id / ts 由总线补）。 */
export type ProjectCreatedInput = Omit<EventOf<"project_created">, "seq" | "event_id" | "ts">;

export interface ImportProjectOptions {
  /** 发 project_created，通常传 `(e) => bus.publish(e)`；不传就只返回 project、不发事件 */
  publish?: (event: ProjectCreatedInput) => unknown;
  /** 事件的追踪字段；不传就新开一条 trace（parent_span_id 为 null） */
  trace?: Trace;
  /** 项目名，默认取目录名 */
  name?: string;
  /** 语言识别清单，默认读 prompts/languages.json */
  languagesFile?: string;
}

export class ProjectImportError extends Error {
  override name = "ProjectImportError";
}

const LanguagesSchema = z
  .object({
    languages: z
      .array(
        z
          .object({ language: z.string().min(1), files: z.array(z.string().min(1)).min(1) })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type LanguageManifests = z.infer<typeof LanguagesSchema>["languages"];

export const LANGUAGES_FILE = join(PROMPTS_DIR, "languages.json");
export const UNKNOWN_LANGUAGE = "unknown";

export async function loadLanguageManifests(file = LANGUAGES_FILE): Promise<LanguageManifests> {
  return LanguagesSchema.parse(JSON.parse(await readFile(file, "utf8"))).languages;
}

/** 只看根目录（不递归）：普通文件名精确匹配，`*.ext` 按后缀匹配。 */
export function detectLanguages(
  entries: readonly string[],
  manifests: LanguageManifests,
): { language: string; languages: string[]; manifests: string[] } {
  const names = [...entries].sort();
  const languages: string[] = [];
  const hit: string[] = [];
  for (const { language, files } of manifests) {
    for (const f of files) {
      const found = f.startsWith("*.")
        ? names.filter((n) => n.length > f.length - 1 && n.endsWith(f.slice(1)))
        : names.filter((n) => n === f);
      if (found.length === 0) continue;
      if (!languages.includes(language)) languages.push(language);
      for (const n of found) if (!hit.includes(n)) hit.push(n);
    }
  }
  return { language: languages[0] ?? UNKNOWN_LANGUAGE, languages, manifests: hit };
}

const GITHUB_URL =
  /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|[^@/\s]+@github\.com:)/i;

/** 远程 URL 是否指向 github.com（https / ssh / scp 写法）。 */
export function isGithubUrl(url: string): boolean {
  return GITHUB_URL.test(url.trim());
}

/** 从 git config 文本里取出所有 [remote "…"] 段的 url。 */
export function remoteUrls(configText: string): string[] {
  const urls: string[] = [];
  let inRemote = false;
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inRemote = /^\[\s*remote\s+"[^"]*"\s*\]/i.test(line);
      continue;
    }
    if (!inRemote) continue;
    const m = /^url\s*=\s*(.*)$/i.exec(line);
    if (m) urls.push(m[1]!.replace(/^"(.*)"$/, "$1"));
  }
  return urls;
}

async function isFile(p: string): Promise<boolean> {
  return (await stat(p).catch(() => undefined))?.isFile() ?? false;
}

/** 找 git 的公共目录（普通仓库是 .git，worktree 跟 gitdir 和 commondir），读不到返回 undefined。 */
async function gitConfigText(root: string): Promise<string | undefined> {
  const dotGit = join(root, ".git");
  const st = await stat(dotGit).catch(() => undefined);
  if (!st) return undefined;
  let gitDir = dotGit;
  if (st.isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8"));
    if (!m) return undefined;
    gitDir = resolve(root, m[1]!.trim());
  }
  const common = join(gitDir, "commondir");
  if (await isFile(common)) {
    const c = (await readFile(common, "utf8")).trim();
    gitDir = isAbsolute(c) ? c : resolve(gitDir, c);
  }
  return readFile(join(gitDir, "config"), "utf8").catch(() => undefined);
}

function slug(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .toLowerCase();
  return s || "project";
}

/**
 * 导入项目：只读不写，不要求是 git 仓库。识别语言、判断 GitHub 远程，
 * 给了 `publish` 时发 project_created（requirement_id、ticket_id 为 null）。
 */
export async function importProject(
  path: string,
  opts: ImportProjectOptions = {},
): Promise<Project> {
  let root: string;
  try {
    root = await realpath(resolve(path));
  } catch (e) {
    throw new ProjectImportError(`项目路径不存在：${path}（${String(e)}）`);
  }
  if (!(await stat(root)).isDirectory()) throw new ProjectImportError(`项目路径不是目录：${root}`);
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((d) => d.isFile() || d.isSymbolicLink())
    .map((d) => d.name);
  const detected = detectLanguages(entries, await loadLanguageManifests(opts.languagesFile));
  const config = await gitConfigText(root);
  const has_github_remote = config ? remoteUrls(config).some(isGithubUrl) : false;
  const name = (opts.name ?? basename(root)).trim() || "project";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  const project: Project = {
    project_id: `${slug(name)}-${hash}`,
    name,
    path: root,
    ...detected,
    has_github_remote,
  };
  if (opts.publish) {
    const trace = opts.trace ?? {
      trace_id: randomUUID(),
      span_id: randomUUID(),
      parent_span_id: null,
    };
    await opts.publish({
      type: "project_created",
      ...trace,
      requirement_id: null,
      ticket_id: null,
      payload: {
        project_id: project.project_id,
        name: project.name,
        language: project.language,
        has_github_remote,
      },
    });
  }
  return project;
}
