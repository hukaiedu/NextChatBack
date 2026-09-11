-- V1.3-B1:User / Session 基础结构 + Conversation.userId(nullable + 真实 FK) + 历史回填
--
-- 本阶段冻结的边界:
--   - Conversation.userId 允许 NULL(Schema 仍表达 String?);历史行必须全部回填 ADMIN
--   - 本迁移不重建 Conversation:NOT NULL 收紧留到 B4(m2 重建表 + 触发器重建)
--   - Session 只建结构;签发/读取/续期/清除等运行逻辑属 B2(本迁移不产生任何行为变更)
--
-- SQLite 事实(已在 3.53.2 / better-sqlite3 12.11.1 实测):
--   foreign_keys=ON 下仍允许 ADD COLUMN ... REFERENCES,因为新列默认值为 NULL;
--   增列后 FK 立即生效(写入非法 userId 报 FOREIGN KEY constraint failed)。

-- CreateTable
-- 手工补充:User.type CHECK(三态)、User.status CHECK(两态)
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL DEFAULT 'ANONYMOUS' CHECK ("type" IN ('ANONYMOUS', 'REGISTERED', 'ADMIN')),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'DISABLED')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "lastSeenAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- 固定系统 User(V1.3-A Final Design §7):
--   00000000-...-0001 = ADMIN(历史 Conversation owner + 未来管理员身份)
--   00000000-...-0002 = COMPAT(AUTH_ENABLED=false 的本地兼容主体,非 ADMIN)
-- 幂等:INSERT OR IGNORE。raw SQL 不经过 Prisma @updatedAt,时间戳显式给。
INSERT OR IGNORE INTO "User" ("id", "type", "status", "createdAt", "updatedAt") VALUES
    ('00000000-0000-0000-0000-000000000001', 'ADMIN',     'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('00000000-0000-0000-0000-000000000002', 'ANONYMOUS', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Conversation 加列:nullable + 真实 FK(B1 阶段不收紧 NOT NULL)
ALTER TABLE "Conversation" ADD COLUMN "userId" TEXT REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 历史数据回填:全部归 ADMIN;WHERE IS NULL 保证可重入
UPDATE "Conversation" SET "userId" = '00000000-0000-0000-0000-000000000001' WHERE "userId" IS NULL;

-- CreateIndex
CREATE INDEX "Conversation_userId_status_updatedAt_idx" ON "Conversation"("userId", "status", "updatedAt");
