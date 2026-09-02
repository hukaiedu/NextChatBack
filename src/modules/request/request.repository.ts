import type { ModelRequestModel } from "../../generated/prisma/models.js";
import type { DbClient } from "../../database/prisma.js";
import { REQUEST_ACTIVE_STATUSES } from "./request.types.js";

export interface ModelRequestCreateData {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  status: string;
  provider: string;
}

export class RequestRepository {
  async create(db: DbClient, data: ModelRequestCreateData): Promise<ModelRequestModel> {
    return db.modelRequest.create({ data });
  }

  async findById(db: DbClient, id: string): Promise<ModelRequestModel | null> {
    return db.modelRequest.findUnique({ where: { id } });
  }

  async findByIdempotencyKey(db: DbClient, key: string): Promise<ModelRequestModel | null> {
    return db.modelRequest.findUnique({ where: { idempotencyKey: key } });
  }

  async hasActive(db: DbClient, conversationId: string): Promise<boolean> {
    const found = await db.modelRequest.findFirst({
      where: {
        conversationId,
        status: { in: [...REQUEST_ACTIVE_STATUSES] },
      },
      select: { id: true },
    });
    return found !== null;
  }

  async listByConversation(db: DbClient, conversationId: string): Promise<ModelRequestModel[]> {
    return db.modelRequest.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });
  }
}
