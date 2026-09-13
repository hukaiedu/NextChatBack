import { randomUUID } from "node:crypto";

import type { PrismaClient } from "../../generated/prisma/client.js";
import type { DbClient } from "../../database/prisma.js";
import type { MessageModel, ModelRequestModel } from "../../generated/prisma/models.js";
import { AppError, RetryAfterError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import type { FixedWindowRateLimiter } from "../../common/rate-limit/rate-limiter.js";
import { QUEUE_FULL_RETRY_AFTER_SECONDS } from "../../config/constants.js";
import { computeRequestFingerprint } from "../../common/utils/fingerprint.js";
import { isUniqueViolation, uniqueViolationInfo } from "../../common/utils/prisma-error.js";
import type { UniqueViolationInfo } from "../../common/utils/prisma-error.js";
import { detectTriggerAbort } from "../../common/utils/trigger-abort.js";
import { ConversationRepository } from "../conversation/conversation.repository.js";
import type { AttachmentStore } from "../request/request.attachment-store.js";
import type { QueueLimits, RequestAdmissionGate } from "../request/request.admission.js";
import { RequestRepository } from "../request/request.repository.js";
import { computeAttachmentsDigest, parseAttachments } from "./attachment.js";
import type { AttachmentFile, RawAttachment } from "./attachment.js";
import { MessageRepository } from "./message.repository.js";
import {
  USER_MESSAGE_STATUS,
  toRequestBrief,
} from "./message.types.js";
import type { MessageListItem, MessageListPage, SendMessageResult } from "./message.types.js";
import type { ListMessagesQuery } from "./message.schema.js";

/**
 * 新 Request 事务提交后的回调(app 装配时指向 Scheduler.notify)。
 * P7 §50:除 id 外还要带上归属 userId —— 公平调度按用户轮转,拿不到 owner 就只能再查一次库。
 */
export interface RequestCreationListener {
  onRequestCreated(requestId: string, userId: string): void;
}

/**
 * V1.3 P6:发消息入口的三道准入(§27 冻结顺序里的「频率 → 配额」两步)。
 *
 * 判据分得很清:**频率**活在内存(重启清零,§77),**排队容量**只认数据库计数
 * (§30:重启后残留的 PENDING 仍然占额度),内存锁只负责让同进程的 check+create 串行。
 */
export interface MessageAdmission {
  /** 提交频率(§23):键 = req.auth.userId,ADMIN 与 COMPAT 都不绕过(§24/§25) */
  submitLimiter: FixedWindowRateLimiter;
  /** 配额复核 + 创建的短临界区(§36) */
  gate: RequestAdmissionGate;
  /** 两级排队上限(§33/§34) */
  limits: QueueLimits;
}

export class MessageService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly messageRepo: MessageRepository,
    private readonly conversationRepo: ConversationRepository,
    private readonly requestRepo: RequestRepository,
    private readonly attachmentStore: AttachmentStore,
    private readonly requestCreationListener: RequestCreationListener | undefined,
    /** P6:必填 —— 装配层「明确知道自己有没有接限流」,不能靠漏传静默退化 */
    private readonly admission: MessageAdmission,
  ) {}

  /**
   * 发送消息:一个数据库事务完成 检查 → 创建 USER / ASSISTANT / REQUEST。
   * 事务提交后通知 Scheduler 立即认领(prd §6.2 M→N);Provider 执行不在本方法内。
   *
   * V1.3-B3 §12:userId = req.auth.userId 是唯一可信归属依据,顺序固定为
   * 「owned Conversation 确认 → 幂等预检 → 附件占位 → 事务」。ownership 门控必须排在
   * 幂等预检之前:否则跨用户调用会先用别人的 Idempotency-Key 命中既有 Request,
   * 把「会话存在与否」泄露成响应差异;门控之后,非本人既没有 Message/Request 落库,
   * 也不会占用 AttachmentStore 槽位(还没走到 reserve 就 404 了)。
   *
   * M1:modelKey 为客户端本次**显式提交**的模型键(可省略):
   * - 参与幂等指纹(省略 = V1 语义,与旧指纹逐字节一致);偏好永不参与指纹
   * - requestedModelKey 快照 = 显式提交 ?? 会话偏好 ?? null(创建后不再变更)
   * - 同事务把 Conversation.preferredModelKey 同步为该键;省略则绝不触碰偏好
   *
   * V1.2 I1:附件按固定顺序处理 —— 复核 → 指纹 → 幂等预检 → 占位 → 事务 → 确认 → 通知。
   * 幂等预检必须在 reserve 之前:同 Key 重放要原样返回既有 Request,既不新建 slot,
   * 也不碰既有 slot(ATT-IDEM-01)。纯文本(attachments 缺省)一条附件路径都不走。
   *
   * V1.3 P6 §27/§28 + FIX-01B §11 冻结顺序:
   * trim → owned Conversation gate → 提交频率 → 附件复核 + 指纹 → 幂等预检 → 排队配额 →
   * 附件占位 → 事务(内再复核配额)→ notify。三道门槛的语义不同,报告 §79 要按这个区分对外解释:
   * - ownership gate 保护「数据归属」,必须永远是第一个业务判断
   * - 频率 limiter 保护「提交太快」,幂等重放同样算一次(它就是真实的一次 HTTP 提交)
   * - 配额 admission 保护「排队长度」,必须排在 dedupe 之后:队列已满不能让合法重放失败
   * 附件复核与指纹排在两道准入之后(I0.1 §4.3 规则 6–8 的成本判据):它们随 payload 体积线性增长,
   * 因此「被挡掉的请求」不得替服务付这笔账 —— 跨用户请求拿 404、超频请求拿 429,都发生在解码之前。
   * 唯一保持在前的是 body limit 的 413:那是 transport 层行为,不属于本方法。
   * 拒绝路径一律零副作用:没有 Message/Request 落库、不占附件 slot、不 notify(§41)。
   */
  async sendMessage(
    userId: string,
    conversationId: string,
    rawContent: string,
    idempotencyKey: string,
    modelKey?: string,
    rawAttachments?: RawAttachment[],
  ): Promise<SendMessageResult> {
    // FIX-01B §11 步骤 1:最小 text normalization —— 只有 trim,不碰任何昂贵路径
    const content = rawContent.trim();

    // §14 步骤 2:目标会话必须先属于当前用户(不存在与属于别人同为 404)
    const gated = await this.conversationRepo.findOwnedById(this.prisma, conversationId, userId);
    if (!gated) {
      throw new AppError(ErrorCodes.CONVERSATION_NOT_FOUND, "Conversation not found");
    }

    // P6 §23/§28 步骤 3:提交频率按认证用户计(键 = userId,不是 IP),ADMIN/COMPAT 同样受限
    const rate = this.admission.submitLimiter.register(userId);
    if (rate.limited) {
      // P10 §51:限流器自身满容量 → 服务容量 503,与该用户是否超频无关,且不落任何 Message/Request
      if ("capacityExceeded" in rate) {
        throw new AppError(
          ErrorCodes.RATE_LIMITER_CAPACITY_EXCEEDED,
          "Message rate limiter capacity exceeded",
        );
      }
      throw new RetryAfterError(
        ErrorCodes.CHAT_SUBMIT_RATE_LIMITED,
        "Too many messages submitted",
        rate.retryAfterSeconds,
      );
    }

    // FIX-01B §12 步骤 4:附件物化(base64 解码 → Buffer 分配 → magic byte 复核)与指纹
    // (对解码后字节做 sha256)是整条链路里唯一随 payload 体积增长的开销,因此排在
    // ownership + rate 之后:被别人挡掉的请求不再替攻击者付这笔账。
    const attachments = parseAttachments(rawAttachments);
    const fingerprint = this.buildRequestFingerprint(
      conversationId,
      content,
      modelKey,
      attachments,
    );

    // 步骤 5:幂等预检(同 Key 常见重复请求直接返回,避免无谓事务;§42:排队已满也绝不能挡掉合法重放)
    const existing = await this.requestRepo.findByIdempotencyKey(this.prisma, idempotencyKey);
    if (existing) {
      return this.resolveIdempotent(existing, conversationId, fingerprint);
    }

    // 附件字节只进内存:先按预分配 id 占位,再让同一条 id 落库,两侧才对得上。
    // reserve 抛错(容量不足 / id 冲突)时 slot 一个都没建,下面 finally 自然 no-op。
    let requestId: string | undefined;
    try {
      const result = await this.admission.gate.runExclusive(async () => {
        // P6 §35/§36:配额复核与创建事务在准入锁内成对出现。事务外单独 count 不算判定 ——
        // 并发下两条请求会同时读到「还没满」。附件占位排在配额通过之后(§28 红线),
        // 因此任何入口拒绝都留不下副作用(§41)。
        await this.assertQueueHasRoom(userId);
        if (attachments !== undefined) {
          requestId = randomUUID();
          this.attachmentStore.reserve(requestId, attachments);
        }
        return this.prisma.$transaction((tx) =>
          this.createRequestRows(tx, {
            conversationId,
            userId,
            content,
            attachments,
            requestId,
            idempotencyKey,
            fingerprint,
            modelKey,
          }),
        );
      });
      // RESERVED → READY:事务已提交,字节就此交给执行链;本地所有权随即摘掉,
      // 释放权转给 Scheduler 的 finally。交接必须早于 notify,否则 Scheduler 抢在 READY 之前 take。
      if (requestId !== undefined) {
        this.attachmentStore.attach(requestId);
        requestId = undefined;
      }
      if (!result.deduplicated) {
        // 事务已提交才通知;幂等命中(deduplicated)不重复通知。
        // P7 §50:带上归属 userId —— 它来自 req.auth.userId(不是请求体),Scheduler 只用它入队
        this.requestCreationListener?.onRequestCreated(result.request.id, userId);
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
        const conversation = await this.conversationRepo.findOwnedById(
          this.prisma,
          conversationId,
          userId,
        );
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

  /**
   * FIX-01B §16:幂等指纹的独立 seam —— 纯计算、无 IO、语义与直接调用逐字节相同。
   *
   * 单拆这一层只为让测试能证明「被 ownership / rate 挡掉的请求没有付 sha256 的账」;
   * 不为它加任何判断,也不借此重构 sendMessage。
   */
  private buildRequestFingerprint(
    conversationId: string,
    content: string,
    modelKey: string | undefined,
    attachments: AttachmentFile[] | undefined,
  ): string {
    return computeRequestFingerprint(
      conversationId,
      content,
      modelKey,
      attachments === undefined ? undefined : computeAttachmentsDigest(attachments),
    );
  }

  /**
   * P6 §33/§34/§35:两级排队容量的权威复核,只在准入锁内调用。
   *
   * 计数只来自数据库(PENDING 条数):内存队列会随重启清空,而库里的 PENDING 才是
   * 真正待执行的量(§75/§76)。超限一律 RetryAfterError —— 拒绝是暂时的,客户端按
   * 固定秒数退避即可,不需要知道是哪一档限额拦下的(§79)。
   */
  private async assertQueueHasRoom(userId: string): Promise<void> {
    const [userPending, globalPending] = await Promise.all([
      this.requestRepo.countPendingForUser(this.prisma, userId),
      this.requestRepo.countPending(this.prisma),
    ]);
    if (userPending >= this.admission.limits.userMaxPending) {
      throw new RetryAfterError(
        ErrorCodes.USER_PENDING_LIMIT_REACHED,
        "User already has too many queued requests",
        QUEUE_FULL_RETRY_AFTER_SECONDS,
      );
    }
    if (globalPending >= this.admission.limits.globalMaxPending) {
      throw new RetryAfterError(
        ErrorCodes.GLOBAL_QUEUE_FULL,
        "Service request queue is full",
        QUEUE_FULL_RETRY_AFTER_SECONDS,
      );
    }
  }

  /**
   * 事务体:一条事务内完成 owner 复核 → 活动请求检查 → position 递增 → 三行落库 → 偏好同步。
   * 从 sendMessage 整体搬出,只为让准入锁只包住「配额复核 + 本事务」这一小段(§38);
   * 内部顺序与判据逐条保持原样。
   */
  private async createRequestRows(
    tx: DbClient,
    input: {
      conversationId: string;
      userId: string;
      content: string;
      /** undefined = 纯文本:一条附件路径都不走 */
      attachments: AttachmentFile[] | undefined;
      /** 附件路径的预分配 id(与 AttachmentStore 的占位对齐);纯文本 = undefined = 用默认 id */
      requestId?: string;
      idempotencyKey: string;
      fingerprint: string;
      modelKey?: string;
    },
  ) {
    const {
      conversationId,
      userId,
      content,
      attachments,
      requestId,
      idempotencyKey,
      fingerprint,
      modelKey,
    } = input;

    // 1. Conversation 属于当前用户 + ACTIVE(§13:owner 条件进事务,与写路径同源)
    const conversation = await this.conversationRepo.findOwnedById(tx, conversationId, userId);
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
    await this.conversationRepo.updateOwned(
      tx,
      conversationId,
      userId,
      modelKey === undefined ? {} : { preferredModelKey: modelKey },
    );

    return {
      request,
      userMessage: { ...userMessage, attachmentCount: request.attachmentCount },
      assistantMessage,
      deduplicated: false,
    };
  }

  /**
   * 幂等规则:Key 已存在 → 同 fingerprint 返回既有记录,不同 → 409。
   *
   * §14 步骤 3 的「命中的 Request 仍属于当前用户」由两条既有条件合起来保证:
   * 调用方已按 (conversationId, userId) 门控过目标会话,而这里要求
   * request.conversationId === conversationId,否则直接 409 —— 同一 id 即同一 owner
   * (V1.3 不提供 owner 转移),所以跨用户撞 Key 只得到一个不带你数据的 409。
   */
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
   *
   * V1.3-B3 §11:先确认会话属于当前用户才查 Message。跨用户必须是 404,
   * 不能是 200 + 空数组 —— 空页与「会话里确实没消息」逐字节相同,等于给对方会话开了探测口。
   */
  async listMessages(
    userId: string,
    conversationId: string,
    query: ListMessagesQuery,
  ): Promise<MessageListPage> {
    const conversation = await this.conversationRepo.findOwnedById(
      this.prisma,
      conversationId,
      userId,
    );
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
