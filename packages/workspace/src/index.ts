// 模块 4：工作区与受限工具层，接口见 docs/modules.md「4.」一节。
export const MODULE_ID = 4 as const;
export const MODULE_NAME = "@bakacoding/workspace" as const;
export * from "./worktree.js";
export * from "./tools.js";
export * from "./permissions.js";
export {
  FsToolError,
  isProtectedPath,
  isUnsafeGlob,
  permissionFor,
  resolveInWorkspace,
} from "./guard.js";
export type { ResolvedPath } from "./guard.js";
export * from "./repo.js";
export { gitEnv } from "./git-env.js";
