import type { DbClient } from "../../database/prisma.js";
import type { UserModel } from "../../generated/prisma/models.js";

export class AuthUserRepository {
  async findById(db: DbClient, id: string): Promise<UserModel | null> {
    return db.user.findUnique({ where: { id } });
  }

  /** V1.3 §8:bootstrap 事务内建匿名 User;必须与 Session 同事务,禁止孤儿 User */
  async createAnonymous(db: DbClient): Promise<UserModel> {
    return db.user.create({ data: { type: "ANONYMOUS", status: "ACTIVE" } });
  }
}
