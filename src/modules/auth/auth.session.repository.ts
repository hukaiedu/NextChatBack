import type { DbClient } from "../../database/prisma.js";
import type { SessionGetPayload } from "../../generated/prisma/models.js";

/**
 * 有效性判定需要连带 User 的 type/status;DTO 还需要 username(V1.4 U2 §39)。
 *
 * 这份投影是 Auth DTO 的唯一字段来源,因此**刻意不含** `passwordHash` 与
 * `usernameNormalized`:凭据读取走 AuthUserRepository.findByNormalizedUsername 单独一条路径,
 * 两者不共用投影 ⇒ 摘要串没有机会漂到响应面。
 */
const SESSION_USER_SELECT = {
  id: true,
  type: true,
  status: true,
  username: true,
} as const;

export type SessionWithUser = SessionGetPayload<{
  include: { user: { select: typeof SESSION_USER_SELECT } };
}>;

export interface SessionCreateData {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  lastSeenAt: Date;
}

export interface SessionTouchData {
  id: string;
  /** lastSeenAt <= cutoff 才允许续期(CAS 条件) */
  cutoff: Date;
  now: Date;
  expiresAt: Date;
}

/**
 * Session 持久化(V1.3 §7)。所有方法首参为 DbClient:匿名 bootstrap 必须能把
 * 交互式事务客户端传进来,让 User + Session 原子创建。
 */
export class AuthSessionRepository {
  async findByTokenHash(db: DbClient, tokenHash: string): Promise<SessionWithUser | null> {
    return db.session.findUnique({
      where: { tokenHash },
      include: { user: { select: SESSION_USER_SELECT } },
    });
  }

  async create(db: DbClient, data: SessionCreateData): Promise<SessionWithUser> {
    return db.session.create({
      data,
      include: { user: { select: SESSION_USER_SELECT } },
    });
  }

  /** 返回删除行数;0 = 本就不存在(登出/轮换幂等,不抛错) */
  async deleteByTokenHash(db: DbClient, tokenHash: string): Promise<number> {
    const result = await db.session.deleteMany({ where: { tokenHash } });
    return result.count;
  }

  /** 按 Session.id 删除(登录时的身份切换:先读旧行、再按 id 精准删除) */
  async deleteById(db: DbClient, id: string): Promise<number> {
    const result = await db.session.deleteMany({ where: { id } });
    return result.count;
  }

  /**
   * V1.3-B3-3 §29:吊销某个 User 名下的全部 Session(含调用者自己这一条)。
   * 只删 Session 行,不删 User;按 userId 等值过滤 ⇒ 绝不越界碰到其他身份的 Session。
   */
  async deleteAllForUser(db: DbClient, userId: string): Promise<number> {
    const result = await db.session.deleteMany({ where: { userId } });
    return result.count;
  }

  /** sweep 用:只删已过期行,不碰 User(V1.3 §19) */
  async deleteExpired(db: DbClient, now: Date): Promise<number> {
    const result = await db.session.deleteMany({ where: { expiresAt: { lte: now } } });
    return result.count;
  }

  /**
   * 滑动续期 CAS(V1.3 §13):lastSeenAt 未达 cutoff 或 Session 已过期 → count=0,
   * 绝不让已失效 Session 复活。并发下至多一个调用者 count=1。
   */
  async touchIfDue(db: DbClient, data: SessionTouchData): Promise<number> {
    const result = await db.session.updateMany({
      where: {
        id: data.id,
        lastSeenAt: { lte: data.cutoff },
        expiresAt: { gt: data.now },
      },
      data: { lastSeenAt: data.now, expiresAt: data.expiresAt },
    });
    return result.count;
  }
}
