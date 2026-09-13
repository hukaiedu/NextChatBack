-- V1.4 U1:REGISTERED 凭据基础结构(只建列与唯一索引,不产生任何运行行为)
--
-- 本阶段冻结的边界(design §5/§16,U1 任务书 §5-§10):
--   - 只加三个可空列 + 一个 unique 索引;不建 REGISTERED 用户、不写任何数据
--   - 不加跨列 CHECK(REGISTERED => username NOT NULL 等):SQLite 无法对既有表
--     ADD CONSTRAINT,加 CHECK 必须整表重建 User,风险远大于收益(User 无 trigger,
--     但 b4 那次重建已经证明 PRAGMA/FK 编排的复杂度)。状态一致由 U2 的单一写入点保证。
--   - 不碰 Session / Conversation / Message / ModelRequest,不碰 CHECK 与既有索引
--
-- 为什么可空是硬要求:既有 ANONYMOUS 与固定 ADMIN(...0001)/COMPAT(...0002)行
--   必须原样存在。给它们填假用户名会污染唯一索引,也违反 U1 任务书 §6/§17。
--   SQLite 的 UNIQUE 索引中 NULL 彼此不相等 ⇒ 任意多条 NULL 行可共存(MIG-03 实测)。
--
-- 为什么必须自己包事务:实测 `prisma migrate deploy` 不替手写 SQLite migration 包事务
--   (V1.3-B4 已确认并采用同一写法),因此三条 ADD COLUMN + 一条 CREATE INDEX 若中途失败
--   会留下半套 schema。BEGIN…COMMIT 由本文件自己给出(MIG-05 实测回滚)。
BEGIN;

-- AddColumn
ALTER TABLE "User" ADD COLUMN "username" TEXT;
ALTER TABLE "User" ADD COLUMN "usernameNormalized" TEXT;
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT;

-- CreateIndex
-- 大小写不敏感唯一的唯一真相源:归一化由未来 U2 的 application 层负责(Sky/SKY -> sky),
-- 本索引只做精确唯一;不依赖 COLLATE NOCASE(它对非 ASCII 无效,且会把展示值卷入比较)。
CREATE UNIQUE INDEX "User_usernameNormalized_key" ON "User"("usernameNormalized");

COMMIT;
