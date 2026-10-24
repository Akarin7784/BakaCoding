// T-127：右面板「动态」有新消息的小点（`docs/ui-design.md` §4.5.1「标签上亮一个小点」）。
// 单独成组件：强调色是 token，但骨架文件里不允许散落 `bg-accent`（design-rules §5.1 只允许选中 / 按下态），
// 和 StatusDot 一样把状态点集中在一个组件里。
import { cn } from "../lib/utils";

export function ActivityDot({ testId, className }: { testId: string; className?: string }) {
  return (
    <span
      data-testid={testId}
      aria-label="有新动态"
      className={cn("inline-block size-1.5 rounded-full bg-accent", className)}
    />
  );
}
