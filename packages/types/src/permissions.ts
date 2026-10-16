import { z } from "zod";

export const PERMISSION_LEVELS = ["rw", "ro", "deny"] as const;
export const PermissionLevelSchema = z.enum(PERMISSION_LEVELS);
export type PermissionLevel = z.infer<typeof PermissionLevelSchema>;

/** 未被任何条目匹配的路径一律拒绝。 */
export const DEFAULT_PERMISSION_LEVEL: PermissionLevel = "deny";

export const PermissionEntrySchema = z.object({
  glob: z.string().min(1),
  level: PermissionLevelSchema,
});
export type PermissionEntry = z.infer<typeof PermissionEntrySchema>;

export const PermissionListSchema = z.array(PermissionEntrySchema).default([]);
export type PermissionList = z.infer<typeof PermissionListSchema>;
