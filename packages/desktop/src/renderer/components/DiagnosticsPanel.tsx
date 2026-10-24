// T-130：设置 › 诊断（docs/ui-design.md §4.6「诊断」、UI-09 粒度选择）。
// v1：三种粒度导出（最近 24 小时 / 指定时间段 / 需求单 / 单张单）、打开数据目录、最近一次启动错误详情。
// 保存路径仍由主进程弹保存框决定；渲染进程只传粒度，传不了路径。
import { useEffect, useMemo, useState } from "react";
import { FolderOpen, HardDriveDownload, TriangleAlert } from "lucide-react";
import type {
  BakaDesktopApi,
  DesktopBackendError,
  DesktopExportOptions,
  TicketView,
} from "../../shared/api";
import { failureText } from "../../shared/error-text";
import { notifyError, notifyOk } from "../lib/notify";
import { Button } from "./ui/button";

export const DIAG_COPY = {
  title: "诊断",
  hint: "导出的是脱敏后的日志、事件和 diff 片段，不含密钥。",
  scopeRecent: "最近 24 小时",
  scopeRange: "指定时间段",
  scopeRequirement: "按需求",
  scopeTicket: "按单张单",
  from: "开始",
  to: "结束",
  requirement: "需求",
  ticket: "单张单",
  export: "导出诊断包",
  exporting: "导出中…",
  openDataDir: "打开数据目录",
  lastError: "最近一次启动错误（已脱敏）",
  readonly: "只读模式下不能导出诊断包",
  noItems: "还没有需求单",
  invalidRange: "时间段不合法：开始要早于结束",
  missingPick: "先选一个需求或单张单",
  exported: (p: string) => `诊断包已导出：${p}`,
  opened: "已打开数据目录",
} as const;

type ScopeMode = "recent" | "range" | "requirement" | "ticket";

/** `datetime-local` 的本地时间 → ISO（UTC）；空串或解析失败返回 undefined。 */
function localToIso(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function requirementOptions(tickets: TicketView[]): { id: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const t of tickets) if (!seen.has(t.requirement_id)) seen.set(t.requirement_id, t.title);
  return [...seen].map(([id, label]) => ({ id, label: `${id} · ${label}` }));
}

export function DiagnosticsPanel({
  api,
  readonly = false,
}: {
  /** 没有 API（旧 preload / 浏览器预览 / 测试）时整块不渲染 */
  api?: BakaDesktopApi;
  readonly?: boolean;
}) {
  const [mode, setMode] = useState<ScopeMode>("recent");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [requirement, setRequirement] = useState("");
  const [ticket, setTicket] = useState("");
  const [items, setItems] = useState<TicketView[]>([]);
  const [error, setError] = useState<DesktopBackendError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    // 旧版 preload / 测试假 API 可能没有这两个方法
    if (!api.getSnapshot || !api.getBackendStatus) return;
    void api
      .getSnapshot()
      .then((snap) => {
        if (!alive) return;
        setItems(snap.tickets);
        const first = snap.tickets[0];
        if (first) {
          setRequirement((v) => v || first.requirement_id);
          setTicket((v) => v || first.ticket_id);
        }
      })
      .catch(() => {});
    void api
      .getBackendStatus()
      .then((st) => {
        if (alive && st.error) setError(st.error);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api]);

  const requirements = useMemo(() => requirementOptions(items), [items]);
  const ticketOptions = useMemo(
    () => items.map((t) => ({ id: t.ticket_id, label: `${t.ticket_id} · ${t.title}` })),
    [items],
  );

  if (!api?.exportDiagnostics) return null;

  const buildOptions = (): DesktopExportOptions | undefined | null => {
    if (mode === "recent") return undefined;
    if (mode === "range") {
      const f = localToIso(from);
      const t = localToIso(to);
      if (!f || !t || Date.parse(f) > Date.parse(t)) return null;
      return { scope: { kind: "time_range", from: f, to: t } };
    }
    if (mode === "requirement") {
      return requirement ? { scope: { kind: "requirement", requirement_id: requirement } } : null;
    }
    return ticket ? { scope: { kind: "ticket", ticket_id: ticket } } : null;
  };

  const exportNow = async () => {
    const options = buildOptions();
    if (mode === "range" && options === null) return notifyError(DIAG_COPY.invalidRange);
    if (mode !== "range" && mode !== "recent" && options === null)
      return notifyError(DIAG_COPY.missingPick);
    setBusy(true);
    try {
      const r = await api.exportDiagnostics(options ?? undefined);
      if (r.ok) notifyOk(DIAG_COPY.exported(r.path));
      else if (!r.canceled) notifyError(failureText("导出失败", r.reason));
    } catch {
      notifyError("导出失败：和主进程通信失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const openDataDir = async () => {
    if (!api.openDataDir) return;
    try {
      const r = await api.openDataDir();
      if (r.ok) notifyOk(DIAG_COPY.opened);
      else notifyError(failureText("打开数据目录失败", r.reason));
    } catch {
      notifyError("打开数据目录失败：和主进程通信失败，请重试");
    }
  };

  const errorRows = error
    ? ([
        ["错误名", error.name],
        ["信息", error.message],
        ...(error.code ? [["错误码", error.code] as [string, string]] : []),
        ...(error.cause
          ? [["起因", `${error.cause.name}：${error.cause.message}`] as [string, string]]
          : []),
      ] as [string, string][])
    : [];

  const inputClass =
    "h-8 rounded-md border border-border bg-transparent px-2 text-xs text-foreground focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";
  const radio = (value: ScopeMode, label: string, testId: string) => (
    <label className="flex items-center gap-1.5 text-xs">
      <input
        type="radio"
        name="diagnostics-scope"
        value={value}
        checked={mode === value}
        data-testid={testId}
        onChange={() => setMode(value)}
        className="accent-accent"
      />
      {label}
    </label>
  );

  return (
    <section aria-label={DIAG_COPY.title} data-testid="diagnostics-panel" className="space-y-2">
      <h3 className="text-xs text-muted-foreground">{DIAG_COPY.title}</h3>
      <p className="text-xs text-muted-foreground">{DIAG_COPY.hint}</p>
      <div className="flex flex-wrap items-center gap-3">
        {radio("recent", DIAG_COPY.scopeRecent, "diag-mode-recent")}
        {radio("range", DIAG_COPY.scopeRange, "diag-mode-range")}
        {radio("requirement", DIAG_COPY.scopeRequirement, "diag-mode-requirement")}
        {radio("ticket", DIAG_COPY.scopeTicket, "diag-mode-ticket")}
      </div>
      {mode === "range" && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1">
            {DIAG_COPY.from}
            <input
              type="datetime-local"
              value={from}
              data-testid="diag-from"
              onChange={(e) => setFrom(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex items-center gap-1">
            {DIAG_COPY.to}
            <input
              type="datetime-local"
              value={to}
              data-testid="diag-to"
              onChange={(e) => setTo(e.target.value)}
              className={inputClass}
            />
          </label>
        </div>
      )}
      {mode === "requirement" && (
        <label className="flex items-center gap-2 text-xs">
          {DIAG_COPY.requirement}
          <select
            value={requirement}
            data-testid="diag-requirement"
            onChange={(e) => setRequirement(e.target.value)}
            className={inputClass}
          >
            {requirements.length === 0 && <option value="">{DIAG_COPY.noItems}</option>}
            {requirements.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {mode === "ticket" && (
        <label className="flex items-center gap-2 text-xs">
          {DIAG_COPY.ticket}
          <select
            value={ticket}
            data-testid="diag-ticket"
            onChange={(e) => setTicket(e.target.value)}
            className={inputClass}
          >
            {ticketOptions.length === 0 && <option value="">{DIAG_COPY.noItems}</option>}
            {ticketOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          data-testid="diag-export"
          disabled={readonly || busy}
          title={readonly ? DIAG_COPY.readonly : undefined}
          onClick={() => void exportNow()}
        >
          <HardDriveDownload strokeWidth={1.5} />
          {busy ? DIAG_COPY.exporting : DIAG_COPY.export}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          data-testid="diag-open-data-dir"
          onClick={() => void openDataDir()}
        >
          <FolderOpen strokeWidth={1.5} />
          {DIAG_COPY.openDataDir}
        </Button>
        {readonly && <span className="text-xs text-muted-foreground">{DIAG_COPY.readonly}</span>}
      </div>
      {error && (
        <details data-testid="diag-last-error" className="text-xs">
          <summary className="flex cursor-pointer items-center gap-1 text-muted-foreground">
            <TriangleAlert size={12} strokeWidth={1.5} className="text-danger" aria-hidden />
            {DIAG_COPY.lastError}
          </summary>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {errorRows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="font-mono break-all whitespace-pre-wrap">{v}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </section>
  );
}
