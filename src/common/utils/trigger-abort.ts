/**
 * SQLite trigger(Phase 2.1)中止消息识别。
 *
 * 并发场景下(如 Send Message ↔ Archive/Delete),应用层的先读后写检查
 * 可能基于过期快照,数据库 Trigger 会以 RAISE(ABORT, '<marker>') 中止写语句,
 * 这里按 marker 把错误还原成业务错误。
 */

export type TriggerAbortKind =
  /** ModelRequest 活动态插入时会话不是 ACTIVE(被并发归档/删除) */
  | "conversation_not_active"
  /** Conversation 状态改 ARCHIVED/DELETED 时存在活动 Request(被并发发送) */
  | "active_request_blocks_status_change";

const TRIGGER_MARKERS: Record<TriggerAbortKind, string> = {
  conversation_not_active: "model_request_active_requires_active_conversation",
  active_request_blocks_status_change: "active_request_blocks_conversation_status_change",
};

/** 沿 cause 链(最多 4 层)提取错误文本 */
function extractMessage(err: unknown): string {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current != null; depth++) {
    if (typeof current === "object" && "message" in current) {
      const message = String((current as { message: unknown }).message ?? "");
      if (message.length > 0) {
        return message;
      }
    }
    if (typeof current !== "object" || current === null) {
      break;
    }
    const next = (current as { cause?: unknown }).cause;
    if (next === current) {
      break;
    }
    current = next;
  }
  return "";
}

export function detectTriggerAbort(err: unknown): TriggerAbortKind | null {
  const message = extractMessage(err);
  for (const [kind, marker] of Object.entries(TRIGGER_MARKERS)) {
    if (message.includes(marker)) {
      return kind as TriggerAbortKind;
    }
  }
  return null;
}
