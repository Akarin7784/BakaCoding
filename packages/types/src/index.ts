// 共享类型包占位：事件类型、常量和 zod schema（见需求单 T-001）。
import { z } from "zod";

export const PACKAGE_NAME = "@bakacoding/types" as const;

/** 思考档位，取值见 docs/modules.md 模块 1。 */
export const EffortSchema = z.enum(["off", "low", "high", "max"]);
export type Effort = z.infer<typeof EffortSchema>;
