// 打包桌面端为免安装版（chore/win-package）：Windows x64 zip，或 Linux dir（冒烟测试用）。
//
// 用法（先在仓库根 `pnpm -r build`，再在本包 `pnpm build:app`）：
//   node scripts/package-app.mjs --platform win32   → release/BakaCoding-<version>-win-x64.zip
//   node scripts/package-app.mjs --platform linux   → release/linux-unpacked/（xvfb-run 冒烟）
//
// 原生模块：rebuild:electron 不能从 Linux 交叉编译 Windows 版，所以用 better-sqlite3 官方预编译包。
// better-sqlite3 目前没有 Electron 44（ABI 149）的预编译包；最新带 Electron 预编译的是 12.12.0，
// 最高到 electron-v148（Electron 43）。因此打包用 Electron 43（PACKAGE_ELECTRON），
// .node 的 ABI 与打进去的 Electron 一致。12.12.0 的 lib/ 与 npm 上的 12.11.1 逐字节相同（只升级了 SQLite），
// 12.12.0 没发到 npm，所以从 GitHub 的 tag 源码包取 lib/ 和 package.json。
//
// 打包内容：dist-electron（主进程已把 @bakacoding/* 等全部打进 main.js，只有 better-sqlite3 外置）、
// dist-renderer、prompts/（模块 3 运行时按 main.js 的 ../prompts/ 读）、native/electron/better_sqlite3.node
// （main.ts 按 ../native/electron/ 找，asarUnpack）、node_modules/better-sqlite3（+ bindings、file-uri-to-path）。
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const PACKAGE_ELECTRON = "43.8.0";
export const ELECTRON_ABI = "148";
export const SQLITE_VERSION = "12.12.0";
const ELECTRON_BUILDER = "electron-builder@26.15.3";

const args = process.argv.slice(2);
const platform = args.includes("--platform") ? args[args.indexOf("--platform") + 1] : "win32";
if (platform !== "win32" && platform !== "linux") throw new Error(`不支持的平台：${platform}`);

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(pkgDir, "package.json"));
const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const releaseDir = path.join(pkgDir, "release");
const cacheDir = path.join(releaseDir, "cache");
const stage = path.join(releaseDir, `stage-${platform}`);

for (const d of [
  "dist-electron/main.js",
  "dist-electron/preload.cjs",
  "dist-renderer/index.html",
]) {
  if (!existsSync(path.join(pkgDir, d))) throw new Error(`缺少 ${d}：先跑 pnpm build:app`);
}

function sh(cmd, argv, opts = {}) {
  execFileSync(cmd, argv, { stdio: "inherit", ...opts });
}

async function download(url, dest) {
  if (existsSync(dest)) return dest;
  mkdirSync(path.dirname(dest), { recursive: true });
  const res = await globalThis.fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${res.status}：${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

// 1. better-sqlite3：tag 源码（lib/、package.json）+ 对应平台的 Electron 预编译 .node
const srcTgz = await download(
  `https://github.com/WiseLibs/better-sqlite3/archive/refs/tags/v${SQLITE_VERSION}.tar.gz`,
  path.join(cacheDir, `better-sqlite3-${SQLITE_VERSION}-src.tar.gz`),
);
const prebuildName = `better-sqlite3-v${SQLITE_VERSION}-electron-v${ELECTRON_ABI}-${platform}-x64.tar.gz`;
const prebuildTgz = await download(
  `https://github.com/WiseLibs/better-sqlite3/releases/download/v${SQLITE_VERSION}/${prebuildName}`,
  path.join(cacheDir, prebuildName),
);

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const sqliteDir = path.join(stage, "node_modules", "better-sqlite3");
mkdirSync(sqliteDir, { recursive: true });
sh("tar", [
  "xzf",
  srcTgz,
  "-C",
  sqliteDir,
  "--strip-components=1",
  `better-sqlite3-${SQLITE_VERSION}/lib`,
  `better-sqlite3-${SQLITE_VERSION}/package.json`,
  `better-sqlite3-${SQLITE_VERSION}/LICENSE`,
]);
sh("tar", ["xzf", prebuildTgz, "-C", sqliteDir]);
const nodeFile = path.join(sqliteDir, "build", "Release", "better_sqlite3.node");
if (!existsSync(nodeFile)) throw new Error(`预编译包里没有 ${nodeFile}`);
const nativeOut = path.join(stage, "native", "electron", "better_sqlite3.node");
mkdirSync(path.dirname(nativeOut), { recursive: true });
cpSync(nodeFile, nativeOut);

// better-sqlite3 的运行时依赖（传了 nativeBinding 时不会加载 bindings，仍带上以防万一）
const sqliteReq = createRequire(require.resolve("better-sqlite3/package.json"));
const bindingsDir = path.dirname(sqliteReq.resolve("bindings/package.json"));
const furiDir = path.dirname(
  createRequire(path.join(bindingsDir, "package.json")).resolve("file-uri-to-path/package.json"),
);
for (const [name, dir] of [
  ["bindings", bindingsDir],
  ["file-uri-to-path", furiDir],
]) {
  cpSync(dir, path.join(stage, "node_modules", name), { recursive: true, dereference: true });
}

// 2. 应用文件
cpSync(path.join(pkgDir, "dist-electron"), path.join(stage, "dist-electron"), { recursive: true });
cpSync(path.join(pkgDir, "dist-renderer"), path.join(stage, "dist-renderer"), { recursive: true });
cpSync(path.join(pkgDir, "..", "config-budget", "prompts"), path.join(stage, "prompts"), {
  recursive: true,
});
writeFileSync(
  path.join(stage, "package.json"),
  JSON.stringify(
    {
      name: "bakacoding",
      productName: "BakaCoding",
      version: pkg.version,
      description: "BakaCoding 桌面端",
      author: "BakaCoding",
      license: "MIT",
      type: "module",
      main: "dist-electron/main.js",
      dependencies: { "better-sqlite3": SQLITE_VERSION },
    },
    null,
    2,
  ),
);

// 3. electron-builder（不签名、不改 exe 资源，Linux 上无需 wine）
const config = {
  appId: "local.bakacoding.desktop",
  productName: "BakaCoding",
  electronVersion: PACKAGE_ELECTRON,
  directories: { output: path.join(releaseDir, platform) },
  files: ["**/*"],
  asar: true,
  // 配置模板放在 exe 旁边（不进 asar）：用户复制到自己仓库的 config/ 下（backend 读 <repo>/config/models.json、pricing.json）
  extraFiles: [
    {
      from: path.join(pkgDir, "..", "..", "config", "models.example.json"),
      to: "config-templates/models.example.json",
    },
    {
      from: path.join(pkgDir, "..", "..", "config", "pricing.json"),
      to: "config-templates/pricing.json",
    },
  ],
  asarUnpack: ["native/**", "node_modules/better-sqlite3/**"],
  npmRebuild: false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  win: { target: [{ target: "zip", arch: ["x64"] }], signAndEditExecutable: false },
  linux: { target: [{ target: "dir", arch: ["x64"] }] },
};
const cfgPath = path.join(releaseDir, `electron-builder-${platform}.json`);
writeFileSync(cfgPath, JSON.stringify(config, null, 2));
rmSync(path.join(releaseDir, platform), { recursive: true, force: true });
sh(
  "npx",
  [
    "-y",
    ELECTRON_BUILDER,
    "--projectDir",
    stage,
    "--config",
    cfgPath,
    platform === "win32" ? "--win" : "--linux",
    "--x64",
  ],
  { env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" } },
);
process.stdout.write(`done: ${path.relative(pkgDir, path.join(releaseDir, platform))}\n`);
