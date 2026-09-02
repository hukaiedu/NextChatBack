import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

import { PrismaClient } from "../generated/prisma/client.js";

/** Prisma 7 + better-sqlite3 driver adapter(SQLite 文件由 DATABASE_URL 指定) */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  return new PrismaClient({ adapter });
}

/** 健康检查探针:真实执行 SQL,失败即抛错 */
export async function probeDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}
