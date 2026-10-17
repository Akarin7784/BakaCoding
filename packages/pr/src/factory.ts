import { LocalPrProvider, type LocalPrProviderOptions } from "./local.js";
import type { GetSecret, Logger, PrProvider } from "./provider.js";

export interface CreatePrProviderOptions extends LocalPrProviderOptions {
  getSecret: GetSecret;
  /** 默认 console */
  logger?: Logger;
}

let githubWarned = false;

/** 仅供测试：重置“每进程只警告一次”的标记。 */
export function resetGithubWarningForTests(): void {
  githubWarned = false;
}

/**
 * 返回本地实现。GitHub 实现不在 T-012：有 GITHUB_TOKEN 时也用本地实现，
 * 每个进程只打一次 warn，不发事件。
 */
export async function createPrProvider(opts: CreatePrProviderOptions): Promise<PrProvider> {
  const token = await opts.getSecret("GITHUB_TOKEN");
  if (token && !githubWarned) {
    githubWarned = true;
    (opts.logger ?? console).warn(
      "[bakacoding/pr] 检测到 GITHUB_TOKEN，但 GitHub PR 实现尚未提供，使用本地 PR 记录",
    );
  }
  return new LocalPrProvider(opts);
}
