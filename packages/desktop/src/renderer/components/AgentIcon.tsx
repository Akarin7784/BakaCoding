// 主管和副 Agent 共用 lucide Bot，主管头顶多一颗小星。
import { Bot, Star } from "lucide-react";

export function AgentIcon({
  supervisor = false,
  size = 18,
}: {
  supervisor?: boolean;
  size?: number;
}) {
  return (
    <span
      className="relative inline-flex shrink-0"
      data-testid={supervisor ? "icon-supervisor" : "icon-agent"}
    >
      <Bot size={size} strokeWidth={1.5} aria-hidden />
      {supervisor && (
        <Star
          size={8}
          strokeWidth={2}
          className="absolute -top-1 left-1/2 -translate-x-1/2"
          aria-label="主管"
        />
      )}
    </span>
  );
}
