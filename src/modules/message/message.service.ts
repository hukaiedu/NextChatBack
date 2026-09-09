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
import type { MessageListItem, MessageListPage, SendMessageResult } from "./message.types.js";
import type { ListMessagesQuery } from "./message.schema.js";

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
   *
   * M1:modelKey 为客户端本次**显式提交**的模型键(可省略):
   * - 参与幂等指纹(省略 = V1 语义,与旧指纹逐字节一致);偏好永不参与指纹
   * - requestedModelKey 快照 = 显式提交 ?? 会话偏好 ?? null(创建后不再变更)
   * - 同事务把 Conversation.preferredModelKey 同步为该键;省略则绝不触碰偏好
   */
  async sendMessage(
    conversationId: string,
    rawContent: string,
    idempotencyKey: string,
    modelKey?: string,
  ): Promise<SendMessageResult> {
    const content = rawContent.trim();
    const fingerprint = computeRequestFingerprint(conversationId, content, modelKey);

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
          throw new AppError(ErrorCodes.CONVERSATION_NOT_FOUND, "Conversation not found");
        }
        if (conversation.status === "DELETED") {
          throw new AppError(ErrorCodes.CONVERSATION_DELETED, "Conversation is deleted");
        }
        if (conversation.status === "ARCHIVED") {
          throw new AppError(
            ErrorCodes.CONVERSATION_ARCHIVED,
            "Conversation is archived, restore it before sending messages",
          );
        }

        // 2. 同 Conversation 没有活动 Request(数据库 partial unique index 兜底并发)
        const hasActive = await this.requestRepo.hasActive(tx, conversationId);
        if (hasActive) {
          throw new AppError(
            ErrorCodes.CONVERSATION_REQUEST_IN_PROGRESS,
            "Conversation already has a request in progress",
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
          requestedModelKey: modelKey ?? conversation.preferredModelKey ?? null,
        });

        // 4. 显式提交模型键 → 同事务同步会话偏好;省略则只刷新 updatedAt,偏好绝不变动
        await this.conversationRepo.update(
          tx,
          conversationId,
          modelKey === undefined ? {} : { preferredModelKey: modelKey },
        );

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
          throw new AppError(ErrorCodes.CONVERSATION_NOT_FOUND, "Conversation not found", err);
        }
        if (conversation.status === "DELETED") {
          throw new AppError(ErrorCodes.CONVERSATION_DELETED, "Conversation is deleted", err);
        }
        throw new AppError(
          ErrorCodes.CONVERSATION_ARCHIVED,
          "Conversation is archived, restore it before sending messages",
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
      );
    }
    const messages = await this.messageRepo.findByIds(this.prisma, [
      request.userMessageId,
      request.assistantMessageId,
    ]);
    const userMessage = messages.find((m) => m.id === request.userMessageId);

    const assistantMessage = messages.find((m) => m.id === request.assistantMessageId);
    if (!userMessage || !assistantMessage) {
      throw new AppError(ErrorCodes.DATABASE_ERROR, "Request references missing messages");
    }
    return { request, userMessage, assistantMessage, deduplicated: true };
  }

  /**
   * 消息分页列表(PAG-2):按 position desc 取 limit+1 条探测 hasMore,页内反转为旧→新。
   * cursor 语义 position < cursor.p;totalCount 为会话 Message 总数(与页查询并行)。
   * Request 摘要只查页内 assistant 消息;会话不存在/DELETED → 404,ARCHIVED 可读。
   */
  async listMessages(
    conversationId: string,
    query: ListMessagesQuery,
  ): Promise<MessageListPage> {
    const conversation = await this.conversationRepo.findById(this.prisma, conversationId);
    if (!conversation || conversation.status === "DELETED") {
      throw new AppError(ErrorCodes.CONVERSATION_NOT_FOUND, "Conversation not found", 404);
    }
    const cursorPosition = query.cursor ? decodeMessageCursor(query.cursor) : undefined;

    const [rows, totalCount] = await Promise.all([
      this.messageRepo.listPage(this.prisma, conversationId, {
        cursorPosition,
        take: query.limit + 1,
      }),
      this.messageRepo.countByConversation(this.prisma, conversationId),
    ]);

    const hasMore = rows.length > query.limit;
    const pageRows = rows.slice(0, query.limit);
    const nextCursor =
      hasMore && pageRows.length > 0
        ? encodeMessageCursor({ p: pageRows[pageRows.length - 1]!.position })
        : null;

    const assistantIds = pageRows.filter((m) => m.role === "ASSISTANT").map((m) => m.id);
    const requests = await this.requestRepo.findByAssistantIds(this.prisma, assistantIds);
    const requestByAssistantId = new Map<string, ModelRequestModel>();
    for (const request of requests) {
      requestByAssistantId.set(request.assistantMessageId, request);
    }

    return {
      items: pageRows
        .slice()
        .reverse()
        .map((message) => {
          if (message.role !== "ASSISTANT") {
            return { ...message, request: null };
          }
          const request = requestByAssistantId.get(message.id);
          return { ...message, request: request ? toRequestBrief(request) : null };
        }),
      nextCursor,
      totalCount,
    };
  }

  /**
   * 流式回答期间刷新 Assistant Message 内容(第 6 阶段,由 GeminiStreamService 节流调用)。
   *
   * 只写 content、绝不写 status:状态流转唯一入口仍是 RequestService(§11.4)。
   * 返回 false 表示消息已离开 STREAMING(被收尾或被恢复改走),调用方据此停止推送。
   */
  async saveStreamingContent(id: string, content: string): Promise<boolean> {
    const updated = await this.messageRepo.updateContentIfStreaming(this.prisma, id, content);
    return updated > 0;
  }
}

/** PAG-2 Message 分页游标 = base64url({ p: position }),语义:取 position < p 的更老一页(Message 模块自有实现,不与 Conversation 游标共用) */
function encodeMessageCursor(cursor: { p: number }): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeMessageCursor(raw: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, "Invalid cursor");
  }
  const value = parsed as { p?: unknown } | null;
  if (typeof value?.p !== "number" || !Number.isInteger(value.p) || value.p < 1) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, "Invalid cursor");
  }
  return value.p;
}
