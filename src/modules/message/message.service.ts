import type { PrismaClient } from "../../generated/prisma/client.js";
import type { MessageModel, ModelRequestModel } from "../../generated/prisma/models.js";
import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import { computeRequestFingerprint } from "../../common/utils/fingerprint.js";
import { isUniqueViolation, uniqueViolationTargets } from "../../common/utils/prisma-error.js";
import { detectTriggerAbort } from "../../common/utils/trigger-abort.js";
import { ConversationRepository } from "../conversation/conversation.repository.js";
import { RequestRepository } from "../request/request.repository.js";
import { MessageRepository } from "./message.repository.js";
import {
  USER_MESSAGE_STATUS,
  toRequestBrief,
} from "./message.types.js";
import type { MessageListItem, SendMessageResult } from "./message.types.js";

/** 新 Request 事务提交后的回调(app 装配时指向 Scheduler.notify) */
export interface RequestCreationListener {
  onRequestCreated(requestId: string): void;
}

export class MessageService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messageRepo: MessageRepository,
    private readonly conversationRepo: ConversationRepository,
    private readonly requestRepo: RequestRepository,
    private readonly requestCreationListener?: RequestCreationListener,
  ) {}

  /**
   * 发送消息:一个数据库事务完成 检查 → 创建 USER / ASSISTANT / REQUEST。
   * 事务提交后通知 Scheduler 立即认领(prd §6.2 M→N);Provider 执行不在本方法内。
   */
  async sendMessage(
    conversationId: string,
    rawContent: string,
    idempotencyKey: string,
  ): Promise<SendMessageResult> {
    const content = rawContent.trim();
    const fingerprint = computeRequestFingerprint(conversationId, content);

    // 幂等预检(同 Key 常见重复请求直接返回,避免无谓事务)
    const existing = await this.requestRepo.findByIdempotencyKey(this.prisma, idempotencyKey);
    if (existing) {
      return this.resolveIdempotent(existing, conversationId, fingerprint);
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // 1. Conversation 存在 + ACTIVE
        const conversation = await this.conversationRepo.findById(tx, conversationId);
        if (!conversation) {
          throw new AppError(ErrorCodes.CONVERSATION_NOT_FOUND, "Conversation not found", 404);
        }
        if (conversation.status === "DELETED") {
          throw new AppError(ErrorCodes.CONVERSATION_DELETED, "Conversation is deleted", 409);
        }
        if (conversation.status === "ARCHIVED") {
          throw new AppError(
            ErrorCodes.CONVERSATION_ARCHIVED,
            "Conversation is archived, restore it before sending messages",
            409,
          );
        }

        // 2. 同 Conversation 没有活动 Request(数据库 partial unique index 兜底并发)
        const hasActive = await this.requestRepo.hasActive(tx, conversationId);
        if (hasActive) {
          throw new AppError(
            ErrorCodes.CONVERSATION_REQUEST_IN_PROGRESS,
            "Conversation already has a request in progress",
            409,
          );
        }

        // 3. position 严格递增(事务内取 max,唯一约束 (conversationId, position) 兜底)
        const maxPosition = await this.messageRepo.findMaxPosition(tx, conversationId);
        const start = (maxPosition ?? 0) + 1;

        const userMessage = await this.messageRepo.create(tx, {
          conversationId,
          role: "USER",
          content,
          status: USER_MESSAGE_STATUS,
          position: start,
        });
        const assistantMessage = await this.messageRepo.create(tx, {
          conversationId,
          role: "ASSISTANT",
          content: "",
          status: "PENDING",
          position: start + 1,
        });
        const request = await this.requestRepo.create(tx, {
          conversationId,
          userMessageId: userMessage.id,
          assistantMessageId: assistantMessage.id,
          idempotencyKey,
          requestFingerprint: fingerprint,
          status: "PENDING",
          provider: conversation.provider,
        });

        // 4. 刷新 Conversation.updatedAt
        await this.conversationRepo.update(tx, conversationId, {});

        return { request, userMessage, assistantMessage, deduplicated: false };
      });
      if (!result.deduplicated) {
        // 事务已提交才通知;幂等命中(deduplicated)不重复通知
        this.requestCreationListener?.onRequestCreated(result.request.id);
      }
      return result;
    } catch (err) {
      // 数据库级唯一约束兜底(并发竞态):
      // - uk_active_request_per_conversation → 同会话活动 Request
      // - idempotencyKey 唯一 → 并发同 Key,按幂等规则重查处理
      if (isUniqueViolation(err)) {
        const targets = uniqueViolationTargets(err);
        if (targets.some((t) => t.includes("uk_active_request_per_conversation"))) {
          throw new AppError(
            ErrorCodes.CONVERSATION_REQUEST_IN_PROGRESS,
            "Conversation already has a request in progress",
            409,
            err,
          );
        }
        if (targets.some((t) => t.includes("idempotencyKey"))) {
          const winner = await this.requestRepo.findByIdempotencyKey(this.prisma, idempotencyKey);
          if (winner) {
            return this.resolveIdempotent(winner, conversationId, fingerprint);
          }
        }
      }
      // 并发归档/删除获胜:数据库 trigger 拦截(Phase 2.1)。
      // 重读会话确定具体错误(避免只依赖过期的先读检查)。
      if (detectTriggerAbort(err) === "conversation_not_active") {
        const conversation = await this.conversationRepo.findById(this.prisma, conversationId);
        if (!conversation) {
          throw new AppError(ErrorCodes.CONVERSATION_NOT_FOUND, "Conversation not found", 404, err);
        }
        if (conversation.status === "DELETED") {
          throw new AppError(ErrorCodes.CONVERSATION_DELETED, "Conversation is deleted", 409, err);
        }
        throw new AppError(
          ErrorCodes.CONVERSATION_ARCHIVED,
          "Conversation is archived, restore it before sending messages",
          409,
          err,
        );
      }
      throw err;
    }
  }

  /** 幂等规则:Key 已存在 → 同 fingerprint 返回既有记录,不同 → 409 */
  private async resolveIdempotent(
    request: ModelRequestModel,
    conversationId: string,
    fingerprint: string,
  ): Promise<SendMessageResult> {
    if (request.conversationId !== conversationId || request.requestFingerprint !== fingerprint) {
      throw new AppError(
        ErrorCodes.IDEMPOTENCY_KEY_REUSED,
        "Idempotency-Key was already used with a different request",
        409,
      );
    }
    const messages = await this.messageRepo.findByIds(this.prisma, [
      request.userMessageId,
      request.assistantMessageId,
    ]);
    const userMessage = messages.find((m) => m.id === request.userMessageId);

    const assistantMessage = messages.find((m) => m.id === request.assistantMessageId);
    if (!userMessage || !assistantMessage) {
      throw new AppError(ErrorCodes.DATABASE_ERROR, "Request references missing messages", 500);
    }
    return { request, userMessage, assistantMessage, deduplicated: true };
  }

  /** 消息列表(position ASC),Assistant 消息附带 Request 摘要 */
  async listMessages(conversationId: string): Promise<MessageListItem[]> {
    const conversation = await this.conversationRepo.findById(this.prisma, conversationId);
    if (!conversation || conversation.status === "DELETED") {
      throw new AppError(ErrorCodes.CONVERSATION_NOT_FOUND, "Conversation not found", 404);
    }
    const messages = await this.messageRepo.listByConversation(this.prisma, conversationId);
    const requests = await this.requestRepo.listByConversation(this.prisma, conversationId);
    const requestByAssistantId = new Map<string, ModelRequestModel>();
    for (const request of requests) {
      requestByAssistantId.set(request.assistantMessageId, request);
    }
    // 只有 ASSISTANT 消息附带 Request 摘要,USER 消息固定 null
    return messages.map((message) => {
      if (message.role !== "ASSISTANT") {
        return { ...message, request: null };
      }
      const request = requestByAssistantId.get(message.id);
      return { ...message, request: request ? toRequestBrief(request) : null };
    });
  }
}
