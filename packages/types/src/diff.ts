import { z } from "zod";

export const DIFF_FILE_STATUSES = ["added", "modified", "deleted", "renamed"] as const;

const Sha = z.string().regex(/^[0-9a-f]{7,64}$/);

export const DiffFileSchema = z.object({
  path: z.string().min(1),
  status: z.enum(DIFF_FILE_STATUSES),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string(),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

export const DiffSchema = z.object({
  base_sha: Sha,
  head_sha: Sha,
  files: z.array(DiffFileSchema),
});
export type Diff = z.infer<typeof DiffSchema>;
