import { readFileSync } from "node:fs";
import { EffortSchema } from "@bakacoding/types";
import { z } from "zod";

const Int = z.number().int();
const NonNegInt = Int.nonnegative();
const PosInt = Int.positive();
const Id = z.string().min(1);

const RoleModel = {
  provider: Id.describe("服务商 id，对应 providers 下的键"),
  model: Id.describe("模型名"),
};

const ProviderSchema = z
  .object({
    base_url: z.string().url(),
    protocol: z.enum(["anthropic-messages", "openai-chat"]),
    credential_ref: z
      .string()
      .regex(/^env:[A-Z0-9_]+$/)
      .describe("凭据引用，只允许 env:VAR；key 本身不写进配置"),
    models: z.record(
      z
        .object({
          expected_display_name: z.string().min(1).optional(),
          thinking_enabled: z.boolean().default(true),
        })
        .strict()
        .describe("不含 effort 映射：思考档位映射以模块 1 服务商能力表为准"),
    ),
  })
  .strict();

const DEFAULT_MEMBER = (id: string) => ({
  id,
  provider: "deepseek",
  model: "deepseek-flash",
  effort: "high" as const,
});

const ReviewBoardSchema = z
  .object({
    members: z
      .array(z.object({ id: Id, ...RoleModel, effort: EffortSchema.default("high") }).strict())
      .default([DEFAULT_MEMBER("reviewer-1"), DEFAULT_MEMBER("reviewer-2")])
      .describe("评审池成员，不含主管；默认 2 个 high；0 个时主管兼任评审")
      .refine((ms) => ms.every((m) => m.id !== "supervisor"), {
        message: "review_board.members 不能包含主管（supervisor 单独配置）",
      })
      .refine((ms) => new Set(ms.map((m) => m.id)).size === ms.length, {
        message: "review_board.members 的 id 不能重复",
      }),
    review_assignment: z.enum(["least_busy"]).default("least_busy"),
    sticky_on_resubmit: z.boolean().default(true),
    skip_rate_limited: z.boolean().default(true),
  })
  .strict()
  .describe("整个评审组；事件/台账中的 role=reviewer 指其中单个成员");

export const ConfigSchema = z
  .object({
    $schema_version: z.literal("bakacoding.model-config.v1"),
    providers: z.record(ProviderSchema).default({}),
    roles: z
      .object({
        supervisor: z
          .object({
            ...RoleModel,
            effort: z.literal("max", {
              errorMap: () => ({ message: "roles.supervisor.effort 固定为 max" }),
            }),
          })
          .strict()
          .describe("必填；评审组裁决人；effort 固定 max"),
        review_board: ReviewBoardSchema.default({}),
        sub_agent: z
          .object({ ...RoleModel, effort: EffortSchema.default("high") })
          .strict()
          .default({ provider: "deepseek", model: "deepseek-flash", effort: "high" }),
        coder: z
          .object({
            ...RoleModel,
            effort: EffortSchema.default("low"),
            resubmit_effort: z
              .array(EffortSchema)
              .length(3)
              .default(["low", "high", "high"])
              .describe("第 1/2/3 次复投的档位"),
          })
          .strict()
          .default({ provider: "deepseek", model: "deepseek-flash" }),
      })
      .strict(),
    routing: z
      .object({
        automatic_model_switching: z.literal(false).default(false),
        fallbacks: z.array(z.string()).default([]),
      })
      .strict()
      .default({}),
    validation: z
      .object({
        unsupported_effort: z.literal("error").default("error"),
        display_name_change: z.enum(["require_confirmation"]).default("require_confirmation"),
      })
      .strict()
      .default({}),
    budget: z
      .object({
        daily_micro_usd: PosInt.describe("必填；每日预算，整数微美元（1 USD = 1_000_000）"),
        per_ticket_ratio: z
          .number()
          .gt(0)
          .lte(1)
          .default(0.05)
          .describe("每单上限 = 每日预算 × 本值，含复投"),
        offpeak_preference: z
          .boolean()
          .default(false)
          .describe("闲时开关，默认关；只影响 priority=deferred 的单"),
      })
      .strict(),
    pipeline: z
      .object({
        concurrency_max: PosInt.default(8).describe(
          "同时处于编码阶段的需求单数上限；反压调的也是这个数",
        ),
        concurrency_hard_max: PosInt.default(64).describe("编码阶段并发硬上限，超过须手动改配置"),
        resubmit_limits: z
          .object({ review: NonNegInt.default(3), conflict: NonNegInt.default(2) })
          .strict()
          .default({}),
        resplit_limit: NonNegInt.default(2),
        supervisor_backlog_limit: PosInt.default(10),
        main_merge: z.enum(["user", "supervisor"]).default("user"),
        max_turns: PosInt.default(40).describe(
          "Flash 代理每单最多调用模型的轮数，到上限返回 turn_limit",
        ),
      })
      .strict()
      .default({})
      .refine((p) => p.concurrency_max <= p.concurrency_hard_max, {
        message: "pipeline.concurrency_max 不能大于 concurrency_hard_max",
        path: ["concurrency_max"],
      }),
    backpressure: z
      .object({
        reviews_per_member: PosInt.default(2),
        halve_at: PosInt.default(2),
        pause_at: PosInt.default(4),
        recover_step: PosInt.default(1),
        recover_interval_min: PosInt.default(5),
        // 默认值 16 没有实测依据（取 concurrency_max 默认值 8 的 2 倍），待实测后再定
        pending_pr_limit: PosInt.default(16).describe(
          "排队中（merge_queued）+ 评审中的 PR 数超过它就暂停派新单（T-035；默认值 16 没有实测依据）",
        ),
      })
      .strict()
      .default({}),
    diagnostics: z
      .object({ retention_days: PosInt.default(30).describe("完整提示词和输出的保留天数") })
      .strict()
      .default({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(readonly errors: string[]) {
    super(`配置校验失败：\n${errors.map((e) => `- ${e}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/** 校验原始配置对象，返回错误列表（空表示通过）。 */
export function validate(raw: unknown): string[] {
  const r = ConfigSchema.safeParse(raw);
  if (r.success) return [];
  return r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

/** 读取并校验配置文件；失败抛 ConfigError（不启动）。 */
export function getConfig(path: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError([`无法读取配置 ${path}：${(e as Error).message}`]);
  }
  const r = ConfigSchema.safeParse(raw);
  if (!r.success) throw new ConfigError(validate(raw));
  return r.data;
}

export const SECRET_NAMES = ["DEEPSEEK_API_KEY", "GITHUB_TOKEN"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

/** 从环境变量读密钥；缺失时抛错。错误信息和日志都不含值。 */
export function getSecret(name: SecretName, env: NodeJS.ProcessEnv = process.env): string {
  if (!(SECRET_NAMES as readonly string[]).includes(name)) {
    throw new Error(`不支持的密钥名：${String(name)}`);
  }
  const v = env[name]?.trim();
  if (!v) throw new Error(`缺少环境变量 ${name}：请在启动前设置（值不会写入日志或配置）`);
  return v;
}
