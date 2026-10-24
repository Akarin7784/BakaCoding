// UI-01：界面文案表（docs/ui-design.md §5.6）。状态、消息类型、上报原因等面向用户的叫法都集中在这里，
// 组件只按 key 取文案，不各自写字面量。
// - `merged` 一律叫「已合入」（合入集成分支）；合入 main 单独叫「已合入 main」；全界面不出现另一种说法。
// - 面向用户的「复投」统一叫「重写」（内部术语、类型名、事件名不变）。
import type { TicketStatus } from "@bakacoding/types";
import type { EscalationView, GroupMessageKind } from "../mock/types";

/** 合入相关叫法。 */
export const MERGE_COPY = {
  /** 合入集成分支（TicketStatus `merged`） */
  merged: "已合入",
  /** 集成分支合入 main */
  mergedMain: "已合入 main",
  /** 合入 main 的按钮 */
  mergeMainAction: "合入 main",
} as const;

/** 复投在界面上的叫法。 */
export const RESUBMIT_COPY = {
  label: "重写",
  count: (n: number) => `重写 ${n} 次`,
  countTitle: "重写次数",
} as const;

/** 需求单状态（以 `@bakacoding/types` 的 TicketStatus 为准，新增状态时这里编译不过）。 */
export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  pending: "排队",
  coding: "编码中",
  in_review: "评审中",
  resubmitting: RESUBMIT_COPY.label,
  merge_queued: "合并队列",
  conflict: "冲突",
  re_reviewing: "重新评审",
  merged: MERGE_COPY.merged,
  escalated: "需要人工介入",
};

/** 需求页步骤条的五步（§4.4）。 */
export const TICKET_STEPS = ["pending", "coding", "in_review", "merge_queued", "merged"] as const;
export type TicketStep = (typeof TICKET_STEPS)[number];
export const TICKET_STEP_LABEL: Record<TicketStep, string> = {
  pending: "排队",
  coding: "编码",
  in_review: "评审",
  merge_queued: "合并队列",
  merged: MERGE_COPY.merged,
};

/**
 * UI-05b：步骤条（§4.4）。当前所在步取快照 `tickets` 的状态；
 * 「冲突」「重新评审」小标记只来自 `ticket_status_changed` 事件。
 */
export const STEPPER_COPY = {
  label: (ticket_id: string) => `${ticket_id} 进度`,
  /** 评审步骤：第 N 轮 / 上限 */
  reviewRound: (n: number, limit: number) => `第 ${n} 轮 / ${limit}`,
  conflictMark: "冲突",
  reReviewMark: "重新评审",
  /** 标记出现次数（大于 1 时显示） */
  markCount: (n: number) => `×${n}`,
  needsYou: "需要你处理",
  stepDone: "已完成",
  stepCurrent: "当前",
} as const;

/** 群消息类型（§4.5.1 类型标签）。 */
export const GROUP_MESSAGE_KIND_LABEL: Record<GroupMessageKind, string> = {
  dispatch: "派单",
  report: "汇报",
  review_verdict: "评审结论",
  resubmit: RESUBMIT_COPY.label,
  escalation: "上报",
};

/** escalated 的原因。 */
export const ESCALATION_REASON_LABEL: Record<EscalationView["reason"], string> = {
  review_limit: "评审重写超限",
  conflict_limit: "冲突重写超限",
  scope_lock_failed: "写入范围锁定失败",
  resplit_limit: "重新拆单超限",
  github_manual: "需人工处理 GitHub",
  coder_failed: "编码多次未完成",
  budget_exceeded: "本单预算用完",
  internal_error: "内部错误",
  merged_but: "合并后续步骤失败",
  high_risk_rejected: "用户拒绝了高风险 PR",
};

/** 退出收尾中（T-106）：固定文案，不带路径和原因。 */
export const QUIT_COPY = {
  title: "正在退出…",
  detail: "正在等后台任务收尾，完成后窗口会自动关闭",
} as const;

/** 导入缺配置（T-081）：内容区「缺配置」横幅 + 用默认模板创建（§3：页面横幅带操作按钮）。 */
export const CONFIG_COPY = {
  bannerLabel: "缺配置",
  text: "项目缺配置文件，可以用默认模板创建",
  create: "用默认模板创建",
} as const;

/**
 * 右面板「动态」（§4.5.1，T-127）：只显示 Agent 之间互相发的消息。
 * `group_message` 事件只有 sender，接收方按消息类型推：主管发的派给该单副 Agent，副 Agent 发的都回主管。
 */
export const ACTIVITY_COPY = {
  label: "动态",
  empty: "还没有动态",
  noProject: "还没有项目",
  filterLabel: "按单过滤",
  filterAll: "全部",
  backToLatest: "回到最新",
  idle: "没有在跑的单",
  expand: "展开",
  collapse: "收起",
  supervisor: "主管",
  subAgent: (ticket_id: string | null) => (ticket_id ? `副 Agent ${ticket_id}` : "副 Agent"),
} as const;

/** 主管对话输入框（UI-04b，§4.2）：项目 chip + 发送图标按钮。 */
export const COMPOSER_COPY = {
  inputLabel: "发给主管",
  placeholder: "提需求或人工介入，说清是哪个项目",
  send: "发送",
  chipLabel: "选择项目",
  noProject: "不指定",
} as const;

/** UI-04c：主管回复卡片、等待、失败重试、空状态（docs/ui-design.md §4.2）。 */
export const CHAT_COPY = {
  decisionSaved: "已记下",
  dispatched: "已派单",
  /** 「已派单」卡片：拆出 N 张单 */
  ticketCount: (n: number) => `拆出 ${n} 张单`,
  ticketList: "单号：",
  requirement: "需求",
  retrySplit: "重试拆单",
  retrySplitting: "拆单中…",
  /** 重试拆单成功后本地补的一条（不落库） */
  splitRetried: (n: number) => `已重新拆单，拆出 ${n} 张单。`,
  splitFailed: "重试拆单失败",
  pickProject: "选择项目",
  waiting: "主管思考中",
  sendFailed: "没发出去",
  retry: "重试",
  emptyTitle: "跟主管说说你想做什么",
  emptyHint: "点一个示例填进输入框，改好再发。",
  examples: [
    "给商城项目加一个按手机号登录的页面",
    "后台的订单列表加上按日期筛选",
    "记一条决策：所有接口统一返回 snake_case 字段",
  ],
} as const;

/** 需求页（UI-05c，docs/ui-design.md §4.4）。 */
export const REQUIREMENT_PAGE_COPY = {
  label: "需求页",
  original: "需求原文",
  expand: "展开全文",
  collapse: "收起",
  splitAt: (t: string) => `拆单时间 ${t}`,
  summary: "拆单推理摘要",
  tickets: "需求单进度",
  noTickets: "这个需求还没有需求单",
  timeline: "时间线",
  noTimeline: "还没有动态",
  /** 后端只读 / 详情读不到时的固定提示（不显示主进程原因里的任何输入） */
  detailUnavailable: "需求原文暂时读不到（后端只读或未接线），下面的进度来自快照。",
  loading: "正在读取需求…",
  notFound: "找不到这个需求",
  back: "返回",
  supervisor: "主管",
  subAgent: (ticket_id: string | null) => (ticket_id ? `副 Agent ${ticket_id}` : "副 Agent"),
  flashRow: (effort: string, tokens: string, secs: string, n: number) =>
    `Flash 调用${n > 1 ? ` ×${n}` : ""} · ${effort} · ${tokens} tokens · ${secs}s`,
  modelRow: (effort: string, tokens: string, secs: string, n: number) =>
    `模型调用${n > 1 ? ` ×${n}` : ""} · ${effort} · ${tokens} tokens · ${secs}s`,
  statusChange: (from: string, to: string) => `${from} → ${to}`,
  escalated: "上报",
  warning: "警告",
} as const;
