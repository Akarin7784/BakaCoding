import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// stat / readdir 抛错时 Node 的 message 带完整路径：importProject 只能报错误码。
const fail = vi.hoisted(() => ({ stat: false, readdir: false }));
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  const err = (syscall: string, path: string) =>
    Object.assign(new Error(`EACCES: permission denied, ${syscall} '${path}'`), {
      code: "EACCES",
      syscall,
      path,
    });
  return {
    ...real,
    stat: ((p: string, ...rest: unknown[]) =>
      fail.stat
        ? Promise.reject(err("stat", p))
        : (real.stat as (...a: unknown[]) => unknown)(p, ...rest)) as typeof real.stat,
    readdir: ((p: string, ...rest: unknown[]) =>
      fail.readdir
        ? Promise.reject(err("scandir", p))
        : (real.readdir as (...a: unknown[]) => unknown)(p, ...rest)) as typeof real.readdir,
  };
});

const { importProject, ProjectImportError } = await import("./project.js");

afterEach(() => {
  fail.stat = false;
  fail.readdir = false;
});

describe("importProject：stat / readdir 出错只报错误码（T-099 规则）", () => {
  const secretDir = async () => mkdtemp(join(tmpdir(), "bc-secret-token-sk-abc123-"));

  it("stat 抛 EACCES：报「项目路径无法访问（EACCES）」，不带路径和原 message", async () => {
    const root = await secretDir();
    fail.stat = true;
    const e = await importProject(root).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProjectImportError);
    const msg = (e as Error).message;
    expect(msg).toBe("项目路径无法访问（EACCES）");
    expect(msg).not.toContain("bc-secret");
    expect(msg).not.toContain("permission denied");
  });

  it("readdir 抛 EACCES：报「读不到项目目录（EACCES）」，不带路径和原 message", async () => {
    const root = await secretDir();
    fail.readdir = true;
    const e = await importProject(root).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProjectImportError);
    const msg = (e as Error).message;
    expect(msg).toBe("读不到项目目录（EACCES）");
    expect(msg).not.toContain("bc-secret");
    expect(msg).not.toContain("scandir");
  });
});
