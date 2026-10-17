import type { Storage, TicketInput } from "@bakacoding/storage";
import { permissionFor } from "@bakacoding/workspace";
import {
  PermissionListSchema,
  type BakaEvent,
  type PermissionEntry,
  type PermissionList,
} from "@bakacoding/types";
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
/** 带通配的段（含 minimatch 的字符类、花括号、extglob 括号），不当字面量处理。 */
const hasWildcard = (seg: string): boolean => /[*?[\]{}()]/.test(seg);

/**
 * 不安全的 glob（安全修复，#47 评审）：可能经 `..` / `.` 等解析逃出写入范围、或被 minimatch 当成特殊语法的，
 * 一律不算落在任何写入范围里（写权限降为只读）；出现在写入范围里时该条范围不匹配任何东西。保守判断：
 * - 任何位置出现 `..`（含花括号、extglob 里的）；`.` 段、空段（`a//b`、开头或结尾的 `/`）；
 * - 绝对路径（`/` 开头）、盘符（`C:`）、`~` 开头、反斜杠（Windows 分隔符或 minimatch 转义）、NUL；
 * - `!` / `#` 开头（minimatch 的否定 / 注释）；
 * - 花括号或小括号里出现 `/`，或有一个备选正好是 `.`（展开后可能多出 / 少掉路径段）。
 */
export function isUnsafeGlob(g: string): boolean {
  if (g.length === 0) return true;
  if (/[\\\0]/.test(g)) return true;
  if (/^[/~!#]/.test(g) || /^[A-Za-z]:/.test(g)) return true;
  if (g.includes("..")) return true;
  if (g.split("/").some((seg) => seg === "" || seg === ".")) return true;
  let depth = 0;
  let alt = "";
  for (const c of g) {
    if (c === "{" || c === "(") {
      depth++;
      alt = "";
    } else if (c === "}" || c === ")" || ((c === "," || c === "|") && depth > 0)) {
      if (depth > 0 && alt === ".") return true;
      if (c === "}" || c === ")") depth = Math.max(0, depth - 1);
      alt = "";
    } else if (depth > 0) {
      if (c === "/") return true;
      alt += c;
    }
  }
  return false;
}

/** 写入范围里去掉不安全的条目（它们不匹配任何东西）。 */
export function safeScope(scope: readonly string[]): string[] {
  return scope.filter((g) => !isUnsafeGlob(g));
}

function segs(g: string): string[] {
  return g.split("/");
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
 * 拿不准时返回 false（宁可多裁掉一条写权限）。`g` 不安全（`isUnsafeGlob`）直接 false；`scope` 里不安全的条目忽略。
 * 字面量路径用模块 4 的 `permissionFor` 判。
 */
export function globWithinScope(g: string, scope: readonly string[]): boolean {
  if (isUnsafeGlob(g)) return false;
  scope = safeScope(scope);
  if (scope.length === 0) return false;
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

/** 被裁掉的读写条目：原条目和裁剪原因。 */
export interface CutEntry {
  entry: PermissionEntry;
  /** `unsafe_glob`：glob 本身不安全（`isUnsafeGlob`）；`outside_write_scope`：不在写入范围和已批准范围里 */
  reason: "outside_write_scope" | "unsafe_glob";
}

export interface GeneratedPermissions {
  permission_list: PermissionList;
  cut: CutEntry[];
  /** 写入范围里被忽略的不安全条目（不匹配任何东西），调用方记日志 */
  ignored_scope: string[];
}

/** 写入范围：没写按 `**`；写了就去掉不安全的条目（可能因此变空，即什么都不能写）。 */
function effectiveScope(write_scope: readonly string[] | undefined): {
  scope: string[];
  ignored: string[];
} {
  if (!write_scope || write_scope.length === 0) return { scope: ["**"], ignored: [] };
  return { scope: safeScope(write_scope), ignored: write_scope.filter(isUnsafeGlob) };
}

/**
 * 按写入范围（加上已批准的范围）裁剪一份清单：`rw` 条目不安全、或不完全落在「写入范围 ∪ 已批准范围」里的降为 `ro`；
 * `ro` / `deny` 原样；顺序不变。已批准范围里不安全的条目同样忽略。生成和每次读回需求单记录都走这一步（T-048 #47 修复）。
 */
export function clampPermissionList(
  list: readonly PermissionEntry[],
  write_scope: readonly string[] | undefined,
  granted_scope: readonly string[] = [],
): GeneratedPermissions {
  const { scope, ignored } = effectiveScope(write_scope);
  const allowed = [...scope, ...safeScope(granted_scope)];
  const cut: CutEntry[] = [];
  const out: PermissionEntry[] = list.map((e) => {
    if (e.level !== "rw") return { glob: e.glob, level: e.level };
    if (isUnsafeGlob(e.glob)) {
      cut.push({ entry: { glob: e.glob, level: e.level }, reason: "unsafe_glob" });
      return { glob: e.glob, level: "ro" };
    }
    if (globWithinScope(e.glob, allowed)) return { glob: e.glob, level: e.level };
    cut.push({ entry: { glob: e.glob, level: e.level }, reason: "outside_write_scope" });
    return { glob: e.glob, level: "ro" };
  });
  return {
    permission_list: PermissionListSchema.parse(
      out.length > 0 ? out : [{ glob: "**", level: "deny" }],
    ),
    cut,
    ignored_scope: ignored,
  };
}

/**
 * 按单生成三级权限清单（T-048，格式与默认拒绝沿用 `@bakacoding/types` / 模块 4，T-011）：
 * - 起点：需求单带的 `permission_list`（主管拆单时的建议，模型产出）；没带就用「全仓只读 + 写入范围读写」。
 * - 裁剪（`clampPermissionList`）：`rw` 条目不安全（`..` 等，见 `isUnsafeGlob`）或不在写入范围内的降为 `ro`，
 *   记进 `cut` 由调用方记日志；`ro` / `deny` 原样保留。
 * - 没写写入范围的单按整个仓库 `**` 处理（与 9 一致），只裁不安全的条目；写入范围里不安全的条目不匹配任何东西。
 * - 结果一定非空：空清单在需求单记录里表示「8 还没生成」，所以真没条目时写一条显式的 `** deny`（效果同默认拒绝）。
 */
export function generatePermissionList(
  ticket: Pick<SubAgentTicket, "permission_list" | "write_scope">,
): GeneratedPermissions {
  const { scope } = effectiveScope(ticket.write_scope);
  const proposal: PermissionEntry[] =
    ticket.permission_list && ticket.permission_list.length > 0
      ? ticket.permission_list.map((e) => ({ glob: e.glob, level: e.level }))
      : [
          { glob: "**", level: "ro" },
          ...(ticket.write_scope && ticket.write_scope.length > 0 ? ticket.write_scope : scope).map(
            (glob) => ({ glob, level: "rw" as const }),
          ),
        ];
  return clampPermissionList(proposal, ticket.write_scope);
}

/**
 * 把批准的写入范围以 `rw` 追加到清单末尾（与模块 4 的 `PermissionRegistry.grant` 同一规则：后条覆盖前条）。
 * 同一个 glob 最后一次出现已经是 rw 的不重复追加；不安全的 glob（`isUnsafeGlob`）不追加。
 */
export function appendGrantedScope(
  list: readonly PermissionEntry[],
  granted_scope: readonly string[],
): PermissionList {
  const out = list.map((e) => ({ glob: e.glob, level: e.level }));
  for (const glob of granted_scope) {
    if (isUnsafeGlob(glob)) continue;
    // 同一个 glob 最后一次出现已经是 rw：不重复追加（复投时重复写回是幂等的）
    const last = [...out].reverse().find((e) => e.glob === glob);
    if (last?.level === "rw") continue;
    out.push({ glob, level: "rw" });
  }
  return PermissionListSchema.parse(out);
}

/** 2 的事件日志里读批准记录用到的方法（`Storage` / `ReadonlyStorage` 结构上满足）。 */
export interface GrantEventQuery {
  queryEvents(filter: { ticket_id?: string; types?: BakaEvent["type"][] }): readonly BakaEvent[];
}

/**
 * 本单已批准的写入范围（跨重启）：2 的事件日志里本单所有 `write_scope_granted` 的 `granted_scope` 之并。
 * 读回需求单记录时，落在这些范围里的 `rw` 条目不按写入范围裁掉（`SubAgentDeps.grantedScopes`）。
 */
export function eventLogGrantedScopes(storage: GrantEventQuery): (ticket_id: string) => string[] {
  return (ticket_id) => {
    const out = new Set<string>();
    for (const e of storage.queryEvents({ ticket_id, types: ["write_scope_granted"] }))
      if (e.type === "write_scope_granted" && e.ticket_id === ticket_id)
        for (const g of e.payload.granted_scope) out.add(g);
    return [...out];
  };
}
