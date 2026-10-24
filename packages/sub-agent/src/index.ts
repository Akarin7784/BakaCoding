// 模块 8：副 Agent，接口见 docs/modules.md「8.」一节。
export const MODULE_ID = 8 as const;
export const MODULE_NAME = "@bakacoding/sub-agent" as const;

export * from "./types.js";
export * from "./sub-agent.js";
export * from "./permissions.js";
export {
  memoryInterfaceNotes,
  storageTicketInterfaceNotes,
  type InterfaceNotesStorage,
} from "./interface-notes.js";
