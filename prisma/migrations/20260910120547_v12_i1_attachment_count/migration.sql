-- V1.2 I1 §五:ModelRequest 记录附件份数(字节只活在内存的 AttachmentStore,永不落库)
--
-- 只加一列,刻意不碰任何其他约束:
--   - status 的七态 CHECK 原样保留(init_core_tables)
--   - Phase 2.1 两条 trigger 原样保留
--   - uk_active_request_per_conversation 原样保留
-- NOT NULL DEFAULT 0 是常量默认,SQLite 允许 ALTER TABLE ADD COLUMN 直接加,
-- 无需重建表;因此既有行自动读到 0 = 纯文本请求,V1/V1.1 语义不变。
ALTER TABLE "ModelRequest" ADD COLUMN "attachmentCount" INTEGER NOT NULL DEFAULT 0;
