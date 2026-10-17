// 为 Electron 编一份 better-sqlite3 原生模块，放到 packages/desktop/native/electron/better_sqlite3.node。
// 不就地重编：pnpm 下 better-sqlite3 只有一份，被模块 2 和 Node 下的 vitest 共用，就地换成 Electron ABI 会让测试跑不起来。
// 主进程打开数据库时用 better-sqlite3 的 nativeBinding 选项指向这份文件。
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { rebuild } from "@electron/rebuild";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(pkgDir, "package.json"));
const sqliteDir = path.dirname(require.resolve("better-sqlite3/package.json"));
const sqliteVersion = JSON.parse(
  readFileSync(path.join(sqliteDir, "package.json"), "utf8"),
).version;
const electronVersion =
  process.env.ELECTRON_VERSION ||
  JSON.parse(readFileSync(require.resolve("electron/package.json"), "utf8")).version;
const out = path.join(pkgDir, "native", "electron", "better_sqlite3.node");

const work = mkdtempSync(path.join(tmpdir(), "bc-electron-rebuild-"));
try {
  const modDir = path.join(work, "node_modules", "better-sqlite3");
  cpSync(sqliteDir, modDir, {
    recursive: true,
    dereference: true,
    filter: (src) => !src.includes(`${path.sep}build${path.sep}`),
  });
  writeFileSync(
    path.join(work, "package.json"),
    JSON.stringify({
      name: "bc-electron-rebuild",
      private: true,
      dependencies: { "better-sqlite3": sqliteVersion },
    }),
  );
  process.stdout.write(
    `rebuild better-sqlite3@${sqliteVersion} for electron@${electronVersion} …\n`,
  );
  await rebuild({ buildPath: work, electronVersion, onlyModules: ["better-sqlite3"], force: true });
  const built = path.join(modDir, "build", "Release", "better_sqlite3.node");
  if (!existsSync(built)) throw new Error(`没有产出 ${built}`);
  mkdirSync(path.dirname(out), { recursive: true });
  cpSync(built, out);
  process.stdout.write(`done: ${path.relative(pkgDir, out)}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
