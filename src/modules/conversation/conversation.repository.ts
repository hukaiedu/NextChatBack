import type { ConversationModel, ConversationWhereInput } from "../../generated/prisma/models.js";
import type { DbClient } from "../../database/prisma.js";

export interface ConversationCreateData {
  title: string;
  status: string;
  provider: string;
  /** V1.3-B3:归属用户 = req.auth.userId;客户端提供的 owner 一律不采信 */
  userId: string;
}

export interface ConversationUpdateData {
  title?: string;
  status?: string;
  deletedAt?: Date | null;
  /** M1:undefined = 不动;null = 清除偏好(Prisma updateMany 原生语义,无需特判) */
  preferredModelKey?: string | null;
}

export interface ConversationListQuery {
  /** V1.3-B3:owner 维度过滤下推到数据库,禁止全局查完再在 JS 里筛 */
  userId: string;
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

  /**
   * V1.3-B3:Public API 的单资源访问原语 —— 存在性与归属一次判定。
   *
   * 「不存在」与「属于别人」在这里返回同一个 null,调用方据此统一 404,
   * 不给攻击者留下探测他人 Conversation 的差异。userId 等值条件同时让
   * B1 迁移期的 NULL-owner 行天然不可见(owner 未知 = 谁都不能读)。
   */
  async findOwnedById(
    db: DbClient,
    id: string,
    userId: string,
  ): Promise<ConversationModel | null> {
    return db.conversation.findFirst({ where: { id, userId } });
  }

  /** 列表:status 过滤 + updatedAt DESC、id DESC 稳定排序 + (updatedAt,id) 游标翻页 */
  async list(db: DbClient, query: ConversationListQuery): Promise<ConversationModel[]> {
    const where: ConversationWhereInput = { userId: query.userId, status: query.status };
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
   *
   * 只供系统侧写入(Scheduler 执行链按 request.conversationId 回写时间戳):
   * 用户发起的写入必须走 updateOwned,否则 owner 条件就丢了。
   */
  async update(
    db: DbClient,
    id: string,
    data: ConversationUpdateData,
  ): Promise<ConversationModel | null> {
    return this.applyUpdate(db, { id }, data);
  }

  /** V1.3-B3:用户发起的写入 —— id 与 userId 同时进 where,不是本人就是 0 行 */
  async updateOwned(
    db: DbClient,
    id: string,
    userId: string,
    data: ConversationUpdateData,
  ): Promise<ConversationModel | null> {
    return this.applyUpdate(db, { id, userId }, data);
  }

  private async applyUpdate(
    db: DbClient,
    where: ConversationWhereInput,
    data: ConversationUpdateData,
  ): Promise<ConversationModel | null> {
    const effectiveData = Object.keys(data).length === 0 ? { updatedAt: new Date() } : data;
    const result = await db.conversation.updateMany({ where, data: effectiveData });
    if (result.count === 0) {
      return null;
    }
    return db.conversation.findFirst({ where });
  }
}

