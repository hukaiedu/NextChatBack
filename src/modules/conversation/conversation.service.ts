import type { PrismaClient } from "../../generated/prisma/client.js";
import type { ConversationModel } from "../../generated/prisma/models.js";
import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import { detectTriggerAbort } from "../../common/utils/trigger-abort.js";
import { isUniqueViolation } from "../../common/utils/prisma-error.js";
import type { DbClient } from "../../database/prisma.js";
import { RequestRepository } from "../request/request.repository.js";
import { ConversationRepository } from "./conversation.repository.js";
import { DEFAULT_PROVIDER, DEFAULT_TITLE } from "./conversation.types.js";
import type { ConversationListResult } from "./conversation.types.js";

export interface ListConversationsParams {
  status: "ACTIVE" | "ARCHIVED";
  limit: number;
  cursor?: string;
}

export class ConversationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly conversationRepo: ConversationRepository,
    private readonly requestRepo: RequestRepository,
  ) {}

  async create(input: { title?: string }): Promise<ConversationModel> {
    return this.conversationRepo.create(this.prisma, {
      title: input.title ?? DEFAULT_TITLE,
      status: "ACTIVE",
      provider: DEFAULT_PROVIDER,
    });
  }

  /** 详情:DELETED 视为不存在(普通 API 不返回已删除会话) */
  async getById(id: string): Promise<ConversationModel> {
    const conversation = await this.conversationRepo.findById(this.prisma, id);
    if (!conversation || conversation.status === "DELETED") {
      throw new AppError(ErrorCodes.CONVERSATION_NOT_FOUND, "Conversation not found", 404);
    }
    return conversation;
  }

  /**
   * 写操作前置读取:与 getById 的「DELETED 当 404 隐藏」相反,
   * 发消息 / 发 Prompt 这类写操作必须明确告知会话已删除(409),
   * 与 MessageService 的口径保持一致。
   */
  async getWritableById(id: string): Promise<ConversationModel> {
    const conversation = await this.conversationRepo.findById(this.prisma, id);
    if (!conversation) {
      throw new AppError(ErrorCodes.CONVERSATION_NOT_FOUND, "Conversation not found", 404);
    }
    if (conversation.status === "DELETED") {
      throw new AppError(ErrorCodes.CONVERSATION_DELETED, "Conversation is deleted", 409);
    }
    return conversation;
  }

  async list(params: ListConversationsParams): Promise<ConversationListResult> {
    const cursor = params.cursor ? decodeCursor(params.cursor) : null;
    const items = await this.conversationRepo.list(this.prisma, {
      status: params.status,
      limit: params.limit,
      cursor,
    });
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: items.length === params.limit && last ? encodeCursor(last) : null,
    };
  }

  async update(id: string, patch: { title?: string; status?: "ACTIVE" | "ARCHIVED" }): Promise<ConversationModel> {
    const conversation = await this.conversationRepo.findById(this.prisma, id);
    if (!conversation) {
      throw new AppError(ErrorCodes.CONVERSATION_NOT_FOUND, "Conversation not found", 404);
    }
    if (conversation.status === "DELETED") {
      throw new AppError(ErrorCodes.CONVERSATION_DELETED, "Conversation is deleted", 409);
    }
    // ACTIVE → ARCHIVED 归档前:存在活动 Request 时禁止归档(prd §8.4)
    if (patch.status && patch.status !== conversation.status && conversation.status === "ACTIVE") {
      const hasActive = await this.requestRepo.hasActive(this.prisma, id);
      if (hasActive) {
        throw new AppError(
          ErrorCodes.CONVERSATION_REQUEST_IN_PROGRESS,
          "Conversation has a request in progress",
          409,
        );
      }
    }
    try {
      const updated = await this.conversationRepo.update(this.prisma, id, {
        title: patch.title,
        status: patch.status,
      });
      if (!updated) {
        throw new AppError(ErrorCodes.CONVERSATION_NOT_FOUND, "Conversation not found", 404);
      }
      return updated;
    } catch (err) {
      // 并发 Send Message 获胜:数据库 trigger 拦截(Phase 2.1)
      if (detectTriggerAbort(err) === "active_request_blocks_status_change") {
        throw new AppError(
          ErrorCodes.CONVERSATION_REQUEST_IN_PROGRESS,
          "Conversation has a request in progress",
          409,
          err,
        );
      }
      throw err;
    }
  }

  /**
   * 立即保存 Provider Conversation URL(prd §6.3:拿到 URL 后必须先落库才能继续)。
   *
   * 独立短事务:浏览器执行期间不持有任何事务。
   * 入参 URL 由 Provider 侧规范化,本方法只按字符串判等 → 幂等/冲突。
   */
  async saveProviderConversationUrl(id: string, url: string): Promise<ConversationModel> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const conversation = await this.conversationRepo.findById(tx, id);
        if (!conversation) {
          throw new AppError(ErrorCodes.CONVERSATION_NOT_FOUND, "Conversation not found", 404);
        }
        if (conversation.status === "DELETED") {
          throw new AppError(ErrorCodes.CONVERSATION_DELETED, "Conversation is deleted", 409);
        }
        if (conversation.providerConversationUrl !== null) {
          if (conversation.providerConversationUrl === url) {
            return conversation;
          }
          throw new AppError(
            ErrorCodes.PROVIDER_CONVERSATION_UNAVAILABLE,
            "Conversation is already bound to another provider conversation",
            409,
          );
        }

        const bound = await this.conversationRepo.bindProviderConversationUrl(tx, id, url);
        if (bound) {
          return bound;
        }
        // 并发下别人先写入了:同值算幂等,异值算改绑冲突
        const current = await this.conversationRepo.findById(tx, id);
        if (current && current.providerConversationUrl === url) {
          return current;
        }
        throw new AppError(
          ErrorCodes.PROVIDER_CONVERSATION_UNAVAILABLE,
          "Conversation is already bound to another provider conversation",
          409,
        );
      });
    } catch (err) {
      // providerConversationUrl 是 @unique:同一 Gemini 会话只能绑一个本地会话
      if (isUniqueViolation(err)) {
        throw new AppError(
          ErrorCodes.PROVIDER_CONVERSATION_UNAVAILABLE,
          "Provider conversation is already bound to another conversation",
          409,
          err,
        );
      }
      throw err;
    }
  }

  /** 软删除:只改状态,不物理删除 Message / Request */
  async softDelete(id: string): Promise<void> {
    const conversation = await this.conversationRepo.findById(this.prisma, id);
    if (!conversation) {
      throw new AppError(ErrorCodes.CONVERSATION_NOT_FOUND, "Conversation not found", 404);
    }
    if (conversation.status === "DELETED") {
      throw new AppError(ErrorCodes.CONVERSATION_DELETED, "Conversation is deleted", 409);
    }
    const hasActive = await this.requestRepo.hasActive(this.prisma, id);
    if (hasActive) {
      throw new AppError(
        ErrorCodes.CONVERSATION_REQUEST_IN_PROGRESS,
        "Conversation has a request in progress",
        409,
      );
    }
    try {
      await this.conversationRepo.update(this.prisma, id, {
        status: "DELETED",
        deletedAt: new Date(),
      });
    } catch (err) {
      // 并发 Send Message 获胜:数据库 trigger 拦截(Phase 2.1)
      if (detectTriggerAbort(err) === "active_request_blocks_status_change") {
        throw new AppError(
          ErrorCodes.CONVERSATION_REQUEST_IN_PROGRESS,
          "Conversation has a request in progress",
          409,
          err,
        );
      }
      throw err;
    }
  }
}

/** 游标 = base64url({ u: updatedAt ISO, i: id }) */
function encodeCursor(conversation: Pick<ConversationModel, "updatedAt" | "id">): string {
  return Buffer.from(
    JSON.stringify({ u: conversation.updatedAt.toISOString(), i: conversation.id }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(raw: string): { updatedAt: Date; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, "Invalid cursor", 400);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, "Invalid cursor", 400);
  }
  const value = parsed as { u?: unknown; i?: unknown };
  if (typeof value.u !== "string" || typeof value.i !== "string") {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, "Invalid cursor", 400);
  }
  const updatedAt = new Date(value.u);
  if (Number.isNaN(updatedAt.getTime())) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, "Invalid cursor", 400);
  }
  return { updatedAt, id: value.i };
}
