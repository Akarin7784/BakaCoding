import type { Storage, TicketInput } from "@bakacoding/storage";
import { permissionFor } from "@bakacoding/workspace";
import { PermissionListSchema, type PermissionEntry, type PermissionList } from "@bakacoding/types";
import type { SubAgentTicket, TicketPermissionStore } from "./types.js";

// 每单权限清单以 2 的需求单记录（tickets.permission_list）为准（T-048，接口见 types.ts 的 TicketPermissionStore）。

/** 进程内存实现：deps.permissions 不注入时的默认值，只适合测试。 */
export function memoryTicketPermissions(): TicketPermissionStore {
  const lists = new Map<string, PermissionList>();
  return {
    get: (t) => lists.get(t.ticket_id),
    set: (t, l) =>
      void lists.set(
        t.ticket_id,
        l.map((e) => ({ ...e })),
      ),
  };
}

/** 用到的模块 2 存储能力（`openStorage` 返回的 Storage 满足）。 */
export type TicketRecordStorage = Pick<Storage, "query" | "saveTicket">;

/**
 * 模块 2 的适配器：读用 `query({ project_id, ticket_id })`，写用 `saveTicket`（整行 upsert，
 * 只换 permission_list，其余列原样带回）。读和写在同一个同步调用里完成，同进程里不会和写状态交错。
 * 记录还不存在时按需求单建一条（created_at 取当前时间、context_snippets 为空）。
 */
export function storageTicketPermissions(
  storage: TicketRecordStorage,
  now: () => Date = () => new Date(),
): TicketPermissionStore {
  const find = (t: SubAgentTicket) =>
    storage
      .query({ project_id: t.project_id, ticket_id: t.ticket_id })
      .find((r) => r.ticket_id === t.ticket_id);
  return {
    get(t) {
      return find(t)?.permission_list;
    },
    set(t, permission_list) {
      const list = PermissionListSchema.parse(permission_list);
      const rec = find(t);
      const row: TicketInput = rec
        ? {
            ticket_id: rec.ticket_id,
            project_id: rec.project_id,
            requirement_id: rec.requirement_id,
            created_at: rec.created_at,
            ticket_text: rec.ticket_text,
            ...(rec.decomposition_summary !== undefined
              ? { decomposition_summary: rec.decomposition_summary }
              : {}),
            ...(rec.status !== undefined ? { status: rec.status } : {}),
            ...(rec.outcome !== undefined ? { outcome: rec.outcome } : {}),
            base_commit: rec.base_commit,
            permission_list: list,
            context_snippets: rec.context_snippets,
            ...(rec.ci_checks !== undefined ? { ci_checks: rec.ci_checks } : {}),
          }
        : {
            ticket_id: t.ticket_id,
            project_id: t.project_id,
            requirement_id: t.requirement_id,
            created_at: now().toISOString(),
            ticket_text: t.ticket_text,
            base_commit: t.base_commit,
            permission_list: list,
            context_snippets: [],
          };
      storage.saveTicket(row);
    },
  };
}

// ---------- 生成与裁剪 ----------

const isGlobstar = (seg: string): boolean => seg.includes("**");
const hasWildcard = (seg: string): boolean => /[*?[\]{}]/.test(seg);

function segs(g: string): string[] {
  return g
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .split("/")
    .filter((s) => s !== "" && s !== ".");
}

/** 单段 a 能匹配到的名字是否都能被单段 b 匹配（字面量用模块 4 的匹配规则判断）。 */
function segContained(a: string, b: string): boolean {
  if (a === b || b === "*") return true;
  if (!hasWildcard(a)) return permissionFor([{ glob: b, level: "rw" }], a) === "rw";
  return false;
}

function containedFrom(g: string[], i: number, s: string[], j: number): boolean {
  if (j >= s.length) return i >= g.length;
  if (isGlobstar(s[j]!)) {
    if (j === s.length - 1) return true;
    // s 的 `**` 匹配零段，或吃掉 g 的一段（g 的 `**` 也能被它吃掉）
    return containedFrom(g, i, s, j + 1) || (i < g.length && containedFrom(g, i + 1, s, j));
  }
  if (i >= g.length || isGlobstar(g[i]!)) return false;
  return segContained(g[i]!, s[j]!) && containedFrom(g, i + 1, s, j + 1);
}

/**
 * glob `g` 能匹配到的路径是否全部落在写入范围 `scope` 里（任一条 glob 完整包含它）。保守判断：
 * 拿不准时返回 false（宁可多裁掉一条写权限）。字面量路径直接用模块 4 的 `permissionFor` 判。
 */
export function globWithinScope(g: string, scope: readonly string[]): boolean {
  const gs = segs(g);
  if (!gs.some(hasWildcard)) {
    return (
      permissionFor(
        scope.map((glob) => ({ glob, level: "rw" as const })),
        gs.join("/"),
      ) === "rw"
    );
  }
  return scope.some((s) => containedFrom(gs, 0, segs(s), 0));
}

/** 被裁掉的读写条目：原条目和裁剪后的级别。 */
export interface CutEntry {
  entry: PermissionEntry;
  reason: "outside_write_scope";
}

export interface GeneratedPermissions {
  permission_list: PermissionList;
  cut: CutEntry[];
}

/**
 * 按单生成三级权限清单（T-048，格式与默认拒绝沿用 `@bakacoding/types` / 模块 4，T-011）：
 * - 起点：需求单带的 `permission_list`（主管拆单时的建议）；没带就用「全仓只读 + 写入范围读写」。
 * - 裁剪：`rw` 条目不在写入范围内的降为 `ro`（只能读、不能写），记进 `cut` 由调用方记日志；`ro` / `deny` 原样保留。
 * - 没写写入范围的单按整个仓库 `**` 处理（与 9 一致），不裁剪。
 * - 结果一定非空：空清单在需求单记录里表示「8 还没生成」，所以真没条目时写一条显式的 `** deny`（效果同默认拒绝）。
 */
export function generatePermissionList(
  ticket: Pick<SubAgentTicket, "permission_list" | "write_scope">,
): GeneratedPermissions {
  const scope =
    ticket.write_scope && ticket.write_scope.length > 0 ? [...ticket.write_scope] : ["**"];
  const proposal: PermissionEntry[] =
    ticket.permission_list && ticket.permission_list.length > 0
      ? ticket.permission_list.map((e) => ({ glob: e.glob, level: e.level }))
      : [{ glob: "**", level: "ro" }, ...scope.map((glob) => ({ glob, level: "rw" as const }))];
  const cut: CutEntry[] = [];
  const out: PermissionEntry[] = proposal.map((e) => {
    if (e.level !== "rw" || globWithinScope(e.glob, scope)) return e;
    cut.push({ entry: e, reason: "outside_write_scope" });
    return { glob: e.glob, level: "ro" };
  });
  const permission_list = PermissionListSchema.parse(
    out.length > 0 ? out : [{ glob: "**", level: "deny" }],
  );
  return { permission_list, cut };
}

/**
 * 把批准的写入范围以 `rw` 追加到清单末尾（与模块 4 的 `PermissionRegistry.grant` 同一规则：后条覆盖前条）。
 * 同一个 glob 最后一次出现已经是 rw 的不重复追加。
 */
export function appendGrantedScope(
  list: readonly PermissionEntry[],
  granted_scope: readonly string[],
): PermissionList {
  const out = list.map((e) => ({ glob: e.glob, level: e.level }));
  for (const glob of granted_scope) {
    // 同一个 glob 最后一次出现已经是 rw：不重复追加（复投时重复写回是幂等的）
    const last = [...out].reverse().find((e) => e.glob === glob);
    if (last?.level === "rw") continue;
    out.push({ glob, level: "rw" });
  }
  return PermissionListSchema.parse(out);
}
