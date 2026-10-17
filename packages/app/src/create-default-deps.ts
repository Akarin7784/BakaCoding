// T-063：按仓库组装默认 AppDeps（只建对象，不 takeOver、不 dispatch）。
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ConfigError,
  createBudget,
  getSecret,
  loadPricing,
  promptTemplate,
  type BudgetBusLike,
  type Config,
  type SecretName,
} from "@bakacoding/config-budget";
import { createCoderPool } from "@bakacoding/coder-pool";
import { createEventBus, type EventBus } from "@bakacoding/event-bus";
import { createModelGateway } from "@bakacoding/model-gateway";
import { createPrProvider, INTEGRATION_BRANCH, type PrProvider } from "@bakacoding/pr";
import {
  createReviewPool,
  createRoundAssignmentStore,
  storageRoundSource,
  type ReviewPrSource,
} from "@bakacoding/review-pool";
import type { Storage } from "@bakacoding/storage";
import { PermissionRegistry, WorktreeManager, WORKTREES_DIR } from "@bakacoding/workspace";
import type { AppDeps } from "./assemble.js";

const run = promisify(execFile);

export interface CreateDefaultDepsOpts {
  repoRoot: string;
  notifyUser: AppDeps["notifyUser"];
  /** 默认 `<repoRoot>/config/pricing.json` */
  pricingPath?: string;
  /** 读密钥用；默认 process.env。缺 DEEPSEEK_API_KEY 抛 ConfigError */
  env?: NodeJS.ProcessEnv;
  logger?: AppDeps["logger"];
  onError?: AppDeps["onError"];
}

export interface DefaultDepsHandle {
  deps: AppDeps;
  /** 取消 storage.attach 与 budget.attach（不关库、不停 assemble） */
  dispose(): void;
  /** 4 / 5 / 8 共用的同一份 PermissionRegistry（测试用） */
  registry: PermissionRegistry;
  /**
   * 7 用的 PR 转发占位：每次调用查当前真实 provider。
   * assemble 调 createPr 接线前调用会抛错；接线后转发到真实实例。
   */
  reviewPr: ReviewPrSource;
  /** 唯一的一条总线（与 deps.bus 相同） */
  bus: EventBus;
}

/** 7 的 PR 还没被 assemble 的 createPr 接上。 */
export class PrNotWiredError extends Error {
  constructor(method: string) {
    super(`PR 实现还没接上，不能调用 ${method}（等 assemble 返回后再用）`);
    this.name = "PrNotWiredError";
  }
}

function createPrForwarder(slot: { current: PrProvider | null }): ReviewPrSource {
  const requirePr = (method: string): PrProvider => {
    if (!slot.current) throw new PrNotWiredError(method);
    return slot.current;
  };
  return {
    // 始终返回 Promise，接线前的抛错也走 reject，方便 expect().rejects
    diff: async (pr_id) => requirePr("diff").diff(pr_id),
    checks: async (pr_id) => requirePr("checks").checks(pr_id),
  };
}

async function gitRevParse(repoRoot: string, rev: string): Promise<string> {
  const { stdout } = await run("git", ["rev-parse", "--verify", rev], {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * 基线分支，组合根唯一来源：同一个值传给 6（createPrProvider 的 baseBranch，T-076 建集成分支的起点）
 * 和 9 / 10 的 targetHead（T-079），4/6/9 用同一个分支。配置里暂无此项，固定 main；
 * GitHub 模式 github.ts 里另写死 "main"，与此一致。发版后改为自动识别仓库默认分支。
 */
const BASE_BRANCH = "main";

async function refExists(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await run("git", ["show-ref", "--verify", "--quiet", ref], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

/**
 * T-079：9 / 10 的 targetHead = 合入目标（集成分支）当前的提交，不是仓库检出的 HEAD。
 * 集成分支还没建（新仓库第一张单合入前）时退回基线分支 baseBranch，和 6 建分支的起点一致（T-076）；
 * 仓库里连基线分支都没有时才退回检出的 HEAD。
 */
export async function integrationTargetHead(
  repoRoot: string,
  baseBranch: string = BASE_BRANCH,
): Promise<string> {
  const ref = `refs/heads/${INTEGRATION_BRANCH}`;
  if (await refExists(repoRoot, ref)) return gitRevParse(repoRoot, `${ref}^{commit}`);
  const base = `refs/heads/${baseBranch}`;
  if (await refExists(repoRoot, base)) return gitRevParse(repoRoot, `${base}^{commit}`);
  // 连基线分支都没有（默认分支叫 master 等）：退回检出的 HEAD，保持启动不挂；
  // 这种仓库 6 合入时 ensureBranch(..., baseBranch) 本来也会失败，属已知限制
  return gitRevParse(repoRoot, "HEAD");
}

/**
 * 按仓库建好组装用的 AppDeps（v1：一次组装对应一个仓库，不是按项目）。
 * 只创建对象：不调 takeOver、不派单。调用方再 `assemble(deps)` → `takeOver` 已在 assemble 内完成。
 *
 * 建好的顺序：总线 → storage.attach → 预算（先于网关）→ 模型网关 → worktree / 登记表 →
 * 编码池（chat）→ 评审池（PR 占位转发）→ createPr（assemble 时接线）→ targetHead。
 */
export async function createDefaultDeps(
  config: Config,
  storage: Storage,
  opts: CreateDefaultDepsOpts,
): Promise<DefaultDepsHandle> {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? {
    warn: (m: string, d?: unknown) => console.warn(`[app] ${m}`, d ?? ""),
  };
  const onError =
    opts.onError ?? ((err: unknown, where: string) => logger.warn(`${where} 出错`, err));

  // 缺 DEEPSEEK_API_KEY 直接 ConfigError（信息不含值）
  try {
    getSecret("DEEPSEEK_API_KEY", env);
  } catch {
    throw new ConfigError([
      "缺少环境变量 DEEPSEEK_API_KEY：请在启动前设置（值不会写入日志或配置）",
    ]);
  }

  const bus = createEventBus({
    initialSeq: storage.nextSeq(),
    onHandlerError: (info) => onError(info.error, `bus:${info.subscription}`),
  });

  const unsubs: Array<() => void> = [];
  // 在 assemble 之前 attach：预算台账与落库从建好起就挂在同一条总线上
  unsubs.push(storage.attach(bus, { onError: (f) => onError(f.error, "storage.attach") }));

  const pricingPath = opts.pricingPath ?? join(opts.repoRoot, "config", "pricing.json");
  const pricing = loadPricing(pricingPath);
  const budget = createBudget({
    budget: config.budget,
    pricing,
    ledger: storage.ledger,
  });
  unsubs.push(
    budget.attach(bus as BudgetBusLike, { onError: (f) => onError(f.error, "budget.attach") }),
  );

  const secret = (name: SecretName): string => getSecret(name, env);

  const gateway = createModelGateway({
    getConfig: () => config,
    pricing,
    budget,
    publish: (e) => bus.publish(e),
    getSecret: secret,
    onPublishError: (e) => onError(e, "gateway.publish"),
    onWarning: (w) => logger.warn(w.message),
  });

  const worktrees = await WorktreeManager.open(opts.repoRoot);
  await worktrees.ensureIgnored();
  const registry = new PermissionRegistry({
    logger: { warn: (m) => logger.warn(m) },
  });

  const coder = createCoderPool({
    getConfig: () => config,
    chat: (req) => gateway.chat(req),
    registry,
    promptTemplate: (role) => promptTemplate(role),
    architectureConstraints: async () => [],
    logger: { warn: (m) => logger.warn(m) },
  });

  const prSlot: { current: PrProvider | null } = { current: null };
  const reviewPr = createPrForwarder(prSlot);

  const reviewPool = createReviewPool({
    getConfig: () => config,
    call: (role, provider, model, effort, prompt, ctx, options) =>
      gateway.call(role, provider, model, effort, prompt, ctx, options),
    pr: reviewPr,
    promptTemplate: (role) => promptTemplate(role),
    publish: (e) => bus.publish(e),
    isRateLimited: (target) => {
      const st = gateway.rateLimitState(target);
      return st.models.some((m) => m.limited);
    },
    assignments: createRoundAssignmentStore({
      rounds: storageRoundSource(storage),
      logger: { warn: (m) => logger.warn(m) },
    }),
    logger: { warn: (m) => logger.warn(m) },
  });

  const worktreeRoot = join(worktrees.repoRoot, WORKTREES_DIR);

  const deps: AppDeps = {
    config,
    storage,
    bus,
    call: (role, provider, model, effort, prompt, ctx, options) =>
      gateway.call(role, provider, model, effort, prompt, ctx, options),
    promptTemplate: (role) => promptTemplate(role),
    coder: { runTicket: (input) => coder.runTicket(input) },
    review: (input) => reviewPool.review(input),
    budget: { budgetState: (id) => budget.budgetState(id) },
    createPr: async ({ eventContext, publish, store }) => {
      const pr = await createPrProvider({
        store,
        repo: worktrees.repoRoot,
        baseBranch: BASE_BRANCH,
        publish,
        eventContext,
        // 缺 GITHUB_TOKEN → createPrProvider 走本地模式，不抛
        getSecret: (name) => {
          try {
            return getSecret(name as SecretName, env);
          } catch {
            return undefined;
          }
        },
        logger: { warn: (m) => logger.warn(m) },
      });
      prSlot.current = pr;
      return pr;
    },
    worktrees: {
      create: (ticket_id, base, round) => worktrees.createWorktree(ticket_id, base, round),
      cleanup: (path) => worktrees.cleanup(path),
      // T-094：合入后清理；另认 origin/<目标分支>（GitHub 模式本地集成分支可能没快进），只读不删远程
      cleanupMerged: (ticket_id, merged_into) =>
        worktrees.cleanupMerged(ticket_id, { merged_into, remote: "origin" }),
    },
    worktreeRoot,
    targetHead: () => integrationTargetHead(worktrees.repoRoot, BASE_BRANCH),
    notifyUser: opts.notifyUser,
    listFiles: async (_project_id, commit) => {
      const { stdout } = await run("git", ["ls-tree", "-r", "--name-only", commit], {
        cwd: worktrees.repoRoot,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout.split("\n").filter((l) => l.length > 0);
    },
    architectureConstraints: async () => [],
    onError,
    logger,
  };

  return {
    deps,
    registry,
    reviewPr,
    bus,
    dispose() {
      while (unsubs.length > 0) unsubs.pop()?.();
    },
  };
}
