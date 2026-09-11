import { randomUUID } from "node:crypto";

import type { PrismaClient } from "../../generated/prisma/client.js";
import type { MessageModel, ModelRequestModel } from "../../generated/prisma/models.js";
import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import { computeRequestFingerprint } from "../../common/utils/fingerprint.js";
import { isUniqueViolation, uniqueViolationInfo } from "../../common/utils/prisma-error.js";
import type { UniqueViolationInfo } from "../../common/utils/prisma-error.js";
import { detectTriggerAbort } from "../../common/utils/trigger-abort.js";
import { ConversationRepository } from "../conversation/conversation.repository.js";
import type { AttachmentStore } from "../request/request.attachment-store.js";
import { RequestRepository } from "../request/request.repository.js";
import { computeAttachmentsDigest, parseAttachments } from "./attachment.js";
import type { RawAttachment } from "./attachment.js";
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
    private readonly attachmentStore: AttachmentStore,
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
   *
   * V1.2 I1:附件按固定顺序处理 —— 复核 → 指纹 → 幂等预检 → 占位 → 事务 → 确认 → 通知。
   * 幂等预检必须在 reserve 之前:同 Key 重放要原样返回既有 Request,既不新建 slot,
   * 也不碰既有 slot(ATT-IDEM-01)。纯文本(attachments 缺省)一条附件路径都不走。
   */
  async sendMessage(
    conversationId: string,
    rawContent: string,
    idempotencyKey: string,
    modelKey?: string,
    rawAttachments?: RawAttachment[],
  ): Promise<SendMessageResult> {
    const content = rawContent.trim();
    const attachments = parseAttachments(rawAttachments);
    const fingerprint = computeRequestFingerprint(
      conversationId,
      content,
      modelKey,
      attachments === undefined ? undefined : computeAttachmentsDigest(attachments),
    );

    // 幂等预检(同 Key 常见重复请求直接返回,避免无谓事务)
    const existing = await this.requestRepo.findByIdempotencyKey(this.prisma, idempotencyKey);
    if (existing) {
      return this.resolveIdempotent(existing, conversationId, fingerprint);
    }

    // 附件字节只进内存:先按预分配 id 占位,再让同一条 id 落库,两侧才对得上。
    // reserve 抛错(容量不足 / id 冲突)时 slot 一个都没建,下面 finally 自然 no-op。
    let requestId: string | undefined;
    if (attachments !== undefined) {
      requestId = randomUUID();
      this.attachmentStore.reserve(requestId, attachments);
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
          // 附件路径必须沿用占位时的 id:AttachmentStore 与数据库靠它对齐(纯文本传 undefined = 用默认 id)
          id: requestId,
          conversationId,
          userMessageId: userMessage.id,
          assistantMessageId: assistantMessage.id,
          idempotencyKey,
          requestFingerprint: fingerprint,
          status: "PENDING",
          provider: conversation.provider,
          requestedModelKey: modelKey ?? conversation.preferredModelKey ?? null,
          // 只落份数;字节在内存
          attachmentCount: attachments?.length ?? 0,
        });

        // 4. 显式提交模型键 → 同事务同步会话偏好;省略则只刷新 updatedAt,偏好绝不变动
        await this.conversationRepo.update(
          tx,
          conversationId,
          modelKey === undefined ? {} : { preferredModelKey: modelKey },
        );

        return {
          request,
          userMessage: { ...userMessage, attachmentCount: request.attachmentCount },
          assistantMessage,
          deduplicated: false,
        };
      });
      // RESERVED → READY:事务已提交,字节就此交给执行链;本地所有权随即摘掉,
      // 释放权转给 Scheduler 的 finally。交接必须早于 notify,否则 Scheduler 抢在 READY 之前 take。
      if (requestId !== undefined) {
        this.attachmentStore.attach(requestId);
        requestId = undefined;
      }
      if (!result.deduplicated) {
        // 事务已提交才通知;幂等命中(deduplicated)不重复通知
        this.requestCreationListener?.onRequestCreated(result.request.id);
      }
      return result;
    } catch (err) {
      // 数据库级唯一约束兜底(并发下事务外预检读到的是对方提交之前的快照):
      // driver adapter 不报索引名,只报归属 + 冲突列,所以分类必须按精确列集合做,
      // 不能让 ModelRequest 的单列冲突与 Message(conversationId,position) 互相冒充。
      // - ModelRequest(conversationId) = 活动态部分索引 → 同会话已有 Request
      // - ModelRequest(idempotencyKey) → 并发同 Key,按幂等规则重查处理
      if (isUniqueViolation(err)) {
        const violation = uniqueViolationInfo(err);
        if (isModelRequestColumn(violation, "conversationId")) {
          throw new AppError(
            ErrorCodes.CONVERSATION_REQUEST_IN_PROGRESS,
            "Conversation already has a request in progress",
            err,
          );
        }
        if (isModelRequestColumn(violation, "idempotencyKey")) {
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
    } finally {
      // 仍持有 requestId = 事务没成功,或竞态已让位给既有 Request(ATT-IDEM-02)。
      // 两种情况都必须收回本次占位;让位时收的是自己那个新 id,既有 Request 的 slot 分毫不动。
      if (requestId !== undefined) {
        this.attachmentStore.drop(requestId);
      }
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
    return {
      request,
      userMessage: { ...userMessage, attachmentCount: request.attachmentCount },
      assistantMessage,
      deduplicated: true,
    };
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
    const userIds = pageRows.filter((m) => m.role === "USER").map((m) => m.id);
    const [requests, userRequests] = await Promise.all([
      this.requestRepo.findByAssistantIds(this.prisma, assistantIds),
      this.requestRepo.findByUserMessageIds(this.prisma, userIds),
    ]);
    const requestByAssistantId = new Map<string, ModelRequestModel>();
    for (const request of requests) {
      requestByAssistantId.set(request.assistantMessageId, request);
    }
    const requestByUserId = new Map<string, ModelRequestModel>();
    for (const request of userRequests) {
      requestByUserId.set(request.userMessageId, request);
    }

    return {
      items: pageRows
        .slice()
        .reverse()
        .map((message) => {
          if (message.role !== "ASSISTANT") {
            return {
              ...message,
              request: null,
              attachmentCount: requestByUserId.get(message.id)?.attachmentCount ?? 0,
            };
          }
          const request = requestByAssistantId.get(message.id);
          return { ...message, request: request ? toRequestBrief(request) : null, attachmentCount: 0 };
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

/**
 * 冲突是否恰好落在 ModelRequest 的这一列上。
 *
 * 精确到「只有这一列」是刻意的:Message 的复合唯一会报 ["conversationId","position"],
 * 用 includes 就把它洗成了「会话已有请求在进行」这种看似合理的业务 409。
 */
function isModelRequestColumn(violation: UniqueViolationInfo, column: string): boolean {
  return (
    (violation.modelName ?? violation.table) === "ModelRequest" &&
    violation.fields.length === 1 &&
    violation.fields[0] === column
  );
}
