import type { MessageModel } from "../../generated/prisma/models.js";
import type { DbClient } from "../../database/prisma.js";

export interface MessageCreateData {
  conversationId: string;
  role: string;
  content: string;
  status: string;
  position: number;
}

export class MessageRepository {
  async create(db: DbClient, data: MessageCreateData): Promise<MessageModel> {
    return db.message.create({ data });
  }

  /** 同一 Conversation 当前最大 position,没有消息时为 null */
  async findMaxPosition(db: DbClient, conversationId: string): Promise<number | null> {
    const result = await db.message.aggregate({
      where: { conversationId },
      _max: { position: true },
    });
    return result._max.position;
  }

  async listByConversation(db: DbClient, conversationId: string): Promise<MessageModel[]> {
    return db.message.findMany({
      where: { conversationId },
      orderBy: { position: "asc" },
    });
  }

  async findByIds(db: DbClient, ids: string[]): Promise<MessageModel[]> {
    return db.message.findMany({ where: { id: { in: ids } } });
  }
}
