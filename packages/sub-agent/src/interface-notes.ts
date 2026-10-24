import type { JsonValue, Storage } from "@bakacoding/storage";
import type { TicketInterfaceNoteStore } from "./types.js";

/** 每单最多攒多少条没带给编码池的接口变更说明（多了丢最早的）；内存与持久化共用这个上限。 */
export const MAX_INTERFACE_NOTES = 20;

/** 每条说明的最大长度（码点，T-133）：条数上限之外再限单条体积，避免 fields 随接口列表膨胀。 */
export const MAX_INTERFACE_NOTE_CHARS = 4096;

/** 单条说明按码点截断（超长加「…」）；格式化与读回历史数据都走它，保证两边一致。 */
export function truncateNote(note: string): string {
  const cps = Array.from(note);
  return cps.length > MAX_INTERFACE_NOTE_CHARS
    ? `${cps.slice(0, MAX_INTERFACE_NOTE_CHARS - 1).join("")}…`
    : note;
}

/** fields 里存接口变更说明的键（T-133）。 */
export const INTERFACE_NOTES_FIELD = "interface_notes";

/** 进程内存实现：deps.interfaceNotes 不注入时的默认值，只适合测试（重启即丢）。 */
export function memoryInterfaceNotes(): TicketInterfaceNoteStore {
  const map = new Map<string, string[]>();
  return {
    get(ticket_id) {
      return [...(map.get(ticket_id) ?? [])];
    },
    set(ticket_id, notes) {
      const list = [...notes];
      if (list.length) map.set(ticket_id, list);
      else map.delete(ticket_id);
    },
  };
}

/** 用到的模块 2 存储能力（`openStorage` 返回的 Storage 满足）。 */
export type InterfaceNotesStorage = Pick<Storage, "getTicket" | "setTicketField">;

function readField(raw: JsonValue | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .slice(-MAX_INTERFACE_NOTES)
    .map(truncateNote); // 历史数据可能超长（T-133 之前写的），读回时统一截
}

/**
 * 模块 2 的适配器（T-133）：读 `tickets.fields.interface_notes`，写走 2 的 `setTicketField`——只在同一个
 * IMMEDIATE 事务里改这一个键，不读改写整行，不会和 10 的 `patchFields`、9 的状态写互相冲掉。
 * 单不存在 / 该单没有结构化字段（fields 为 null / 损坏）时写不进去（2 返回 false）：同一单只 warn 一次，
 * 说明不落库、不影响编码。
 */
export function storageTicketInterfaceNotes(
  storage: InterfaceNotesStorage,
  opts: { warn?: (message: string) => void } = {},
): TicketInterfaceNoteStore {
  const warned = new Set<string>();
  return {
    get(ticket_id) {
      const row = storage.getTicket(ticket_id);
      return readField(row?.fields?.[INTERFACE_NOTES_FIELD]);
    },
    set(ticket_id, notes) {
      const list = [...notes].filter((n) => n.length > 0).slice(-MAX_INTERFACE_NOTES);
      const ok = storage.setTicketField(
        ticket_id,
        INTERFACE_NOTES_FIELD,
        list.length ? list.map(truncateNote) : undefined,
      );
      if (!ok && !warned.has(ticket_id)) {
        warned.add(ticket_id);
        opts.warn?.(
          `[bakacoding/sub-agent] 需求单 ${ticket_id} 没有可写的结构化字段（旧单或 fields 损坏），接口变更说明不落库`,
        );
      }
    },
  };
}
