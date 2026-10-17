import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionList } from "@bakacoding/types";
import { FILE_TOOL_DEFINITIONS, FILE_TOOL_NAMES, createTools, type ToolResult } from "./tools.js";
import { isProtectedPath, permissionFor } from "./guard.js";

let base: string;
let ws: string;
let outside: string;
const RW: PermissionList = [{ glob: "**", level: "rw" }];
const A_TS = "const a = 1;\nconst b = 2;\n";

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "bc-tools-")));
  ws = join(base, "ws");
  outside = join(base, "outside");
  mkdirSync(join(ws, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(ws, "src", "a.ts"), A_TS);
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const tools = (list: PermissionList = RW) =>
  createTools({ ticket_id: "T-1", worktree_path: ws, permission_list: list });

function err(r: ToolResult): { code: string; message: string } {
  if (r.ok) throw new Error(`expected failure, got: ${r.output}`);
  return { code: r.code, message: r.message };
}
function ok(r: ToolResult): string {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.output;
}
const outsideUntouched = (): void => {
  expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("TOP SECRET\n");
  expect(existsSync(join(outside, "new.txt"))).toBe(false);
};
const readWs = (p: string): string => readFileSync(join(ws, p), "utf8");

describe("工具定义", () => {
  it("名称与参数对齐 harness", () => {
    expect(FILE_TOOL_DEFINITIONS.map((d) => d.name)).toEqual([...FILE_TOOL_NAMES]);
    const props = (n: string): string[] => {
      const d = FILE_TOOL_DEFINITIONS.find((x) => x.name === n);
      return Object.keys((d?.input_schema as { properties: object }).properties);
    };
    expect(props("read")).toEqual(["file_path", "offset", "limit"]);
    expect(props("write")).toEqual(["file_path", "content"]);
    expect(props("edit")).toEqual(["file_path", "old_string", "new_string", "replace_all"]);
    expect(props("glob")).toEqual(["pattern", "path"]);
    expect(props("grep")).toEqual(["pattern", "path", "include"]);
  });
});

describe("read / write / edit", () => {
  it("read 返回带行号的内容，支持 offset/limit", async () => {
    const t = tools();
    expect(ok(await t.read({ file_path: "src/a.ts" }))).toBe(
      "<path>src/a.ts</path>\n<type>file</type>\n<content>\n1: const a = 1;\n2: const b = 2;\n\n(End of file - total 2 lines)\n</content>",
    );
    const part = ok(await t.read({ file_path: "./src/a.ts", offset: 2, limit: 1 }));
    expect(part).toContain("2: const b = 2;");
    expect(ok(await t.read({ file_path: "src/a.ts", limit: 1 }))).toContain(
      "(Showing lines 1-1 of 2. Use offset=2 to continue.)",
    );
    expect(err(await t.read({ file_path: "src/a.ts", offset: 9 })).code).toBe("FS_NOT_FOUND");
    expect(err(await t.read({ file_path: "" })).message).toBe("file_path must be a non-empty string");
    expect(err(await t.read({ file_path: "nope.ts" })).code).toBe("FS_NOT_FOUND");
    expect(err(await t.read("src/a.ts")).code).toBe("FS_INVALID_INPUT");
  });

  it("新文件可直接 write（建父目录）；已存在的文件不读不能改", async () => {
    const t = tools();
    ok(await t.write({ file_path: "src/new/b.ts", content: "x\n" }));
    expect(readWs("src/new/b.ts")).toBe("x\n");
    const e = err(await t.write({ file_path: "src/a.ts", content: "y" }));
    expect(e).toEqual({
      code: "FS_NOT_OBSERVED",
      message: 'cannot modify "src/a.ts": file has not been read — read the file, then retry',
    });
    expect(err(await t.edit({ file_path: "src/a.ts", old_string: "1", new_string: "3" })).code).toBe(
      "FS_NOT_OBSERVED",
    );
    expect(readWs("src/a.ts")).toBe(A_TS);
    ok(await t.read({ file_path: "src/a.ts" }));
    ok(await t.write({ file_path: "src/a.ts", content: "y\n" }));
    ok(await t.write({ file_path: "src/a.ts", content: "z\n" }));
    expect(readWs("src/a.ts")).toBe("z\n");
  });

  it("读后被外部改动报 FS_STALE_VERSION，文件不动", async () => {
    const t = tools();
    ok(await t.read({ file_path: "src/a.ts" }));
    writeFileSync(join(ws, "src/a.ts"), "changed\n");
    utimesSync(join(ws, "src/a.ts"), new Date(), new Date(Date.now() + 5000));
    const e = err(await t.edit({ file_path: "src/a.ts", old_string: "changed", new_string: "z" }));
    expect(e).toEqual({
      code: "FS_STALE_VERSION",
      message: 'cannot edit "src/a.ts": file changed since it was read — re-read the file, then retry',
    });
    expect(err(await t.write({ file_path: "src/a.ts", content: "z" })).code).toBe("FS_STALE_VERSION");
    expect(readWs("src/a.ts")).toBe("changed\n");
  });

  it("另一套工具（另一张单）的已读记录不互通", async () => {
    ok(await tools().read({ file_path: "src/a.ts" }));
    expect(err(await tools().write({ file_path: "src/a.ts", content: "x" })).code).toBe("FS_NOT_OBSERVED");
  });

  it("edit：未找到、多处匹配、replace_all，失败时文件不动，替换串不做 $ 展开", async () => {
    const t = tools();
    writeFileSync(join(ws, "m.txt"), "foo\nfoo\nbar\n");
    ok(await t.read({ file_path: "m.txt" }));
    expect(err(await t.edit({ file_path: "m.txt", old_string: "baz", new_string: "q" }))).toEqual({
      code: "FS_EDIT_NOT_FOUND",
      message: 'old_string was not found in "m.txt"',
    });
    expect(err(await t.edit({ file_path: "m.txt", old_string: "", new_string: "q" }))).toEqual({
      code: "FS_EDIT_NOT_FOUND",
      message: "old_string must be a non-empty string",
    });
    expect(err(await t.edit({ file_path: "m.txt", old_string: "foo", new_string: "q" }))).toEqual({
      code: "FS_AMBIGUOUS_EDIT",
      message:
        'old_string matched 2 times in "m.txt"; provide a more specific old_string or set replace_all to true',
    });
    expect(readWs("m.txt")).toBe("foo\nfoo\nbar\n");
    ok(await t.edit({ file_path: "m.txt", old_string: "bar", new_string: "$&$1" }));
    expect(ok(await t.edit({ file_path: "m.txt", old_string: "foo", new_string: "q", replace_all: true }))).toBe(
      'Edited "m.txt": replaced 2 occurrences',
    );
    expect(readWs("m.txt")).toBe("q\nq\n$&$1\n");
  });

  it("CRLF 文件按 LF 匹配，写回保留 CRLF", async () => {
    const t = tools();
    writeFileSync(join(ws, "w.txt"), "a\r\nb\r\n");
    ok(await t.read({ file_path: "w.txt" }));
    ok(await t.edit({ file_path: "w.txt", old_string: "a\nb", new_string: "a\nc" }));
    expect(readWs("w.txt")).toBe("a\r\nc\r\n");
  });

  it("二进制文件和目录不读", async () => {
    writeFileSync(join(ws, "bin.dat"), Buffer.from([1, 0, 2]));
    expect(err(await tools().read({ file_path: "bin.dat" })).code).toBe("FS_NOT_TEXT");
    expect(err(await tools().read({ file_path: "src" })).code).toBe("FS_NOT_A_FILE");
  });
});

describe("外层硬边界", () => {
  it("../ 穿越被拒，工作区外文件不动", async () => {
    const t = tools();
    const paths = ["../outside/secret.txt", "src/../../outside/secret.txt", "..", "..\\outside\\secret.txt"];
    for (const p of paths) {
      expect(err(await t.read({ file_path: p })).code).toBe("FS_OUTSIDE_WORKSPACE");
      expect(err(await t.write({ file_path: p, content: "pwned" })).code).toBe("FS_OUTSIDE_WORKSPACE");
      expect(err(await t.edit({ file_path: p, old_string: "TOP", new_string: "x" })).code).toBe(
        "FS_OUTSIDE_WORKSPACE",
      );
    }
    expect(err(await t.write({ file_path: "../outside/new.txt", content: "x" })).code).toBe(
      "FS_OUTSIDE_WORKSPACE",
    );
    expect(err(await t.glob({ pattern: "*", path: ".." })).code).toBe("FS_OUTSIDE_WORKSPACE");
    expect(err(await t.grep({ pattern: "SECRET", path: "../outside" })).code).toBe("FS_OUTSIDE_WORKSPACE");
    outsideUntouched();
  });

  it("绝对路径一律拒绝（含指向工作区内的绝对路径、Windows 盘符）", async () => {
    const t = tools();
    const paths = [join(outside, "secret.txt"), join(ws, "src/a.ts"), "/etc/passwd", "C:\\Windows\\x", "C:/x"];
    for (const p of paths) {
      expect(err(await t.read({ file_path: p })).code).toBe("FS_OUTSIDE_WORKSPACE");
    }
    expect(err(await t.write({ file_path: join(outside, "new.txt"), content: "x" })).code).toBe(
      "FS_OUTSIDE_WORKSPACE",
    );
    expect(err(await t.grep({ pattern: "x", path: outside })).code).toBe("FS_OUTSIDE_WORKSPACE");
    outsideUntouched();
  });

  it("指向工作区外的文件符号链接：读、写、改都拒，glob/grep 不收录", async () => {
    symlinkSync(join(outside, "secret.txt"), join(ws, "link.txt"));
    const t = tools();
    expect(err(await t.read({ file_path: "link.txt" })).code).toBe("FS_OUTSIDE_WORKSPACE");
    expect(err(await t.write({ file_path: "link.txt", content: "pwned" })).code).toBe("FS_OUTSIDE_WORKSPACE");
    expect(err(await t.edit({ file_path: "link.txt", old_string: "TOP", new_string: "x" })).code).toBe(
      "FS_OUTSIDE_WORKSPACE",
    );
    expect(ok(await t.glob({ pattern: "*.txt" }))).toBe("No files found");
    expect(ok(await t.grep({ pattern: "SECRET" }))).toBe("No matches found");
    outsideUntouched();
  });

  it("中间目录是指向工作区外的符号链接：读、写、新建都拒", async () => {
    symlinkSync(outside, join(ws, "src", "out"));
    const t = tools();
    expect(err(await t.read({ file_path: "src/out/secret.txt" })).code).toBe("FS_OUTSIDE_WORKSPACE");
    expect(err(await t.write({ file_path: "src/out/new.txt", content: "x" })).code).toBe(
      "FS_OUTSIDE_WORKSPACE",
    );
    expect(err(await t.write({ file_path: "src/out/deep/new.txt", content: "x" })).code).toBe(
      "FS_OUTSIDE_WORKSPACE",
    );
    expect(err(await t.glob({ pattern: "*", path: "src/out" })).code).toBe("FS_OUTSIDE_WORKSPACE");
    expect(ok(await t.grep({ pattern: "SECRET" }))).toBe("No matches found");
    expect(existsSync(join(outside, "deep"))).toBe(false);
    outsideUntouched();
  });

  it("悬空符号链接不能借道在外面新建文件", async () => {
    symlinkSync(join(outside, "new.txt"), join(ws, "dangling.txt"));
    const t = tools();
    expect(err(await t.write({ file_path: "dangling.txt", content: "x" })).code).toBe("FS_OUTSIDE_WORKSPACE");
    outsideUntouched();
  });

  it("工作区内的符号链接可用，权限按链接路径和真实路径都判", async () => {
    symlinkSync(join(ws, "src", "a.ts"), join(ws, "alias.ts"));
    const t = tools([
      { glob: "**", level: "rw" },
      { glob: "src/**", level: "ro" },
    ]);
    expect(ok(await t.read({ file_path: "alias.ts" }))).toContain("1: const a = 1;");
    expect(err(await t.write({ file_path: "alias.ts", content: "x" })).code).toBe("FS_PERMISSION_DENIED");
    expect(readWs("src/a.ts")).toBe(A_TS);
  });

  it(".env、.git、私钥即使权限清单给 rw 也不放行", async () => {
    writeFileSync(join(ws, ".env"), "KEY=1\n");
    writeFileSync(join(ws, ".ENV.local"), "KEY=1\n");
    mkdirSync(join(ws, ".git"));
    writeFileSync(join(ws, ".git", "config"), "[core]\n");
    symlinkSync(join(ws, ".env"), join(ws, "env-alias.txt"));
    const t = tools();
    const paths = [".env", ".ENV.local", ".envrc", "sub/.env.production", ".git/config", "id_rsa", "certs/server.pem", "env-alias.txt"];
    for (const p of paths) {
      expect(err(await t.read({ file_path: p })).code).toBe("FS_PROTECTED_PATH");
      expect(err(await t.write({ file_path: p, content: "x" })).code).toBe("FS_PROTECTED_PATH");
    }
    expect(err(await t.glob({ pattern: "*", path: ".git" })).code).toBe("FS_PROTECTED_PATH");
    expect(ok(await t.glob({ pattern: "**/*" }))).toBe("src/a.ts");
    expect(ok(await t.grep({ pattern: "KEY|core" }))).toBe("No matches found");
    expect(readWs(".env")).toBe("KEY=1\n");
  });
});

describe("权限清单", () => {
  it("未列出默认拒绝；ro 只读；后面的条目覆盖前面的", () => {
    const list: PermissionList = [
      { glob: "src/**", level: "rw" },
      { glob: "src/gen/**", level: "ro" },
      { glob: "src/gen/secret.ts", level: "deny" },
    ];
    expect(permissionFor(list, "src/a.ts")).toBe("rw");
    expect(permissionFor(list, "src/gen/x.ts")).toBe("ro");
    expect(permissionFor(list, "src/gen/secret.ts")).toBe("deny");
    expect(permissionFor(list, "README.md")).toBe("deny");
    expect(permissionFor([], "src/a.ts")).toBe("deny");
  });

  it("越权写入被拒，文件不动", async () => {
    writeFileSync(join(ws, "README.md"), "readme\n");
    const t = tools([
      { glob: "src/**", level: "ro" },
      { glob: "docs/**", level: "rw" },
    ]);
    ok(await t.read({ file_path: "src/a.ts" }));
    expect(err(await t.write({ file_path: "src/a.ts", content: "x" })).code).toBe("FS_PERMISSION_DENIED");
    expect(err(await t.edit({ file_path: "src/a.ts", old_string: "1", new_string: "9" })).code).toBe(
      "FS_PERMISSION_DENIED",
    );
    expect(err(await t.read({ file_path: "README.md" })).code).toBe("FS_PERMISSION_DENIED");
    expect(err(await t.write({ file_path: "README.md", content: "x" })).code).toBe("FS_PERMISSION_DENIED");
    expect(err(await t.write({ file_path: "new.ts", content: "x" })).code).toBe("FS_PERMISSION_DENIED");
    ok(await t.write({ file_path: "docs/x.md", content: "ok\n" }));
    expect(readWs("src/a.ts")).toBe(A_TS);
    expect(readWs("README.md")).toBe("readme\n");
    expect(existsSync(join(ws, "new.ts"))).toBe(false);
  });

  it("空权限清单什么都做不了", async () => {
    const t = tools([]);
    expect(err(await t.read({ file_path: "src/a.ts" })).code).toBe("FS_PERMISSION_DENIED");
    expect(err(await t.write({ file_path: "x.ts", content: "x" })).code).toBe("FS_PERMISSION_DENIED");
    expect(ok(await t.glob({ pattern: "*" }))).toBe("No files found");
  });
});

describe("glob / grep", () => {
  it("glob：无 / 的模式按文件名匹配任意深度，按修改时间新到旧，跳过被拒文件", async () => {
    writeFileSync(join(ws, "src", "b.ts"), "b\n");
    utimesSync(join(ws, "src", "a.ts"), new Date(1000), new Date(1000));
    writeFileSync(join(ws, "hidden.ts"), "h\n");
    const t = tools([{ glob: "src/**", level: "ro" }]);
    expect(ok(await t.glob({ pattern: "*.ts" }))).toBe("src/b.ts\nsrc/a.ts");
    expect(ok(await t.glob({ pattern: "a.ts", path: "src" }))).toBe("src/a.ts");
    expect(ok(await t.glob({ pattern: "src/*.ts" }))).toBe("src/b.ts\nsrc/a.ts");
  });

  it("grep：按文件分组带行号，include 过滤，单文件可搜", async () => {
    writeFileSync(join(ws, "src", "c.js"), "const a = 3;\n");
    const t = tools();
    expect(ok(await t.grep({ pattern: "const a" }))).toBe(
      "src/a.ts\n  1: const a = 1;\n\nsrc/c.js\n  1: const a = 3;",
    );
    expect(ok(await t.grep({ pattern: "const a", include: "*.js" }))).toBe("src/c.js\n  1: const a = 3;");
    expect(ok(await t.grep({ pattern: "b =", path: "src/a.ts" }))).toBe("src/a.ts\n  2: const b = 2;");
    expect(err(await t.grep({ pattern: "(" })).code).toBe("FS_INVALID_INPUT");
  });
});

describe("isProtectedPath", () => {
  it("规则", () => {
    expect(isProtectedPath(".env.example")).toBe(true);
    expect(isProtectedPath("a/.envrc.local")).toBe(true);
    expect(isProtectedPath("environment.ts")).toBe(false);
    expect(isProtectedPath("id_rsa.pub")).toBe(false);
    expect(isProtectedPath(".github/workflows/ci.yml")).toBe(false);
  });
});
