import type { MessageModel } from "../../generated/prisma/models.js";
import type { DbClient } from "../../database/prisma.js";

export interface MessageCreateData {
  conversationId: string;
  role: string;
  content: string;
  status: string;
  position: number;
}

/** PAG-2:按 position desc 取更老一页;cursor 语义 position < cursorPosition */
export interface MessageListPageOptions {
  /** Service 已做 limit+1 探测,原样执行,Repo 不自行 +1 */
  take: number;
  cursorPosition?: number;
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

  /** PAG-2:cursor 位置向更老方向取 take 条(position desc);无 cursor = 从最新开始 */
  async listPage(
    db: DbClient,
    conversationId: string,
    options: MessageListPageOptions,
  ): Promise<MessageModel[]> {
    return db.message.findMany({
      where: {
        conversationId,
        ...(options.cursorPosition !== undefined
          ? { position: { lt: options.cursorPosition } }
          : {}),
      },
      orderBy: { position: "desc" },
      take: options.take,
    });
  }

  /** PAG-2:Conversation Message 总数(meta.totalCount) */
  async countByConversation(db: DbClient, conversationId: string): Promise<number> {
    return db.message.count({ where: { conversationId } });
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
