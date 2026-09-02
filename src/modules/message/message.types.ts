import type { MessageModel, ModelRequestModel } from "../../generated/prisma/models.js";

export const MESSAGE_ROLES = ["USER", "ASSISTANT"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const MESSAGE_STATUSES = [
  "PENDING",
  "STREAMING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type MessageStatusValue = (typeof MESSAGE_STATUSES)[number];

/**
 * User 消息落地状态。
 * assistant 状态枚举不适用于 user 消息,user 消息一旦入库即为终态。
 */
export const USER_MESSAGE_STATUS = "COMPLETED";

export interface SendMessageResult {
  request: ModelRequestModel;
  userMessage: MessageModel;
  assistantMessage: MessageModel;
  /** true = Idempotency-Key 命中,返回既有记录,未新建任何数据 */
  deduplicated: boolean;
}

/** 消息列表里随 Assistant 消息附带的 Request 摘要(刷新后可看到错误原因) */
export interface RequestBrief {
  id: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface MessageListItem extends MessageModel {
  request: RequestBrief | null;
}

export function toRequestBrief(request: ModelRequestModel): RequestBrief {
  return {
    id: request.id,
    status: request.status,
    errorCode: request.errorCode,
    errorMessage: request.errorMessage,
  };
}
