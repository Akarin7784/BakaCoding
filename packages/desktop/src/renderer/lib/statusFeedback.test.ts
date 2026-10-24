// UI-08 纯函数：全局状态点等级、只读文案与详情、窗口按钮留位（Window Controls Overlay）。
import { describe, expect, it } from "vitest";
import type { DesktopBackendStatus } from "../../shared/api";
import { isReadonlyStatus } from "../data/useBackendStatus";
import { projects as mockProjects } from "../mock/data";
import type { ProjectView } from "../mock/types";
import { attentionItems, globalLevel, runningCount } from "./globalStatus";
import { readonlyDetailRows, readonlyDetailText, readonlyReason } from "./readonly";
import { insetFromOverlay } from "./useWindowControlsInset";

const withStatus = (status: ProjectView["prs"][number]["status"]): ProjectView[] => [
  {
    ...mockProjects[0]!,
    prs: [
      {
        pr_id: "#1",
        ticket_id: "T-1",
        requirement_id: "R-1",
        title: "x",
        status,
        resubmit_count: 0,
      },
    ],
  },
];
const base = {
  readonly: false,
  dbError: false,
  syncAlert: false,
  pendingHighRisk: 0,
  unattributed: 0,
};

describe("全局状态点（§4.8）", () => {
  it("没有在跑的单 → 空闲；有 → 有单在跑", () => {
    expect(globalLevel({ ...base, projects: withStatus("merged") })).toBe("idle");
    expect(globalLevel({ ...base, projects: withStatus("pending") })).toBe("idle");
    for (const s of [
      "coding",
      "in_review",
      "re_reviewing",
      "resubmitting",
      "merge_queued",
    ] as const)
      expect(globalLevel({ ...base, projects: withStatus(s) })).toBe("running");
    expect(runningCount(mockProjects)).toBeGreaterThan(0);
  });

  it("需要你处理的事任何一件都变红，并逐条列出", () => {
    const idle = withStatus("merged");
    const cases: [Partial<typeof base> | { projects: ProjectView[] }, string][] = [
      [{ readonly: true }, "后端处于只读模式"],
      [{ dbError: true }, "数据库打不开"],
      [{ syncAlert: true }, "同步异常，见右面板 Git 区"],
      [{ pendingHighRisk: 2 }, "2 个高风险 PR 待裁决"],
      [{ unattributed: 3 }, "3 条未归属上报"],
      [{ projects: withStatus("conflict") }, "1 张单需要人工介入"],
      [{ projects: withStatus("escalated") }, "1 张单需要人工介入"],
    ];
    for (const [patch, text] of cases) {
      const input = { ...base, projects: idle, ...patch };
      expect(globalLevel(input)).toBe("attention");
      expect(attentionItems(input)).toEqual([text]);
    }
    // 红优先于在跑
    expect(globalLevel({ ...base, readonly: true, projects: withStatus("coding") })).toBe(
      "attention",
    );
  });
});

describe("只读文案（§4.7）", () => {
  const ro: DesktopBackendStatus = {
    mode: "readonly",
    reason: "启动失败（DiskError）",
    error: {
      name: "DiskError",
      message: "cannot open <仓库>/.bakacoding/bakacoding.db",
      code: "EACCES",
      cause: { name: "SqliteError", message: "unable to open" },
    },
  };

  it("只读 = mode readonly 或存储租约丢失", () => {
    expect(isReadonlyStatus(null)).toBe(false);
    expect(isReadonlyStatus({ mode: "live" })).toBe(false);
    expect(isReadonlyStatus(ro)).toBe(true);
    expect(
      isReadonlyStatus({
        mode: "live",
        storage: { ok: false, lease_lost: true, closed: false, ingest_failures: 0 },
      }),
    ).toBe(true);
  });

  it("原因：主进程给的原因；没有原因、租约丢失各有一句", () => {
    expect(readonlyReason(ro)).toBe("启动失败（DiskError）");
    expect(readonlyReason({ mode: "readonly" })).toBe("后端没有启动");
    expect(
      readonlyReason({
        mode: "live",
        storage: { ok: false, lease_lost: true, closed: false, ingest_failures: 0 },
      }),
    ).toContain("其他程序接管");
  });

  it("详情：错误名、信息、错误码、一层起因；没有就不列", () => {
    expect(readonlyDetailRows(ro).map((r) => r.label)).toEqual([
      "原因",
      "错误名",
      "信息",
      "错误码",
      "起因",
    ]);
    expect(readonlyDetailRows({ mode: "readonly", reason: "写入锁被占用（pid 7）" })).toEqual([
      { label: "原因", value: "写入锁被占用（pid 7）" },
    ]);
    expect(readonlyDetailText(ro)).toBe(
      [
        "原因：启动失败（DiskError）",
        "错误名：DiskError",
        "信息：cannot open <仓库>/.bakacoding/bakacoding.db",
        "错误码：EACCES",
        "起因：SqliteError：unable to open",
      ].join("\n"),
    );
  });
});

describe("窗口按钮留位：Window Controls Overlay", () => {
  const ov = (x: number, width: number, visible = true) => ({
    visible,
    getTitlebarAreaRect: () => ({ x, width }),
  });

  it("按标题栏可用区算左右要让出的宽度", () => {
    // Windows：可用区从 0 开始，右边 1280-1142=138 是系统按钮
    expect(insetFromOverlay(ov(0, 1142), 1280)).toEqual({ left: 0, right: 138 });
    // 系统按钮宽度变了（缩放、触屏模式）就跟着变
    expect(insetFromOverlay(ov(0, 1100.4), 1280)).toEqual({ left: 0, right: 180 });
    expect(insetFromOverlay(ov(80, 1200), 1280)).toEqual({ left: 80, right: 0 });
  });

  it("没有 API、叠层不可见、宽 0、抛错时返回 null（由调用方退回固定值）", () => {
    expect(insetFromOverlay(undefined, 1280)).toBeNull();
    expect(insetFromOverlay(ov(0, 1142, false), 1280)).toBeNull();
    expect(insetFromOverlay(ov(0, 0), 1280)).toBeNull();
    expect(
      insetFromOverlay(
        {
          getTitlebarAreaRect: () => {
            throw new Error("x");
          },
        },
        1280,
      ),
    ).toBeNull();
    expect(insetFromOverlay(ov(0, 1142), 0)).toBeNull();
  });
});
