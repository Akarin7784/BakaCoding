import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildPackage, PACKAGE_FILES } from "./build.js";
import { safeZipPath } from "./redaction.js";
import { readZip, writeZip, type ZipEntry } from "./zip.js";
import {
  READABLE_DIAG_SCHEMAS,
  type DiagManifest,
  type DiagPackage,
  type ExportDeps,
  type ExportOptions,
} from "./schema.js";

const jsonl = (rows: unknown[]): string => rows.map((x) => `${JSON.stringify(x)}\n`).join("");
const parseJsonl = <T>(s: string): T[] =>
  s
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);

/** 把内存中的诊断包序列化为 zip 字节：JSONL + 原始文件。 */
export function packageToZip(pkg: DiagPackage): Buffer {
  const text = (name: string, s: string): ZipEntry => ({ name, data: Buffer.from(s, "utf8") });
  const entries: ZipEntry[] = [
    text(PACKAGE_FILES.manifest, `${JSON.stringify(pkg.manifest, null, 2)}\n`),
    text(PACKAGE_FILES.events, jsonl(pkg.events)),
    text(PACKAGE_FILES.tickets, jsonl(pkg.tickets)),
    text(PACKAGE_FILES.costs, jsonl(pkg.costs)),
    text(PACKAGE_FILES.redaction_report, `${JSON.stringify(pkg.redaction_report, null, 2)}\n`),
    ...pkg.raw_files.map((f) => text(f.path, f.content)),
  ];
  return writeZip(entries, new Date(pkg.manifest.created_at));
}

/** 从 zip 字节读回诊断包；接受 bakacoding-diag/v1 和 v1.1，其他 schema 报错。 */
export function zipToPackage(buf: Buffer): DiagPackage {
  const entries = new Map(readZip(buf).map((e) => [e.name, e.data.toString("utf8")]));
  const get = (name: string): string => {
    const v = entries.get(name);
    if (v === undefined) throw new Error(`诊断包缺少 ${name}`);
    return v;
  };
  const manifest = JSON.parse(get(PACKAGE_FILES.manifest)) as DiagManifest;
  if (!(READABLE_DIAG_SCHEMAS as readonly string[]).includes(manifest.schema)) {
    throw new Error(`不支持的诊断包 schema：${String(manifest.schema)}`);
  }
  const fixed = new Set<string>(Object.values(PACKAGE_FILES));
  return {
    manifest,
    events: parseJsonl(get(PACKAGE_FILES.events)),
    tickets: parseJsonl(get(PACKAGE_FILES.tickets)),
    costs: parseJsonl(get(PACKAGE_FILES.costs)),
    redaction_report: JSON.parse(get(PACKAGE_FILES.redaction_report)),
    raw_files: [...entries]
      .filter(([name]) => !fixed.has(name))
      .map(([path, content]) => ({ path, content })),
  };
}

export async function readPackage(zip_path: string): Promise<DiagPackage> {
  return zipToPackage(await readFile(zip_path));
}

function zipFileName(m: DiagManifest): string {
  const s = m.scope;
  const id = s.kind === "ticket" ? s.ticket_id : s.kind === "requirement" ? s.requirement_id : "";
  const stamp = m.created_at.replace(/[:.]/g, "").replace(/-/g, "");
  const parts = ["bakacoding-diag", m.project_id, s.kind, id, stamp].filter((x) => x !== "");
  return `${safeZipPath(parts.join("-")).replace(/\//g, "_")}.zip`;
}

/**
 * modules.md 11：export({ project_id, scope, include_full_repo }) → zip_path。
 * 导出前做完整脱敏，附脱敏报告；默认只带 diff 和上下文片段。
 */
export async function exportPackage(opts: ExportOptions, deps: ExportDeps): Promise<string> {
  const pkg = await buildPackage(opts, deps);
  await mkdir(deps.out_dir, { recursive: true });
  const zip_path = join(deps.out_dir, zipFileName(pkg.manifest));
  await writeFile(zip_path, packageToZip(pkg));
  return zip_path;
}
