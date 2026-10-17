// T-008：项目导入。按根目录下的清单文件识别语言，判断有没有 GitHub 远程，完成后发 project_created。
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath, stat } from "node:fs/promises";
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

/** 读 git 元数据文件的上限：正常的 config / gitdir / commondir 远小于此。 */
export const GIT_META_MAX_BYTES = 1024 * 1024;

/**
 * 安全地读一个小的 git 元数据文件：不可信项目里它可能是命名管道、指向 /dev/zero 的符号链接或超大文件。
 * 用 O_NONBLOCK 打开（管道不会卡住），fstat 要求是普通文件且不超过 GIT_META_MAX_BYTES，
 * 否则返回 undefined（按没有远程处理）。检查和读取用同一个文件描述符，中间不会被换掉。
 */
async function readGitMeta(p: string): Promise<string | undefined> {
  const fh = await open(p, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => undefined);
  if (!fh) return undefined;
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > GIT_META_MAX_BYTES) return undefined;
    const buf = Buffer.alloc(Math.min(st.size, GIT_META_MAX_BYTES) + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > GIT_META_MAX_BYTES) return undefined;
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** 找 git 的公共目录（普通仓库是 .git，worktree 跟 gitdir 和 commondir），读不到返回 undefined。 */
async function gitConfigText(root: string): Promise<string | undefined> {
  const dotGit = join(root, ".git");
  const st = await lstat(dotGit).catch(() => undefined);
  if (!st) return undefined;
  let gitDir = dotGit;
  if (!st.isDirectory()) {
    // worktree：.git 是写着 gitdir: 的普通文件（管道、设备等一律当没有）
    const text = await readGitMeta(dotGit);
    const m = text === undefined ? null : /^gitdir:\s*(.+)$/m.exec(text);
    if (!m) return undefined;
    gitDir = resolve(root, m[1]!.trim());
  }
  const c = (await readGitMeta(join(gitDir, "commondir")))?.trim();
  if (c) gitDir = isAbsolute(c) ? c : resolve(gitDir, c);
  return readGitMeta(join(gitDir, "config"));
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
