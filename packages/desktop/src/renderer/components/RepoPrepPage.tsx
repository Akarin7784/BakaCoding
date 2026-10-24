// UI-03a：项目准备页（docs/ui-design.md §4.1）。从只读横幅「准备仓库」进来，逐项检查当前仓库：
// git → 模型配置（T-113）→ commit → main → ignored，前一项不过后面灰掉；没通过的第一项给主按钮，写操作都先弹确认框。
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Circle, CircleAlert, CircleCheck, FolderClosed, RefreshCw } from "lucide-react";
import type {
  BakaDesktopApi,
  DesktopConfigCheck,
  DesktopConfigFixResult,
  DesktopRepoCheck,
  DesktopRepoFilesResult,
  DesktopRepoFixResult,
} from "../../shared/api";
import { failureText } from "../../shared/error-text";
import { notifyError, notifyOk } from "../lib/notify";
import type { RepoFixRoute } from "../lib/readonly";
import {
  CONFIG_COPY,
  configPlan,
  EXCLUDED_REASON,
  firstFailing,
  fixFailureReason,
  IDENTITY_LABEL,
  identityArg,
  identityFormFields,
  identityValid,
  ITEM_COPY,
  missingIdentity,
  parseBudgetUsd,
  PREP_COPY,
  prepItems,
  ROUTE_ITEM,
  shortFolder,
  type IdentityField,
  type PrepItemView,
  type RepoItemId,
} from "../lib/repoPrep";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { ModelSetupWizard, type WizardApi } from "./ModelSetupWizard";
import { WIZARD_COPY } from "../lib/secretItem";

export type RepoPrepApi = Pick<
  BakaDesktopApi,
  | "checkRepo"
  | "initRepo"
  | "listInitialFiles"
  | "initialCommit"
  | "createMainBranch"
  | "initConfig"
> &
  Partial<WizardApi>;

type Fix = "git" | "commit" | "main";
type DialogId = Fix | "config";

const OK_TEXT: Record<Fix, string> = {
  git: "已初始化 Git",
  commit: "已创建首次提交",
  main: "已新建 main 分支",
};
const FAIL_PREFIX: Record<Fix, string> = {
  git: "初始化 Git 失败",
  commit: "首次提交失败",
  main: "新建 main 失败",
};

function ItemIcon({ state }: { state: PrepItemView["state"] }) {
  if (state === "ok")
    return <CircleCheck size={18} strokeWidth={1.5} aria-hidden className="text-foreground" />;
  if (state === "fail")
    return <CircleAlert size={18} strokeWidth={1.5} aria-hidden className="text-danger" />;
  return <Circle size={18} strokeWidth={1.5} aria-hidden className="text-muted-foreground" />;
}

/** 确认框里的目标文件夹一行（只显示最后一级文件夹名，过长截断） */
function TargetFolder({ folder }: { folder: string | null }) {
  if (folder === null) return null;
  return (
    <p data-testid="target-folder" className="flex min-w-0 items-center gap-2">
      <FolderClosed size={16} strokeWidth={1.5} aria-hidden className="shrink-0" />
      <span className="shrink-0 text-muted-foreground">{PREP_COPY.targetFolder}</span>
      <span className="min-w-0 truncate font-medium">{shortFolder(folder)}</span>
    </p>
  );
}

const STATE_LABEL: Record<PrepItemView["state"], string> = {
  ok: "通过",
  fail: "未通过",
  blocked: "未检查",
};

export function RepoPrepPage({
  api,
  route,
  onBack,
  onFixed,
}: {
  api: RepoPrepApi;
  /** 从只读原因路由过来的那一项（repoFixRoute），高亮 */
  route?: RepoFixRoute | null;
  onBack: () => void;
  /** 写操作成功后（主进程已重新连接）：刷新后端状态 */
  onFixed?: () => void | Promise<void>;
}) {
  const [check, setCheck] = useState<DesktopRepoCheck | null>(null);
  const [config, setConfig] = useState<DesktopConfigCheck | null>(null);
  const [budget, setBudget] = useState("");
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  /** 这次生成过配置：页面上写明那两个文件没有提交进仓库 */
  const [generated, setGenerated] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dialog, setDialog] = useState<DialogId | null>(null);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<DesktopRepoFilesResult | null>(null);
  const [identity, setIdentity] = useState({ name: "", email: "" });
  const [wizardOpen, setWizardOpen] = useState(false);

  const recheck = useCallback(async () => {
    if (!api.checkRepo) return;
    setLoading(true);
    try {
      const r = await api.checkRepo();
      if (r.ok) {
        setCheck(r.check);
        setConfig(r.config ?? null);
        setFolder(typeof r.folder === "string" ? r.folder : null);
        setError(null);
      } else setError(r.reason);
    } catch {
      setError("和主进程通信失败，请重试");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void recheck();
  }, [recheck]);

  const open = async (fix: DialogId) => {
    setIdentity({ name: "", email: "" });
    // 预算不预填：每次打开都是空的
    setBudget("");
    setConfirmOverwrite(false);
    setFiles(null);
    setDialog(fix);
    if (fix === "commit" && api.listInitialFiles) {
      try {
        setFiles(await api.listInitialFiles());
      } catch {
        setFiles({ ok: false, code: "git_failed", reason: "和主进程通信失败，请重试" });
      }
    }
  };

  const run = async (fix: Fix, call: () => Promise<DesktopRepoFixResult> | undefined) => {
    setBusy(true);
    try {
      const r = await call();
      if (!r) return;
      if (!r.ok) {
        notifyError(failureText(FAIL_PREFIX[fix], fixFailureReason(r)));
        return;
      }
      setDialog(null);
      if (r.reload.state === "failed")
        notifyError(failureText(`${OK_TEXT[fix]}，但重新连接失败`, r.reload.reason));
      else notifyOk(OK_TEXT[fix]);
      await onFixed?.();
    } catch {
      notifyError(`${FAIL_PREFIX[fix]}：和主进程通信失败，请重试`);
    } finally {
      setBusy(false);
      await recheck();
    }
  };

  const runConfig = async (req: { daily_micro_usd?: number; confirm_overwrite?: boolean }) => {
    setBusy(true);
    try {
      const r: DesktopConfigFixResult | undefined = await api.initConfig?.(req);
      if (!r) return;
      if (!r.ok) {
        notifyError(failureText(CONFIG_COPY.failPrefix, r.reason));
        return;
      }
      setDialog(null);
      if (r.written.length > 0) setGenerated(true);
      if (r.reload.state === "failed")
        notifyError(failureText(`${CONFIG_COPY.ok}，但重新连接失败`, r.reload.reason));
      else notifyOk(CONFIG_COPY.ok);
      await onFixed?.();
    } catch {
      notifyError(`${CONFIG_COPY.failPrefix}：和主进程通信失败，请重试`);
    } finally {
      setBusy(false);
      await recheck();
    }
  };

  const items = check ? prepItems(check, config ?? undefined) : [];
  const first = check ? firstFailing(check, config ?? undefined) : null;
  const plan = config ? configPlan(config) : null;
  const micro = parseBudgetUsd(budget);
  const canGenerate =
    !!plan &&
    plan.create.length + plan.overwrite.length > 0 &&
    (!plan.needBudget || micro !== null) &&
    (plan.overwrite.length === 0 || confirmOverwrite);
  const highlight: RepoItemId | null = route ? ROUTE_ITEM[route] : null;
  const missingAll = check ? missingIdentity(check.identity) : [];
  // 表单里只显示缺的字段（UI-03b：只缺一项时只填那一项）
  const missing = identityFormFields(missingAll);
  const canCommit = identityValid(missing, identity);
  const currentBranch = check?.items.find((i) => i.id === "main")?.current ?? check?.current_branch;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="repo-prep">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-6 py-8">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="flex min-w-0 items-baseline gap-2 text-lg font-semibold">
              <span className="shrink-0">{PREP_COPY.title}</span>
              {folder !== null && (
                <span
                  data-testid="prep-folder"
                  className="min-w-0 truncate font-normal text-muted-foreground"
                >
                  {shortFolder(folder)}
                </span>
              )}
            </h1>
            <p className="mt-1 text-muted-foreground">{PREP_COPY.intro}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={onBack}>
            <ArrowLeft strokeWidth={1.5} />
            {PREP_COPY.back}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={loading || busy}
            onClick={() => void recheck()}
          >
            <RefreshCw strokeWidth={1.5} className={loading ? "animate-spin" : undefined} />
            {loading ? PREP_COPY.checking : PREP_COPY.recheck}
          </Button>
        </div>

        {error && (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-foreground">
            {failureText(PREP_COPY.checkFailed, error)}
          </p>
        )}

        <ol aria-label="检查项" className="flex flex-col rounded-xl border border-border">
          {items.map((it) => (
            <li
              key={it.id}
              data-testid={`prep-item-${it.id}`}
              data-state={it.state}
              aria-current={highlight === it.id && it.state === "fail" ? "step" : undefined}
              className={cn(
                "flex items-start gap-3 border-b border-border px-4 py-3 last:border-b-0",
                it.state === "blocked" && "text-muted-foreground",
                highlight === it.id && it.state === "fail" && "bg-hover",
              )}
            >
              <span className="pt-0.5">
                <ItemIcon state={it.state} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{it.title}</span>
                  <span className="text-xs text-muted-foreground">{STATE_LABEL[it.state]}</span>
                </div>
                {it.state === "fail" && <p className="mt-0.5 break-words">{it.detail}</p>}
                {it.state === "fail" && it.note && (
                  <p className="mt-0.5 text-xs text-muted-foreground">{it.note}</p>
                )}
                {it.state === "blocked" && <p className="mt-0.5 text-xs">{PREP_COPY.blocked}</p>}
                {it.id === "config" && it.state === "ok" && generated && (
                  <p
                    data-testid="config-not-committed"
                    className="mt-0.5 text-xs text-muted-foreground"
                  >
                    {CONFIG_COPY.notCommitted}
                  </p>
                )}
              </div>
              {it.state === "fail" && it.action && (
                <Button
                  size="sm"
                  variant={first === it.id ? "primary" : "secondary"}
                  disabled={busy || it.disabled === true}
                  onClick={() => void open(it.id as DialogId)}
                >
                  {it.action}
                </Button>
              )}
            </li>
          ))}
          {!check && !error && (
            <li className="px-4 py-3 text-muted-foreground">{PREP_COPY.checking}</li>
          )}
        </ol>

        {check && first === null && (
          <div data-testid="prep-all-ok" className="flex items-center gap-2">
            <CircleCheck size={18} strokeWidth={1.5} aria-hidden />
            <span className="font-medium">{PREP_COPY.allOk}</span>
            <span className="text-muted-foreground">{PREP_COPY.allOkHint}</span>
          </div>
        )}

        {/* UI-03b：仓库都准备好了，接着在这里打开模型设置向导（密钥 + 测试连接），不另开页面 */}
        {check && first === null && api.secretStatus && api.testProvider && (
          <div
            data-testid="prep-model"
            className="flex items-center gap-3 rounded-xl border border-border px-4 py-3"
          >
            <span className="min-w-0 flex-1 text-muted-foreground">{WIZARD_COPY.prepHint}</span>
            <Button size="sm" onClick={() => setWizardOpen(true)}>
              {WIZARD_COPY.prepEntry}
            </Button>
          </div>
        )}
        {wizardOpen && api.secretStatus && (
          <ModelSetupWizard open={wizardOpen} onOpenChange={setWizardOpen} api={api} />
        )}
      </div>

      {/* 初始化 Git */}
      <Dialog open={dialog === "git"} onOpenChange={(o) => !o && !busy && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{ITEM_COPY.git.action}</DialogTitle>
            <DialogDescription>
              在这个文件夹里执行 git init，并把默认分支设成 main。你的文件不会被改动，也不会提交。
            </DialogDescription>
          </DialogHeader>
          <TargetFolder folder={folder} />
          <DialogFooter>
            <Button variant="secondary" disabled={busy} onClick={() => setDialog(null)}>
              {PREP_COPY.cancel}
            </Button>
            <Button disabled={busy} onClick={() => void run("git", () => api.initRepo?.({}))}>
              {busy ? "初始化中…" : ITEM_COPY.git.action}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 生成配置（T-113）：预算必填不预填；覆盖不合法的文件要勾确认（先备份） */}
      <Dialog open={dialog === "config"} onOpenChange={(o) => !o && !busy && setDialog(null)}>
        <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{CONFIG_COPY.title}</DialogTitle>
            <DialogDescription>{CONFIG_COPY.intro}</DialogDescription>
          </DialogHeader>
          <TargetFolder folder={folder} />
          {plan && plan.create.length > 0 && (
            <section aria-label={CONFIG_COPY.create} data-testid="config-create">
              <h3 className="mb-1 font-medium">{CONFIG_COPY.create}</h3>
              <ul className="rounded-lg border border-border px-3 py-2 font-mono text-xs">
                {plan.create.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </section>
          )}
          {plan && plan.overwrite.length > 0 && (
            <section aria-label={CONFIG_COPY.overwrite} data-testid="config-overwrite">
              <h3 className="mb-1 font-medium">{CONFIG_COPY.overwrite}</h3>
              <ul className="rounded-lg border border-border px-3 py-2 font-mono text-xs">
                {plan.overwrite.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted-foreground">{CONFIG_COPY.backupNote}</p>
              {config && config.errors.length > 0 && (
                <details className="mt-1 text-xs">
                  <summary className="cursor-pointer text-muted-foreground">
                    {CONFIG_COPY.errorsTitle}（{config.errors.length}）
                  </summary>
                  <ul className="mt-1 max-h-24 overflow-y-auto break-words">
                    {config.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          )}
          {plan?.needBudget && (
            <label className="flex flex-col gap-1">
              <span className="font-medium">{CONFIG_COPY.budgetLabel}</span>
              <Input
                name="daily-budget"
                inputMode="decimal"
                autoComplete="off"
                required
                aria-invalid={budget.trim() !== "" && micro === null}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
              <span className="text-xs text-muted-foreground">
                {budget.trim() !== "" && micro === null
                  ? CONFIG_COPY.budgetInvalid
                  : CONFIG_COPY.budgetHint}
              </span>
            </label>
          )}
          {plan && plan.overwrite.length > 0 && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="confirm-overwrite"
                className="size-4 accent-[var(--color-foreground)]"
                checked={confirmOverwrite}
                onChange={(e) => setConfirmOverwrite(e.target.checked)}
              />
              <span>{CONFIG_COPY.confirm}</span>
            </label>
          )}
          <p data-testid="config-exclude-note" className="text-muted-foreground">
            {CONFIG_COPY.notCommitted}
          </p>
          <DialogFooter>
            <Button variant="secondary" disabled={busy} onClick={() => setDialog(null)}>
              {PREP_COPY.cancel}
            </Button>
            <Button
              disabled={busy || !canGenerate}
              onClick={() =>
                void runConfig({
                  ...(plan?.needBudget && micro !== null && { daily_micro_usd: micro }),
                  ...(plan && plan.overwrite.length > 0 && { confirm_overwrite: confirmOverwrite }),
                })
              }
            >
              {busy ? CONFIG_COPY.busy : CONFIG_COPY.title}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 首次提交 */}
      <Dialog open={dialog === "commit"} onOpenChange={(o) => !o && !busy && setDialog(null)}>
        <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{ITEM_COPY.commit.action}</DialogTitle>
            <DialogDescription>
              提交到 main。副 Agent 只能看到已提交的代码，所以要先有一次提交。
            </DialogDescription>
          </DialogHeader>
          <TargetFolder folder={folder} />
          <p data-testid="unstaged-note" className="text-muted-foreground">
            {PREP_COPY.unstagedNote}
          </p>
          {generated && (
            <p data-testid="commit-config-note" className="text-muted-foreground">
              {CONFIG_COPY.notCommitted}
            </p>
          )}
          <CommitBody
            files={files}
            missing={missing}
            identity={identity}
            onIdentity={setIdentity}
          />
          <DialogFooter className="sticky bottom-0 -mx-6 -mb-6 flex-wrap rounded-b-2xl border-t border-border bg-popover px-6 py-4">
            <Button variant="secondary" disabled={busy} onClick={() => setDialog(null)}>
              {PREP_COPY.cancel}
            </Button>
            {files?.ok && files.include.length > 0 && (
              <Button
                variant="secondary"
                disabled={busy || !canCommit}
                onClick={() =>
                  void run("commit", () =>
                    api.initialCommit?.({ empty: true, ...idArg(missing, identity) }),
                  )
                }
              >
                只做空提交
              </Button>
            )}
            <Button
              disabled={busy || !files?.ok || !canCommit}
              onClick={() =>
                void run("commit", () =>
                  files?.ok && files.include.length > 0
                    ? api.initialCommit?.({ files: files.include, ...idArg(missing, identity) })
                    : api.initialCommit?.({ empty: true, ...idArg(missing, identity) }),
                )
              }
            >
              {busy
                ? "提交中…"
                : files?.ok && files.include.length > 0
                  ? `提交 ${files.include.length} 个文件`
                  : "创建空提交"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 新建 main */}
      <Dialog open={dialog === "main"} onOpenChange={(o) => !o && !busy && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{ITEM_COPY.main.action}</DialogTitle>
            <DialogDescription>
              {currentBranch ? `从当前分支 ${currentBranch} 新建 main。` : "从当前提交新建 main。"}
              只新建，不切换、不改名、不删除原来的分支。
            </DialogDescription>
          </DialogHeader>
          <TargetFolder folder={folder} />
          <DialogFooter>
            <Button variant="secondary" disabled={busy} onClick={() => setDialog(null)}>
              {PREP_COPY.cancel}
            </Button>
            <Button
              disabled={busy}
              onClick={() => void run("main", () => api.createMainBranch?.())}
            >
              {busy ? "新建中…" : "新建 main"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const idArg = identityArg;

function CommitBody({
  files,
  missing,
  identity,
  onIdentity,
}: {
  files: DesktopRepoFilesResult | null;
  missing: IdentityField[];
  identity: { name: string; email: string };
  onIdentity: (v: { name: string; email: string }) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {!files && <p className="text-muted-foreground">正在列出文件…</p>}
      {files && !files.ok && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2">
          {failureText("列出文件失败", files.reason)}
        </p>
      )}
      {files?.ok && (
        <>
          <section aria-label="将提交的文件">
            <h3 className="mb-1 font-medium">将提交的文件（{files.include.length}）</h3>
            {files.include.length === 0 ? (
              <p className="text-muted-foreground">文件夹里没有可提交的文件，会做一次空提交。</p>
            ) : (
              <ul
                data-testid="include-list"
                className="max-h-36 overflow-y-auto rounded-lg border border-border px-3 py-2 font-mono text-xs"
              >
                {files.include.map((f) => (
                  <li key={f} className="truncate" title={f}>
                    {f}
                  </li>
                ))}
              </ul>
            )}
          </section>
          {files.excluded.length > 0 && (
            <section aria-label="默认不提交的文件">
              <h3 className="mb-1 font-medium">默认不提交（{files.excluded.length}）</h3>
              <ul
                data-testid="excluded-list"
                className="max-h-24 overflow-y-auto rounded-lg border border-border px-3 py-2 text-xs"
              >
                {files.excluded.map((f) => (
                  <li key={f.path} className="flex gap-2">
                    <span className="min-w-0 truncate font-mono" title={f.path}>
                      {f.path}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {EXCLUDED_REASON[f.reason]}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {missing.length > 0 && (
        <section aria-label="Git 身份" data-testid="identity-form" className="flex flex-col gap-2">
          <h3 className="font-medium">
            {missing.length === 2 ? "还没设置 Git 身份" : `还没设置 ${IDENTITY_LABEL[missing[0]!]}`}
          </h3>
          {missing.map((f) => (
            <label key={f} className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{IDENTITY_LABEL[f]}</span>
              <Input
                name={f}
                type={f === "email" ? "email" : "text"}
                autoComplete="off"
                value={identity[f]}
                onChange={(e) => onIdentity({ ...identity, [f]: e.target.value })}
              />
            </label>
          ))}
          <p className="text-xs text-muted-foreground">{PREP_COPY.identityHint}</p>
        </section>
      )}
    </div>
  );
}
