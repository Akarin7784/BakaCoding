// 打包桌面端为免安装版（T-073）：Windows x64 zip，或 Linux dir（冒烟测试用）。
//
// 用法（先在仓库根 `pnpm -r build`，再在本包 `pnpm build:app`）：
//   pnpm package:win    （= node scripts/package-app.mjs --platform win32）
//     → release/win32/BakaCoding-<version>-win-x64.zip（解开的目录在 release/win32/win-unpacked/）
//   pnpm package:linux  （= node scripts/package-app.mjs --platform linux）
//     → release/linux/linux-unpacked/（xvfb-run 冒烟）
//
// 原生模块：rebuild:electron 不能从 Linux 交叉编译 Windows 版，所以用 better-sqlite3 官方预编译包。
// better-sqlite3 目前没有 Electron 44（ABI 149）的预编译包；最新带 Electron 预编译的是 12.12.0，
// 最高到 electron-v148（Electron 43）。因此本包的 electron 固定为 43.8.0（开发、rebuild:electron 和打包同一版本，
// 脚本会检查），.node 的 ABI 与打进去的 Electron 一致；上游出了 ABI 149 预编译再升。
// 12.12.0 的 lib/ 与 npm 上的 12.11.1 逐字节相同（只升级了 SQLite）；12.12.0 没发到 npm，
// 所以从 GitHub 的 tag 源码包取 lib/ 和 package.json。下载的三个文件都按 SHA256 常量校验（缓存也校验）。
//
// 打包内容：dist-electron（主进程已把 @bakacoding/* 等全部打进 main.js，只有 better-sqlite3 外置）、
// dist-renderer、prompts/（模块 3 运行时按 main.js 的 ../prompts/ 读）、
// node_modules/better-sqlite3（build/Release/better_sqlite3.node 进 asarUnpack，main.ts 找不到
// native/electron/ 时由 better-sqlite3 经 bindings 加载这一份）+ bindings、file-uri-to-path。
// Windows：打包后用 resedit（纯 JS，不要 wine）写 exe 版本信息；有 build/icon.ico 时一并换图标。
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build, Platform } from "electron-builder";
import * as ResEdit from "resedit";

export const PACKAGE_ELECTRON = "43.8.0";
export const ELECTRON_ABI = "148";
export const SQLITE_VERSION = "12.12.0";
/** 官方下载的 SHA256：预编译包与 GitHub release 资产的 digest 一致；源码包为 tag v12.12.0（72abfc3）的归档。 */
export const SHA256 = {
  [`better-sqlite3-${SQLITE_VERSION}-src.tar.gz`]:
    "a90fc4990ccd0bd78e8c52ce20c46396ef63558ba4da8b9ad775d6f32d0293f0",
  [`better-sqlite3-v${SQLITE_VERSION}-electron-v${ELECTRON_ABI}-win32-x64.tar.gz`]:
    "63bf1a99e1059dae6be4a47151f1c3359f5bd422e48fa00979f02bd930f4178c",
  [`better-sqlite3-v${SQLITE_VERSION}-electron-v${ELECTRON_ABI}-linux-x64.tar.gz`]:
    "39ce5a7c00c64dda91719c4de880e891815cbd1f6c70c367a05b79a7438b5b1f",
};

const args = process.argv.slice(2);
const platform = args.includes("--platform") ? args[args.indexOf("--platform") + 1] : "win32";
if (platform !== "win32" && platform !== "linux") throw new Error(`不支持的平台：${platform}`);

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(pkgDir, "package.json"));
const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const installedElectron = JSON.parse(
  readFileSync(require.resolve("electron/package.json"), "utf8"),
).version;
if (installedElectron !== PACKAGE_ELECTRON || pkg.devDependencies?.electron !== PACKAGE_ELECTRON) {
  throw new Error(
    `开发用 Electron（${installedElectron}，package.json ${pkg.devDependencies?.electron}）和打包用 ${PACKAGE_ELECTRON} 不一致`,
  );
}
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

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** 下载到缓存并校验 SHA256；缓存不对就重下，重下后仍不对直接失败。 */
async function download(url, name) {
  const expected = SHA256[name];
  if (!expected) throw new Error(`没有 ${name} 的 SHA256 常量`);
  const dest = path.join(cacheDir, name);
  if (existsSync(dest)) {
    if (sha256(readFileSync(dest)) === expected) return dest;
    process.stdout.write(`缓存的 ${name} 校验不通过，重新下载\n`);
    rmSync(dest, { force: true });
  }
  mkdirSync(cacheDir, { recursive: true });
  const res = await globalThis.fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${res.status}：${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== expected) throw new Error(`${name} 的 SHA256 不对：期望 ${expected}，实际 ${got}`);
  writeFileSync(dest, buf);
  return dest;
}

// 1. better-sqlite3：tag 源码（lib/、package.json）+ 对应平台的 Electron 预编译 .node
const srcTgz = await download(
  `https://github.com/WiseLibs/better-sqlite3/archive/refs/tags/v${SQLITE_VERSION}.tar.gz`,
  `better-sqlite3-${SQLITE_VERSION}-src.tar.gz`,
);
const prebuildName = `better-sqlite3-v${SQLITE_VERSION}-electron-v${ELECTRON_ABI}-${platform}-x64.tar.gz`;
const prebuildTgz = await download(
  `https://github.com/WiseLibs/better-sqlite3/releases/download/v${SQLITE_VERSION}/${prebuildName}`,
  prebuildName,
);

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const sqliteDir = path.join(stage, "node_modules", "better-sqlite3");
mkdirSync(sqliteDir, { recursive: true });
// tar：Linux / macOS 自带，Windows 10 起自带 tar.exe（bsdtar）
execFileSync(
  "tar",
  [
    "xzf",
    srcTgz,
    "-C",
    sqliteDir,
    "--strip-components=1",
    `better-sqlite3-${SQLITE_VERSION}/lib`,
    `better-sqlite3-${SQLITE_VERSION}/package.json`,
    `better-sqlite3-${SQLITE_VERSION}/LICENSE`,
  ],
  { stdio: "inherit" },
);
execFileSync("tar", ["xzf", prebuildTgz, "-C", sqliteDir], { stdio: "inherit" });
if (!existsSync(path.join(sqliteDir, "build", "Release", "better_sqlite3.node"))) {
  throw new Error("预编译包里没有 build/Release/better_sqlite3.node");
}
// 已经放好预编译 .node：去掉安装脚本和 prebuild-install 依赖（pnpm 下 electron-builder 严格收集依赖，会因缺它报错）
const sqlitePkgPath = path.join(sqliteDir, "package.json");
const sqlitePkg = JSON.parse(readFileSync(sqlitePkgPath, "utf8"));
delete sqlitePkg.dependencies?.["prebuild-install"];
delete sqlitePkg.scripts?.install;
delete sqlitePkg.devDependencies;
writeFileSync(sqlitePkgPath, JSON.stringify(sqlitePkg, null, 2));

// better-sqlite3 的运行时依赖：bindings 按 build/Release 找 .node
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

// 3. Windows exe 版本信息 / 图标（resedit，纯 JS）
const ICON = path.join(pkgDir, "build", "icon.ico");
const LINUX_ICON = path.join(pkgDir, "build", "icon.png");
/** "1.0.0-preview" → [1, 0, 0, 0] */
function numericVersion(v) {
  const parts = v.split(/[.-]/).map(Number).filter(Number.isInteger).slice(0, 3);
  while (parts.length < 3) parts.push(0);
  return [...parts, 0];
}
function editWindowsExe(exePath) {
  const exe = ResEdit.NtExecutable.from(readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (!vi) throw new Error("exe 里没有版本信息资源");
  const [a, b, c, d] = numericVersion(pkg.version);
  const lang = vi.getAllLanguagesForStringValues()[0] ?? { lang: 1033, codepage: 1200 };
  vi.setFileVersion(a, b, c, d, lang.lang);
  vi.setProductVersion(a, b, c, d, lang.lang);
  vi.setStringValues(lang, {
    ProductName: "BakaCoding",
    FileDescription: "BakaCoding",
    CompanyName: "BakaCoding",
    InternalName: "BakaCoding",
    OriginalFilename: "BakaCoding.exe",
    FileVersion: `${a}.${b}.${c}.${d}`,
    ProductVersion: pkg.version,
    LegalCopyright: "MIT License",
  });
  vi.outputToResourceEntries(res.entries);
  if (existsSync(ICON)) {
    const ico = ResEdit.Data.IconFile.from(readFileSync(ICON));
    const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
    const target = groups[0] ?? { id: 1, lang: 1033 };
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      target.id,
      target.lang,
      ico.icons.map((i) => i.data),
    );
    process.stdout.write(`exe 图标：${path.relative(pkgDir, ICON)}\n`);
  } else {
    process.stdout.write(
      `没有 ${path.relative(pkgDir, ICON)}，跳过 exe 图标（保留 Electron 默认图标）\n`,
    );
  }
  res.outputResource(exe);
  writeFileSync(exePath, Buffer.from(exe.generate()));
  process.stdout.write(`exe 版本信息：${a}.${b}.${c}.${d}（ProductVersion ${pkg.version}）\n`);
}

// 4. electron-builder（本包 devDependency，直接调 API；不签名、不用 rcedit，Linux 上无需 wine）
rmSync(path.join(releaseDir, platform), { recursive: true, force: true });
process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
await build({
  projectDir: stage,
  targets:
    platform === "win32"
      ? Platform.WINDOWS.createTarget("zip", 1 /* Arch.x64 */)
      : Platform.LINUX.createTarget("dir", 1 /* Arch.x64 */),
  config: {
    appId: "local.bakacoding.desktop",
    productName: "BakaCoding",
    electronVersion: PACKAGE_ELECTRON,
    directories: { output: path.join(releaseDir, platform) },
    files: ["**/*"],
    asar: true,
    asarUnpack: ["node_modules/better-sqlite3/build/**"],
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
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
    win: { signAndEditExecutable: false },
    ...(existsSync(LINUX_ICON) && { linux: { icon: LINUX_ICON } }),
    afterPack: async (ctx) => {
      if (ctx.electronPlatformName === "win32") {
        editWindowsExe(path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.exe`));
      }
    },
  },
});
process.stdout.write(`done: ${path.relative(pkgDir, path.join(releaseDir, platform))}\n`);
