-- Phase 2.1:并发不变量数据库保护(手工编写,非 Prisma DSL 生成)
--
-- 业务不变量:
--   1. 只有 ACTIVE Conversation 才能创建 PENDING/PROCESSING/CANCELLING ModelRequest
--   2. 存在活动 ModelRequest 时,Conversation 不能变成 ARCHIVED / DELETED
--
-- 原理:SQLite 写语句原子且串行,trigger 在写语句内检查的是最新已提交状态,
-- 不存在"先读后写"窗口,保证 Send Message ↔ Archive/Delete 并发时数据库永远合法。

-- Guard 1:活动 Request 只能存在于 ACTIVE Conversation
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

-- Guard 2:存在活动 Request 时禁止 Conversation → ARCHIVED / DELETED
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
