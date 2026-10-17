// T-105：window-theme.json 原子写——同目录临时文件 + rename，失败清理临时文件、旧文件不动。
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readSavedTheme,
  THEME_STORE_FILE,
  writeSavedTheme,
  type ThemeStoreFs,
} from "./theme-store";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "bc-theme-store-"));
  dirs.push(d);
  return d;
}
const realFs: ThemeStoreFs = { writeFileSync, renameSync, rmSync };

describe("writeSavedTheme 原子写（T-105）", () => {
  it("先写同目录临时文件再 rename；覆盖旧值；目录里不留临时文件", () => {
    const dir = tmp();
    const fs = {
      writeFileSync: vi.fn(realFs.writeFileSync),
      renameSync: vi.fn(realFs.renameSync),
      rmSync: vi.fn(realFs.rmSync),
    };
    writeSavedTheme(dir, "light", fs);
    writeSavedTheme(dir, "dark", fs);
    expect(readSavedTheme(dir)).toBe("dark");
    expect(readFileSync(join(dir, THEME_STORE_FILE), "utf8")).toBe('{"theme":"dark"}\n');
    expect(readdirSync(dir)).toEqual([THEME_STORE_FILE]);
    for (const [file, , opts] of fs.writeFileSync.mock.calls) {
      expect(dirname(file)).toBe(dir);
      expect(file).not.toBe(join(dir, THEME_STORE_FILE));
      expect(opts).toEqual({ flag: "wx" });
    }
    expect(fs.renameSync).toHaveBeenCalledTimes(2);
    for (const [from, to] of fs.renameSync.mock.calls) {
      expect(to).toBe(join(dir, THEME_STORE_FILE));
      expect(dirname(from)).toBe(dir);
    }
    // 两次各用不同的临时文件名
    expect(fs.writeFileSync.mock.calls[0]![0]).not.toBe(fs.writeFileSync.mock.calls[1]![0]);
  });

  it("rename 失败：抛错、删掉临时文件、旧文件内容不变", () => {
    const dir = tmp();
    writeSavedTheme(dir, "light");
    const err = new Error("EPERM: rename");
    expect(() =>
      writeSavedTheme(dir, "dark", {
        ...realFs,
        renameSync: () => {
          throw err;
        },
      }),
    ).toThrow(err);
    expect(readdirSync(dir)).toEqual([THEME_STORE_FILE]);
    expect(readSavedTheme(dir)).toBe("light");
  });

  it("写到一半失败：抛错、删掉写了一半的临时文件、不 rename、旧文件不变", () => {
    const dir = tmp();
    writeSavedTheme(dir, "dark");
    const rename = vi.fn(realFs.renameSync);
    expect(() =>
      writeSavedTheme(dir, "light", {
        ...realFs,
        renameSync: rename,
        writeFileSync: (file) => {
          realFs.writeFileSync(file, '{"theme":"li', { flag: "wx" });
          throw new Error("ENOSPC");
        },
      }),
    ).toThrow("ENOSPC");
    expect(rename).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([THEME_STORE_FILE]);
    expect(readSavedTheme(dir)).toBe("dark");
  });

  it("真实 rename 失败（目标位置是个非空目录）：抛错且不留临时文件", () => {
    const dir = tmp();
    mkdirSync(join(dir, THEME_STORE_FILE, "x"), { recursive: true });
    expect(() => writeSavedTheme(dir, "dark")).toThrow();
    expect(readdirSync(dir)).toEqual([THEME_STORE_FILE]);
  });
});
