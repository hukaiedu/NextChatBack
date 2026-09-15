import type { DbClient } from "../../database/prisma.js";
import type { UserModel } from "../../generated/prisma/models.js";

/**
 * 凭据查询投影(V1.4 U2)。
 *
 * 刻意只列判定所需的六个字段:凭据路径绝不允许顺带把 sessions / conversations 关系拉出来,
 * 那既是最热路径上的隐式 N 倍查询,也会让 passwordHash 有机会漂到 DTO 附近。
 */
export interface CredentialUser {
  id: string;
  type: string;
  status: string;
  username: string | null;
  usernameNormalized: string | null;
  passwordHash: string | null;
}

const CREDENTIAL_SELECT = {
  id: true,
  type: true,
  status: true,
  username: true,
  usernameNormalized: true,
  passwordHash: true,
} as const;

export class AuthUserRepository {
  async findById(db: DbClient, id: string): Promise<UserModel | null> {
    return db.user.findUnique({ where: { id } });
  }

  /** V1.3 §8:bootstrap 事务内建匿名 User;必须与 Session 同事务,禁止孤儿 User */
  async createAnonymous(db: DbClient): Promise<UserModel> {
    return db.user.create({ data: { type: "ANONYMOUS", status: "ACTIVE" } });
  }

  /**
   * 按归一化用户名取凭据行(V1.4 U2 §22)。
   *
   * `usernameNormalized` 上的是 UNIQUE 索引(U1 migration),所以这里可以用 findUnique;
   * 但**唯一性的最终裁决始终是 DB**,不是这一句预查 —— 预查只是让「用户名已被占用」
   * 在花钱散列之前就返回(§30),并发下的同名由 P2002 兜住(§46)。
   */
  async findByNormalizedUsername(
    db: DbClient,
    usernameNormalized: string,
  ): Promise<CredentialUser | null> {
    return db.user.findUnique({
      where: { usernameNormalized },
      select: CREDENTIAL_SELECT,
    });
  }

  /**
   * 匿名原地升级为注册用户(V1.4 U2 §23,R7)。
   *
   * `WHERE id = ? AND type = 'ANONYMOUS' AND status = 'ACTIVE'` 这个谓词就是 CAS:并发双提交里只有第一条
   * 拿到 count=1,败方拿到 0 —— 靠 SQLite 写序列化裁决,不靠读后判断,所以
   * **User 终态不会随机覆盖**。升级只写这一行:不动 Conversation/Message/ModelRequest,
   * 因此零业务数据搬迁(R7)是结构性的,不是靠约定。
   */
  async upgradeAnonymousToRegistered(
    db: DbClient,
    data: { userId: string; username: string; usernameNormalized: string; passwordHash: string },
  ): Promise<number> {
    const result = await db.user.updateMany({
      where: { id: data.userId, type: "ANONYMOUS", status: "ACTIVE" },
      data: {
        type: "REGISTERED",
        username: data.username,
        usernameNormalized: data.usernameNormalized,
        passwordHash: data.passwordHash,
      },
    });
    return result.count;
  }

  /**
   * 改密写入新摘要(V1.4 U2 §61)。
   *
   * WHERE 带 `type = 'REGISTERED'`:匿名与管理员行的 passwordHash 恒为 NULL,
   * 给它们写口令摘要就是数据损坏,这条谓词让它变成 0 行而不是悄悄发生。
   */
  async updatePasswordHash(
    db: DbClient,
    data: { userId: string; passwordHash: string },
  ): Promise<number> {
    const result = await db.user.updateMany({
      where: { id: data.userId, type: "REGISTERED" },
      data: { passwordHash: data.passwordHash },
    });
    return result.count;
  }
}
