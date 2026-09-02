import type { ConversationModel } from "../../generated/prisma/models.js";

export const CONVERSATION_STATUSES = ["ACTIVE", "ARCHIVED", "DELETED"] as const;
export type ConversationStatusValue = (typeof CONVERSATION_STATUSES)[number];

export const DEFAULT_TITLE = "新对话";
export const DEFAULT_PROVIDER = "GEMINI_WEB";

export interface ConversationListResult {
  items: ConversationModel[];
  /** 下一页游标,没有更多数据时为 null */
  nextCursor: string | null;
}
