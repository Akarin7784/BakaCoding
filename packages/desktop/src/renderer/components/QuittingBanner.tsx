// T-106：退出收尾中的横幅。内容区标题栏下一条中性浅底横幅 + 转圈，文案固定；不挡操作（不是遮罩）。
import { Loader2 } from "lucide-react";
import { QUIT_COPY } from "../lib/copy";
import { Banner } from "./Banner";

export function QuittingBanner() {
  return (
    <div role="status" aria-live="polite" data-testid="quitting-status">
      <Banner
        icon={Loader2}
        iconClassName="animate-spin"
        tone="neutral"
        label={QUIT_COPY.title}
        testId="quitting-banner"
      >
        <span className="font-medium">{QUIT_COPY.title}</span>
        <span className="ml-2 text-muted-foreground">{QUIT_COPY.detail}</span>
      </Banner>
    </div>
  );
}
