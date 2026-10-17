// UI-03a：项目准备页（docs/ui-design.md §4.1）。从只读横幅「准备仓库」进来，逐项检查当前仓库：
// git → commit → main → ignored，前一项不过后面灰掉；没通过的第一项给主按钮，写操作都先弹确认框。
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Circle, CircleAlert, CircleCheck, RefreshCw } from "lucide-react";
import type {
  BakaDesktopApi,
  DesktopRepoCheck,
  DesktopRepoFilesResult,
  DesktopRepoFixResult,
} from "../../shared/api";
import { failureText } from "../../shared/error-text";
import { notifyError, notifyOk } from "../lib/notify";
import type { RepoFixRoute } from "../lib/readonly";
import {
  EXCLUDED_REASON,
  firstFailing,
  IDENTITY_LABEL,
  identityCommand,
  identityFormFields,
  identityValid,
  ITEM_COPY,
  missingIdentity,
  PREP_COPY,
  prepItems,
  ROUTE_ITEM,
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

export type RepoPrepApi = Pick<
  BakaDesktopApi,
  "checkRepo" | "initRepo" | "listInitialFiles" | "initialCommit" | "createMainBranch"
>;

type Fix = "git" | "commit" | "main";

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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dialog, setDialog] = useState<Fix | null>(null);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<DesktopRepoFilesResult | null>(null);
  const [identity, setIdentity] = useState({ name: "", email: "" });

  const recheck = useCallback(async () => {
    if (!api.checkRepo) return;
    setLoading(true);
    try {
      const r = await api.checkRepo();
      if (r.ok) {
        setCheck(r.check);
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

  const open = async (fix: Fix) => {
    setIdentity({ name: "", email: "" });
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
        notifyError(failureText(FAIL_PREFIX[fix], r.reason));
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

  const items = check ? prepItems(check) : [];
  const first = check ? firstFailing(check) : null;
  const highlight: RepoItemId | null = route ? ROUTE_ITEM[route] : null;
  const missingAll = check ? missingIdentity(check.identity) : [];
  // 表单里显示的字段（两项都缺时）；只缺一项时不出表单、不能提交，提示用命令行补
  const missing = identityFormFields(missingAll);
  const partialIdentity = missingAll.length === 1 ? missingAll[0]! : null;
  const canCommit = partialIdentity === null && identityValid(missing, identity);
  const currentBranch = check?.items.find((i) => i.id === "main")?.current ?? check?.current_branch;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="repo-prep">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-6 py-8">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold">{PREP_COPY.title}</h1>
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
              </div>
              {it.state === "fail" && it.action && (
                <Button
                  size="sm"
                  variant={first === it.id ? "primary" : "secondary"}
                  disabled={busy}
                  onClick={() => void open(it.id as Fix)}
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

      {/* 首次提交 */}
      <Dialog open={dialog === "commit"} onOpenChange={(o) => !o && !busy && setDialog(null)}>
        <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{ITEM_COPY.commit.action}</DialogTitle>
            <DialogDescription>
              提交到 main。副 Agent 只能看到已提交的代码，所以要先有一次提交。
            </DialogDescription>
          </DialogHeader>
          <CommitBody
            files={files}
            missing={missing}
            partial={partialIdentity}
            identity={identity}
            onIdentity={setIdentity}
          />
          <p data-testid="unstaged-note" className="text-muted-foreground">
            {PREP_COPY.unstagedNote}
          </p>
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

/** 只把显示出来（缺的）字段传给主进程；没有缺的就不传 identity。 */
function idArg(
  missing: readonly IdentityField[],
  v: { name: string; email: string },
): { identity?: { name: string; email: string } } {
  if (missing.length === 0) return {};
  return { identity: { name: v.name.trim(), email: v.email.trim() } };
}

function CommitBody({
  files,
  missing,
  partial,
  identity,
  onIdentity,
}: {
  files: DesktopRepoFilesResult | null;
  missing: IdentityField[];
  partial: IdentityField | null;
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
      {partial && (
        <section
          aria-label="Git 身份"
          data-testid="identity-partial"
          className="flex flex-col gap-1"
        >
          <h3 className="font-medium">还没设置{IDENTITY_LABEL[partial]}</h3>
          <p className="text-muted-foreground">
            请在这个文件夹里运行下面的命令补上，再点「重新检查」：
          </p>
          <code className="rounded-md bg-hover px-2 py-1 font-mono text-xs">
            {identityCommand(partial)}
          </code>
        </section>
      )}
      {missing.length > 0 && (
        <section aria-label="Git 身份" data-testid="identity-form" className="flex flex-col gap-2">
          <h3 className="font-medium">还没设置 Git 身份</h3>
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
