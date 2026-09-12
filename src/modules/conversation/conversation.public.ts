import type { ConversationModel } from "../../generated/prisma/models.js";

/**
 * V1.3-B3-2:Public Conversation 白名单 DTO。
 *
 * 逐字段列出而不是 `const { userId, ...rest } = row`:以后给 Prisma Model 新增列时,
 * 新列默认不会自动出现在 Public HTTP 上(§5 的核心目的)。
 *
 * 禁止外发:userId(枚举归属)、provider 与 providerConversationUrl(第三方会话标识)、
 * deletedAt(软删除内部时间戳;对外只有「存在 / 不存在」)。
 */
export interface PublicConversation {
  id: string;
  title: string;
  status: string;
  /** M1:会话维度模型偏好;前端选择器需要,null = 未指定 */
  preferredModelKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicConversation(conversation: ConversationModel): PublicConversation {
  return {
    id: conversation.id,
    title: conversation.title,
    status: conversation.status,
    preferredModelKey: conversation.preferredModelKey,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}
