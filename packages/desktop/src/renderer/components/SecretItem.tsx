// UI-03b：密钥项（docs/ui-design.md §4.6「密钥」、§7.1）。显示是否已设 / 来源 / 末 4 位，可保存、可清除。
// 值只在点「保存」那一次交给主进程；点下去就清空输入框，组件状态里不留值。系统环境变量来源不给「清除」。
import { useCallback, useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import type { BakaDesktopApi, DesktopSecretName, DesktopSecretStatus } from "../../shared/api";
import { failureText } from "../../shared/error-text";
import { notifyError, notifyOk } from "../lib/notify";
import { canClearSecret, SECRET_COPY, SECRET_LABEL, secretStatusText } from "../lib/secretItem";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export type SecretApi = Pick<BakaDesktopApi, "secretStatus" | "setSecret" | "clearSecret">;

export function SecretItem({
  api,
  name,
  onChange,
  initialStatus,
}: {
  api: SecretApi;
  name: DesktopSecretName;
  /** 保存 / 清除成功后（新状态） */
  onChange?: (s: DesktopSecretStatus) => void;
  /** 截图 / 测试：先给一个状态，不等第一次读取 */
  initialStatus?: DesktopSecretStatus;
}) {
  const [status, setStatus] = useState<DesktopSecretStatus | null>(initialStatus ?? null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"save" | "clear" | null>(null);

  const load = useCallback(async () => {
    if (!api.secretStatus) return;
    try {
      const r = await api.secretStatus(name);
      if (r.ok) {
        setStatus(r.status);
        setError(null);
      } else setError(failureText(SECRET_COPY.statusFailed, r.reason));
    } catch {
      setError(failureText(SECRET_COPY.statusFailed, SECRET_COPY.ipcFailed));
    }
  }, [api, name]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (s: DesktopSecretStatus) => {
    setStatus(s);
    setError(null);
    onChange?.(s);
  };

  const save = async () => {
    if (!api.setSecret || draft.length === 0 || busy) return;
    const value = draft;
    // 先清空输入框：值只在这一次调用里经过
    setDraft("");
    setBusy("save");
    try {
      const r = await api.setSecret(name, value);
      if (!r.ok) {
        notifyError(failureText(SECRET_COPY.saveFailed, r.reason));
        return;
      }
      update(r.status);
      if (r.reload?.state === "failed")
        notifyError(failureText(`${SECRET_COPY.saved}，但重新连接失败`, r.reload.reason));
      else notifyOk(SECRET_COPY.saved);
    } catch {
      notifyError(failureText(SECRET_COPY.saveFailed, SECRET_COPY.ipcFailed));
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    if (!api.clearSecret || busy) return;
    setBusy("clear");
    try {
      const r = await api.clearSecret(name);
      if (!r.ok) {
        notifyError(failureText(SECRET_COPY.clearFailed, r.reason));
        if (r.code === "not_owned" || r.code === "not_set") void load();
        return;
      }
      update(r.status);
      notifyOk(SECRET_COPY.cleared);
    } catch {
      notifyError(failureText(SECRET_COPY.clearFailed, SECRET_COPY.ipcFailed));
    } finally {
      setBusy(null);
    }
  };

  const system = status?.set && status.source === "system";
  return (
    <div data-testid={`secret-${name}`} className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <KeyRound size={16} strokeWidth={1.5} aria-hidden className="shrink-0" />
        <span className="font-medium">{SECRET_LABEL[name]}</span>
        <code className="text-xs text-muted-foreground">{name}</code>
        <span
          data-testid={`secret-status-${name}`}
          className={cn(
            "ml-auto shrink-0 text-xs",
            status?.set ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {secretStatusText(status)}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Input
          type="password"
          name={name}
          aria-label={`${SECRET_LABEL[name]}的值`}
          autoComplete="off"
          spellCheck={false}
          placeholder={SECRET_COPY.placeholder}
          value={draft}
          disabled={busy !== null || !api.setSecret}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" disabled={busy !== null || draft.length === 0 || !api.setSecret}>
          {busy === "save" ? SECRET_COPY.saving : SECRET_COPY.save}
        </Button>
        {canClearSecret(status) && (
          <Button
            variant="secondary"
            disabled={busy !== null || !api.clearSecret}
            onClick={() => void clear()}
          >
            {busy === "clear" ? SECRET_COPY.clearing : SECRET_COPY.clear}
          </Button>
        )}
      </form>
      <p className="text-xs text-muted-foreground">
        {system ? SECRET_COPY.systemHint : SECRET_COPY.saveHint}
      </p>
    </div>
  );
}
