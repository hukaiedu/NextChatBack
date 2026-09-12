import type { MessageModel } from "../../generated/prisma/models.js";
import type { MessageListItem, RequestBrief, SendMessageResult } from "./message.types.js";
import { publicErrorOf, toPublicRequest } from "../request/request.public.js";

/**
 * V1.3-B3-2:Message History 与发送结果的 Public DTO。
 *
 * RequestBrief 收口掉 requestedModelKey / resolvedModelKey / resolvedModelLabel
 * (模型解析属内部实现),错误值经 publicErrorOf 映射(§18)。
 * attachmentCount 保持**扁平**挂在 message 上:现前端读的是 message.attachmentCount
 * (front/app/store/chat.ts),改成嵌套会直接打断「历史图片」占位。
 */
export interface PublicRequestBrief {
  id: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface PublicMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  status: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
  attachmentCount: number;
}

export interface PublicMessageListItem extends PublicMessage {
  request: PublicRequestBrief | null;
}

export interface PublicSendMessageResult {
  request: ReturnType<typeof toPublicRequest>;
  userMessage: PublicMessage;
  assistantMessage: PublicMessage;
  deduplicated: boolean;
}

export function toPublicMessage(message: MessageModel, attachmentCount: number): PublicMessage {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    status: message.status,
    position: message.position,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    attachmentCount,
  };
}

export function toPublicRequestBrief(brief: RequestBrief): PublicRequestBrief {
  return {
    id: brief.id,
    status: brief.status,
    ...publicErrorOf(brief.errorCode, brief.errorMessage),
  };
}

export function toPublicMessageListItem(item: MessageListItem): PublicMessageListItem {
  return {
    ...toPublicMessage(item, item.attachmentCount),
    request: item.request === null ? null : toPublicRequestBrief(item.request),
  };
}

/** ASSISTANT 消息恒 0:附件份数的唯一真值在 Request 上,assistant 侧不存在附件 */
export function toPublicSendMessageResult(result: SendMessageResult): PublicSendMessageResult {
  return {
    request: toPublicRequest(result.request),
    userMessage: toPublicMessage(result.userMessage, result.userMessage.attachmentCount),
    assistantMessage: toPublicMessage(result.assistantMessage, 0),
    deduplicated: result.deduplicated,
  };
}
