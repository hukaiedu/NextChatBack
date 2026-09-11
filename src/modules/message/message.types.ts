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
  /** V1.2 I3.5:USER 消息携带 attachmentCount(与 list DTO 同契约,来源 = request.attachmentCount) */
  userMessage: MessageModel & { attachmentCount: number };
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
  /** M1:客户端显式提交的模型键快照;未提交为 null */
  requestedModelKey: string | null;
  /** M1:实际执行的模型键(M2 的 ensureModel 写入;M1 阶段恒为 null) */
  resolvedModelKey: string | null;
  /** M1:实际执行模型的展示名(M2 写入;M1 阶段恒为 null) */
  resolvedModelLabel: string | null;
}

export interface MessageListItem extends MessageModel {
  request: RequestBrief | null;
  /**
   * V1.2 I3.5:USER = 提交时携带的图片份数(I1 起由 ModelRequest 落库,经 userMessageId 反查);
   * ASSISTANT 恒 0。原图字节从未持久化,前端仅据此渲染「历史图片」占位。
   */
  attachmentCount: number;
}

/** PAG-2:Message 分页页(页内旧→新;nextCursor 指向更老一页,null = 已到最老) */
export interface MessageListPage {
  items: MessageListItem[];
  nextCursor: string | null;
  totalCount: number;
}

export function toRequestBrief(request: ModelRequestModel): RequestBrief {
  return {
    id: request.id,
    status: request.status,
    errorCode: request.errorCode,
    errorMessage: request.errorMessage,
    requestedModelKey: request.requestedModelKey,
    resolvedModelKey: request.resolvedModelKey,
    resolvedModelLabel: request.resolvedModelLabel,
  };
}
