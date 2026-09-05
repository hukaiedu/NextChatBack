import type { ConversationModel, ConversationWhereInput } from "../../generated/prisma/models.js";
import type { DbClient } from "../../database/prisma.js";

export interface ConversationCreateData {
  title: string;
  status: string;
  provider: string;
}

export interface ConversationUpdateData {
  title?: string;
  status?: string;
  deletedAt?: Date | null;
  /** M1:undefined = 不动;null = 清除偏好(Prisma updateMany 原生语义,无需特判) */
  preferredModelKey?: string | null;
}

export interface ConversationListQuery {
  status: string;
  limit: number;
  cursor?: { updatedAt: Date; id: string } | null;
}

export class ConversationRepository {
  async create(db: DbClient, data: ConversationCreateData): Promise<ConversationModel> {
    return db.conversation.create({ data });
  }

  async findById(db: DbClient, id: string): Promise<ConversationModel | null> {
    return db.conversation.findUnique({ where: { id } });
  }

  /** 列表:status 过滤 + updatedAt DESC、id DESC 稳定排序 + (updatedAt,id) 游标翻页 */
  async list(db: DbClient, query: ConversationListQuery): Promise<ConversationModel[]> {
    const where: ConversationWhereInput = { status: query.status };
    if (query.cursor) {
      where.OR = [
        { updatedAt: { lt: query.cursor.updatedAt } },
        { updatedAt: query.cursor.updatedAt, id: { lt: query.cursor.id } },
      ];
    }
    return db.conversation.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: query.limit,
    });
  }

  /**
   * 绑定 Provider Conversation URL,first-write-wins:
   * WHERE 里带 providerConversationUrl IS NULL,已有值时返回 null(绝不覆盖)。
   * 通用 update 故意不支持该列,避免被无条件改绑。
   */
  async bindProviderConversationUrl(
    db: DbClient,
    id: string,
    url: string,
  ): Promise<ConversationModel | null> {
    const result = await db.conversation.updateMany({
      where: { id, providerConversationUrl: null },
      data: { providerConversationUrl: url },
    });
    if (result.count === 0) {
      return null;
    }
    return this.findById(db, id);
  }

  /**
   * 更新并返回更新后的记录;不存在返回 null。
   * 空 data 时只刷新 updatedAt(@updatedAt 由 Prisma 写入)。
   */
  async update(
    db: DbClient,
    id: string,
    data: ConversationUpdateData,
  ): Promise<ConversationModel | null> {
    const effectiveData = Object.keys(data).length === 0 ? { updatedAt: new Date() } : data;
    const result = await db.conversation.updateMany({ where: { id }, data: effectiveData });
    if (result.count === 0) {
      return null;
    }
    return this.findById(db, id);
  }
}

