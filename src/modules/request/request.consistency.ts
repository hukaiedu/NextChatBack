import type { PrismaClient } from "../../generated/prisma/client.js";
import type { MessageStatusValue } from "../message/message.types.js";
import type { RequestStatusValue } from "./request.types.js";

/**
 * prd §11.4 的 Request ↔ Assistant Message 状态映射表,进程内唯一来源。
 *
 * §六 要求状态一致性可检查,但真正的防线不是检查而是**构造**:
 * RequestService 的每个 transition 都在同一事务里同时写两侧,且两侧的取值都从这里派生,
 * 不再在调用点写字面量 —— 表和代码不可能漂移。
 *
 * 注意 CANCELLING ↔ STREAMING(不是 CANCELLED):取消受理后 Gemini 还在吐尾部内容,
 * assistant 必须保持 STREAMING,流式写入与终态前的强制 flush(prd §12.7)才仍然有效。
 */
const ASSISTANT_STATUS_BY_REQUEST: Record<RequestStatusValue, MessageStatusValue> = {
  PENDING: "PENDING",
  PROCESSING: "STREAMING",
  CANCELLING: "STREAMING",
  SUCCESS: "COMPLETED",
  FAILED: "FAILED",
  TIMEOUT: "FAILED",
  CANCELLED: "CANCELLED",
};

/** 某 Request 状态下 assistant message 应有的状态 */
export function expectedAssistantStatus(status: RequestStatusValue): MessageStatusValue {
  return ASSISTANT_STATUS_BY_REQUEST[status];
}

export interface PairingViolation {
  requestId: string;
  requestStatus: string;
  assistantMessageId: string;
  assistantStatus: string;
}

/**
 * 扫出所有 Request / Assistant 状态不配对的行(prd §六)。
 *
 * 只发现、不修复:自动修复会销毁事故现场,而 prd 只要求「检查」。
 * 本地 SQLite 单进程,行数量级小,一次 findMany 后在 JS 里比对即可,不用 raw SQL。
 */
export async function findPairingViolations(prisma: PrismaClient): Promise<PairingViolation[]> {
  const rows = await prisma.modelRequest.findMany({
    select: {
      id: true,
      status: true,
      assistantMessageId: true,
      assistantMessage: { select: { status: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const violations: PairingViolation[] = [];
  for (const row of rows) {
    // status 是自由文本列(DB CHECK 兜底);未知值无从判定期望,跳过而不是误报
    const expected: MessageStatusValue | undefined =
      ASSISTANT_STATUS_BY_REQUEST[row.status as RequestStatusValue];
    if (expected === undefined || row.assistantMessage.status === expected) {
      continue;
    }
    violations.push({
      requestId: row.id,
      requestStatus: row.status,
      assistantMessageId: row.assistantMessageId,
      assistantStatus: row.assistantMessage.status,
    });
  }
  return violations;
}
