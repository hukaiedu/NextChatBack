-- V1.3-B4 §35..§41:Conversation.userId 收紧为 NOT NULL。
--
-- SQLite 没有 ALTER COLUMN SET NOT NULL:唯一诚实的做法是重建表。
-- 新表 DDL 逐列抄自 `sqlite_master` 里迁移前的真实定义(见 §38),只把 userId 改成 NOT NULL:
--   id / title / status(含 CHECK 与 DEFAULT)/ provider(含 DEFAULT)/ providerConversationUrl
--   / createdAt / updatedAt / deletedAt / preferredModelKey / userId(FK → User)
-- 列顺序也与原表一致,重建不该悄悄改变 pragma_table_info 的 cid 顺序。
--
-- §46:**不做** NULL → ADMIN 的回填。B1 已把历史行回填完,B3 起运行期每条新会话都显式带 owner;
-- 这里若还有 NULL,说明链路上有生产 Bug,让 INSERT..SELECT 直接撞 NOT NULL 约束、整个 migration 失败,
-- 而不是静默把未知归属的数据认领给 ADMIN。
--
-- §39/§41:Conversation 上的 UNIQUE 索引、三个普通索引和
-- trg_active_request_blocks_conversation_status_change 都会随 DROP TABLE 一起消失,必须在原位置重建。
-- trg_active_request_requires_active_conversation 挂在 ModelRequest 上,但因 body 引用 Conversation,
-- 实测会挡住 DROP TABLE(见下方 §42 取证),因此同样先拆后建。
-- 两条触发器都不能拿「sqlite_master 里名字还在」当验收 —— 由 migration-v13b4.test.ts 跑真实行为。

PRAGMA defer_foreign_keys = ON;
PRAGMA foreign_keys = OFF;

-- FIX-02B 取证(B4-DEPLOY-02:在含 NULL owner 的库上跑真实 `prisma migrate deploy`):
--   失败点 = INSERT INTO new_Conversation … SELECT ⇒ P3018 / NOT NULL constraint failed: new_Conversation.userId
--   加事务前该库**残留了 `new_Conversation`**(半迁移),说明 runner 不会替本文件包事务。
--   所以边界必须写在这里:BEGIN … COMMIT 覆盖全部 DDL/DML,失败时连接关闭由 SQLite 自动回滚。
--   两个 PRAGMA 留在 BEGIN 之前 —— `PRAGMA foreign_keys` 在事务内是 no-op,放进事务等于没关。
BEGIN;

-- §42 取证:ModelRequest 上那条触发器的 body 引用 Conversation。SQLite 不允许 DROP 一张
-- 被其他表触发器引用的表(`DROP TABLE "Conversation"` 直接报
-- "error in trigger trg_active_request_requires_active_conversation: no such table: main.Conversation"),
-- 所以两张触发器都必须先拆掉,重建完成后一起恢复。
DROP TRIGGER "trg_active_request_requires_active_conversation";

CREATE TABLE "new_Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'ARCHIVED', 'DELETED')),
    "provider" TEXT NOT NULL DEFAULT 'GEMINI_WEB',
    "providerConversationUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "preferredModelKey" TEXT,
    "userId" TEXT NOT NULL REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "new_Conversation"
    ("id", "title", "status", "provider", "providerConversationUrl",
     "createdAt", "updatedAt", "deletedAt", "preferredModelKey", "userId")
SELECT
    "id", "title", "status", "provider", "providerConversationUrl",
    "createdAt", "updatedAt", "deletedAt", "preferredModelKey", "userId"
FROM "Conversation";

DROP TABLE "Conversation";

ALTER TABLE "new_Conversation" RENAME TO "Conversation";

CREATE UNIQUE INDEX "Conversation_providerConversationUrl_key" ON "Conversation"("providerConversationUrl");
CREATE INDEX "Conversation_status_idx" ON "Conversation"("status");
CREATE INDEX "Conversation_updatedAt_idx" ON "Conversation"("updatedAt");
CREATE INDEX "Conversation_userId_status_updatedAt_idx" ON "Conversation"("userId", "status", "updatedAt");

CREATE TRIGGER trg_active_request_blocks_conversation_status_change
BEFORE UPDATE OF "status" ON "Conversation"
WHEN NEW."status" IN ('ARCHIVED', 'DELETED') AND OLD."status" <> NEW."status"
BEGIN
    SELECT RAISE(ABORT, 'active_request_blocks_conversation_status_change')
    WHERE EXISTS (
        SELECT 1 FROM "ModelRequest"
        WHERE "conversationId" = NEW."id"
          AND "status" IN ('PENDING', 'PROCESSING', 'CANCELLING')
    );
END;

CREATE TRIGGER trg_active_request_requires_active_conversation
BEFORE INSERT ON "ModelRequest"
WHEN NEW."status" IN ('PENDING', 'PROCESSING', 'CANCELLING')
BEGIN
    SELECT RAISE(ABORT, 'model_request_active_requires_active_conversation')
    WHERE NOT EXISTS (
        SELECT 1 FROM "Conversation"
        WHERE "id" = NEW."conversationId" AND "status" = 'ACTIVE'
    );
END;

COMMIT;

PRAGMA foreign_keys = ON;
PRAGMA defer_foreign_keys = OFF;
