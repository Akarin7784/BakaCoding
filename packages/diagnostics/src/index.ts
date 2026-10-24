// 模块 11 诊断包导出，接口见 docs/modules.md「11.」一节。
export const MODULE_ID = 11 as const;
export const MODULE_NAME = "@bakacoding/diagnostics" as const;

export * from "./schema.js";
export { buildPackage, diffToUnified, isEnvFile, PACKAGE_FILES } from "./build.js";
export { exportPackage, packageToZip, readPackage, zipToPackage } from "./pack.js";
export { toSweBenchJsonl, type SweBenchInstance } from "./swebench.js";
export { DROPPED_KEYS, FullRedactor, safeZipPath } from "./redaction.js";
export { PATH_RULES, redactPaths, type PathRule, type PathRedactResult } from "./path-redaction.js";
export {
  redactPathsPure,
  FULLWIDTH_STOP,
  MAX_GAP_WORDS,
  type PurePathRedactOptions,
} from "./path-redaction-core.js";
export { readZip, writeZip, type ZipEntry } from "./zip.js";

// modules.md 写的名字是 export；它是保留字，只能以导出别名提供：import { export as exportDiag }。
export { exportPackage as export } from "./pack.js";
