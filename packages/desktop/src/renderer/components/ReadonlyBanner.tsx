// UI-08：只读横幅 + 详情弹层（§4.7）。
// 「只读模式：<人话原因>」[查看详情] [重新连接]；详情列脱敏后的错误名、信息、错误码、一层起因，可复制。
import { useState } from "react";
import { CircleAlert, Copy, RefreshCw, Wrench } from "lucide-react";
import type { DesktopBackendStatus } from "../../shared/api.js";
import {
  READONLY_COPY,
  readonlyDetailRows,
  readonlyDetailText,
  readonlyReason,
} from "../lib/readonly";
import { COPY_DETAIL, copyText } from "../lib/notify";
import { PREP_COPY } from "../lib/repoPrep";
import { toast } from "./ui/sonner";
import { Banner } from "./Banner";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

export function ReadonlyBanner({
  status,
  onReconnect,
  reconnecting = false,
  onPrepare,
}: {
  status: DesktopBackendStatus;
  /** UI-03a：仓库没准备好（repoFixRoute 有结果）时打开项目准备页；没有就不显示按钮 */
  onPrepare?: () => void;
  /** 没有就不显示「重新连接」（浏览器预览 / 旧 preload） */
  onReconnect?: () => void;
  reconnecting?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rows = readonlyDetailRows(status);
  return (
    <>
      <Banner
        icon={CircleAlert}
        label="只读模式"
        testId="readonly-banner"
        actions={
          <>
            {onPrepare && (
              <Button variant="secondary" size="sm" onClick={onPrepare}>
                <Wrench strokeWidth={1.5} />
                {PREP_COPY.bannerEntry}
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
              {READONLY_COPY.details}
            </Button>
            {onReconnect && (
              <Button variant="secondary" size="sm" disabled={reconnecting} onClick={onReconnect}>
                <RefreshCw
                  strokeWidth={1.5}
                  className={reconnecting ? "animate-spin" : undefined}
                />
                {reconnecting ? READONLY_COPY.reconnecting : READONLY_COPY.reconnect}
              </Button>
            )}
          </>
        }
      >
        <span className="font-medium">{READONLY_COPY.bannerPrefix}</span>
        <span data-testid="readonly-reason">{readonlyReason(status)}</span>
      </Banner>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>只读详情</DialogTitle>
            <DialogDescription>以下内容已脱敏，可以直接发给开发者。</DialogDescription>
          </DialogHeader>
          <dl data-testid="readonly-details" className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            {rows.map((r) => (
              <div key={r.label} className="contents">
                <dt className="text-muted-foreground">{r.label}</dt>
                <dd className="font-mono text-xs break-all whitespace-pre-wrap">{r.value}</dd>
              </div>
            ))}
          </dl>
          <DialogFooter>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                void copyText(readonlyDetailText(status)).then((ok) => ok && toast("已复制"))
              }
            >
              <Copy strokeWidth={1.5} />
              {COPY_DETAIL}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
