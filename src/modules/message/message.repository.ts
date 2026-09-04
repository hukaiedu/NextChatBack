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

  async findById(db: DbClient, id: string): Promise<MessageModel | null> {
    return db.message.findUnique({ where: { id } });
  }

  async updateStatus(db: DbClient, id: string, status: string): Promise<void> {
    await db.message.update({ where: { id }, data: { status } });
  }

  /** 成功收尾:内容与状态一次写入(§12.10) */
  async updateContentAndStatus(
    db: DbClient,
    id: string,
    content: string,
    status: string,
  ): Promise<void> {
    await db.message.update({ where: { id }, data: { content, status } });
  }

  /**
   * 流式回答期间刷新内容(第 6 阶段):只写 content,状态条件锁死在 STREAMING。
   * 返回受影响行数,0 表示消息已被收尾(状态归 RequestService),调用方决定丢弃还是报错。
   */
  async updateContentIfStreaming(
    db: DbClient,
    id: string,
    content: string,
  ): Promise<number> {
    const result = await db.message.updateMany({
      where: { id, status: "STREAMING" },
      data: { content },
    });
    return result.count;
  }
}
