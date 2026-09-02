import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

import { PrismaClient, Prisma } from "../generated/prisma/client.js";

/** 数据访问客户端:PrismaClient 或交互式事务中的 TransactionClient */
export type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * Prisma 7 + better-sqlite3 driver adapter(SQLite 文件由 DATABASE_URL 指定)。
 *
 * better-sqlite3 默认不开启外键检查,必须显式 PRAGMA foreign_keys = ON
 * 约束才能生效(migration 中的 FK 依赖它)。
 */
export async function createPrismaClient(databaseUrl: string): Promise<PrismaClient> {
  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  const client = new PrismaClient({ adapter });
  await client.$executeRawUnsafe("PRAGMA foreign_keys = ON");
  return client;
}

/** 健康检查探针:真实执行 SQL,失败即抛错 */
export async function probeDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}
