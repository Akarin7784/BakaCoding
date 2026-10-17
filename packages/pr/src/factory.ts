import {
  GithubPrProvider,
  parseGithubRemote,
  type EventContextFn,
  type FetchFn,
  type PublishEscalated,
} from "./github.js";
import { git } from "./git.js";
import { LocalPrProvider, type LocalPrProviderOptions } from "./local.js";
import type { GetSecret, Logger, PrProvider } from "./provider.js";

export interface CreatePrProviderOptions extends LocalPrProviderOptions {
  getSecret: GetSecret;
  /** 默认 console */
  logger?: Logger;
  /** 选中 GitHub 实现时必填：发 escalated(github_manual) 用 */
  publish?: PublishEscalated;
  /** 选中 GitHub 实现时必填：补事件公共字段（requirement_id、trace） */
  eventContext?: EventContextFn;
  fetch?: FetchFn;
  apiBase?: string;
  /** 测试用：覆盖 `git remote get-url origin` 的结果 */
  remoteUrl?: string;
}

async function originUrl(repo: string): Promise<string | undefined> {
  try {
    return (await git(repo, ["remote", "get-url", "origin"])).stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 读得到 GITHUB_TOKEN（经 getSecret）且 origin 是 github.com → GitHub 实现；否则本地实现。
 * getSecret 抛错（未设置）按读不到处理。
 */
export async function createPrProvider(opts: CreatePrProviderOptions): Promise<PrProvider> {
  let token: string | undefined;
  try {
    token = (await opts.getSecret("GITHUB_TOKEN")) || undefined;
  } catch {
    token = undefined;
  }
  if (!token || !opts.repo) return new LocalPrProvider(opts);
  const url = opts.remoteUrl ?? (await originUrl(opts.repo));
  const github = url ? parseGithubRemote(url) : null;
  if (!github) return new LocalPrProvider(opts);
  if (!opts.publish || !opts.eventContext)
    throw new Error("GitHub PR 实现需要 publish 和 eventContext（用于发 escalated 事件）");
  const { publish, eventContext } = opts;
  return new GithubPrProvider({ ...opts, repo: opts.repo, github, token, publish, eventContext });
}
