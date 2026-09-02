import type { PrismaClient } from "../../generated/prisma/client.js";
import type { ConversationModel } from "../../generated/prisma/models.js";
import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
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
    const updated = await this.conversationRepo.update(this.prisma, id, {
      title: patch.title,
      status: patch.status,
    });
    if (!updated) {
      throw new AppError(ErrorCodes.CONVERSATION_NOT_FOUND, "Conversation not found", 404);
    }
    return updated;
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
    await this.conversationRepo.update(this.prisma, id, {
      status: "DELETED",
      deletedAt: new Date(),
    });
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
