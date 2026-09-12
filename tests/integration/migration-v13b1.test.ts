import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isUniqueViolation } from "../../src/common/utils/prisma-error.js";
import { setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";
import { migrationSql, rawCount, withFreshDb } from "../migration-harness.js";

/**
 * V1.3-B1 migration(User / Session / Conversation.userId)不变量。
 *
 * B1 阶段语义(V1.3-A Final Design §7/§11):
 * - Conversation.userId = nullable + **真实 FK**(不是"等 B4 再建 FK")
 * - 历史 Conversation 全部回填固定 ADMIN User;新行在 B1 阶段仍允许 NULL
 * - NOT NULL 收紧属于 B4(m2 重建表);届时 M1-05 的"NULL 仍合法"断言需同步更新
 * - Session 只有结构:没有任何签发/读取/续期行为(B2 才实现)
 *
 * 两条证据线:
 * - M1-01/02 在临时库上从历史 migration 基线手工重放,覆盖"先有数据、后迁移"的历史场景
 *   (global-setup 的 migrate deploy 只能一次性建到最新,无法内插历史数据)
 * - M1-03..08 在测试库上验证真实 schema 与约束行为
 */

const ADMIN_ID = "00000000-0000-0000-0000-000000000001";
const COMPAT_ID = "00000000-0000-0000-0000-000000000002";

const B1_MIGRATION = "20260911120000_v13_b1_user_session";
/** B1 之前的历史基线(本测试冻结在 V1.2,不随未来 migration 增减) */
const PRE_B1_MIGRATIONS = [
  "20260902135110_init_core_tables",
  "20260902150000_phase_2_1_concurrency_guards",
  "20260905024947_m1_model_selection",
  "20260910120547_v12_i1_attachment_count",
];

describe("V1.3-B1 migration:User / Session / Conversation.userId", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestContext();
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function columns(
    table: string,
  ): Promise<{ name: string; type: string; notnull: number }[]> {
    const rows = await ctx.prisma.$queryRawUnsafe<
      { name: string; type: string; notnull: bigint }[]
    >(`SELECT name, type, "notnull" FROM pragma_table_info('${table}')`);
    return rows.map((row) => ({ name: row.name, type: row.type, notnull: Number(row.notnull) }));
  }

  async function foreignKeys(table: string): Promise<
    { table: string; from: string; to: string; on_delete: string; on_update: string }[]
  > {
    return ctx.prisma.$queryRawUnsafe(
      `SELECT "table", "from", "to", "on_delete", "on_update" FROM pragma_foreign_key_list('${table}')`,
    );
  }

  async function sqliteObjects(sql: string): Promise<{ name: string; type: string }[]> {
    return ctx.prisma.$queryRawUnsafe(sql);
  }

  it("M1-01 空数据库:历史 migration 基线 → B1 顺序执行成功且结构就位", () => {
    withFreshDb((db) => {
      for (const name of PRE_B1_MIGRATIONS) {
        db.exec(migrationSql(name));
      }
      db.exec(migrationSql(B1_MIGRATION));

      const tables = (
        db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
      ).map((row) => row.name);
      expect(tables).toEqual(expect.arrayContaining(["User", "Session", "Conversation", "Message", "ModelRequest"]));

      const conversationColumns = db
        .prepare(`SELECT name, "notnull" FROM pragma_table_info('Conversation')`)
        .all() as { name: string; notnull: number }[];
      expect(conversationColumns.find((c) => c.name === "userId")).toMatchObject({ notnull: 0 });

      expect(
        rawCount(db, `SELECT COUNT(*) c FROM "User" WHERE "id" IN ('${ADMIN_ID}', '${COMPAT_ID}')`),
      ).toBe(2);
    });
  });

  it("M1-02 有历史 Conversation:迁移后 A/B 均回填 ADMIN 且行数守恒", () => {
    withFreshDb((db) => {
      for (const name of PRE_B1_MIGRATIONS) {
        db.exec(migrationSql(name));
      }
      // V1.2 风格历史数据:两条 Conversation + 一条 Message(updatedAt 无默认值,须显式给)
      db.exec(
        `INSERT INTO "Conversation" ("id","title","createdAt","updatedAt") VALUES
           ('legacy-a','A',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
           ('legacy-b','B',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      );
      db.exec(
        `INSERT INTO "Message" ("id","conversationId","role","content","status","position","createdAt","updatedAt")
         VALUES ('legacy-msg','legacy-a','USER','hi','COMPLETED',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      );

      db.exec(migrationSql(B1_MIGRATION));

      const rows = db
        .prepare(`SELECT "id", "userId" FROM "Conversation" ORDER BY "id"`)
        .all() as { id: string; userId: string | null }[];
      expect(rows).toEqual([
        { id: "legacy-a", userId: ADMIN_ID },
        { id: "legacy-b", userId: ADMIN_ID },
      ]);
      expect(rawCount(db, `SELECT COUNT(*) c FROM "Conversation" WHERE "userId" IS NULL`)).toBe(0);
      expect(rawCount(db, `SELECT COUNT(*) c FROM "Conversation"`)).toBe(2); // 行数守恒
      expect(rawCount(db, `SELECT COUNT(*) c FROM "Message"`)).toBe(1);

      // B1 阶段新行仍允许 NULL(与 Schema String? 一致;B4 收紧后此断言随 B4 更新)
      db.exec(
        `INSERT INTO "Conversation" ("id","title","createdAt","updatedAt") VALUES ('post-b1','C',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      );
      expect(
        rawCount(db, `SELECT COUNT(*) c FROM "Conversation" WHERE "id" = 'post-b1' AND "userId" IS NULL`),
      ).toBe(1);
    });
  });

  it("M1-03 固定系统 User:ADMIN / COMPAT 行存在且字段正确", async () => {
    const admin = await ctx.prisma.user.findUniqueOrThrow({ where: { id: ADMIN_ID } });
    expect(admin).toMatchObject({ type: "ADMIN", status: "ACTIVE" });
    expect(admin.createdAt).toBeInstanceOf(Date);
    expect(admin.updatedAt).toBeInstanceOf(Date);

    const compat = await ctx.prisma.user.findUniqueOrThrow({ where: { id: COMPAT_ID } });
    expect(compat).toMatchObject({ type: "ANONYMOUS", status: "ACTIVE" });

    // CHECK 约束行为:非法 type 被 DDL 拒绝(type/status 只认枚举)
    await expect(
      ctx.prisma.$executeRawUnsafe(`UPDATE "User" SET "type" = 'SUPER' WHERE "id" = '${COMPAT_ID}'`),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it("M1-04 Session schema:列序 / FK CASCADE / tokenHash 唯一 / 两个索引", async () => {
    expect((await columns("Session")).map((c) => c.name)).toEqual([
      "id",
      "userId",
      "tokenHash",
      "expiresAt",
      "lastSeenAt",
      "createdAt",
    ]);
    const cols = await columns("Session");
    expect(cols.find((c) => c.name === "userId")).toMatchObject({ notnull: 1 });
    expect(cols.find((c) => c.name === "tokenHash")).toMatchObject({ notnull: 1 });

    expect(await foreignKeys("Session")).toEqual([
      { table: "User", from: "userId", to: "id", on_delete: "CASCADE", on_update: "CASCADE" },
    ]);

    const indexes = (
      await sqliteObjects(`SELECT name, type FROM sqlite_master WHERE tbl_name='Session' AND type='index'`)
    ).map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining(["Session_tokenHash_key", "Session_userId_idx", "Session_expiresAt_idx"]),
    );

    // 唯一约束行为:同 tokenHash 第二条被拒
    const user = await ctx.prisma.user.create({ data: {} });
    const sessionData = {
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
      lastSeenAt: new Date(),
    };
    await ctx.prisma.session.create({ data: { ...sessionData, tokenHash: `m1-04-${user.id}` } });
    const err = await ctx.prisma.session
      .create({ data: { ...sessionData, tokenHash: `m1-04-${user.id}` } })
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(isUniqueViolation(err)).toBe(true);

    await ctx.prisma.user.delete({ where: { id: user.id } }); // Cascade 顺带清理
    expect(await ctx.prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it("M1-05 Conversation FK 真实生效:非法 userId 被拒、FK 指向 User.id(B1 阶段的 NULL 合法性由 M1-01/M1-02 在历史链上证明)", async () => {
    // B4 起 userId 必填(测试库已是最终态),这里只证明 B1 建起来的那条外键约束本身有效。
    // 「B1 migration 当时确实可空」属于历史阶段语义,取证在临时库:M1-01 读列定义、M1-02 真插 NULL 行。
    const conversation = await ctx.prisma.conversation.create({
      data: { title: "fk-probe", userId: COMPAT_ID },
    });
    expect(conversation.userId).toBe(COMPAT_ID);

    const err = await ctx.prisma
      .$executeRawUnsafe(`UPDATE "Conversation" SET "userId" = 'ghost-user' WHERE "id" = '${conversation.id}'`)
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(err).not.toBeNull();
    expect(String(err)).toMatch(/FOREIGN KEY|foreign key/i);

    await ctx.prisma.$executeRawUnsafe(
      `UPDATE "Conversation" SET "userId" = '${ADMIN_ID}' WHERE "id" = '${conversation.id}'`,
    );
    const reloaded = await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(reloaded.userId).toBe(ADMIN_ID);

    // FK 关系本身确实指向 User(id),不是同名空壳
    expect(await foreignKeys("Conversation")).toEqual([
      { table: "User", from: "userId", to: "id", on_delete: "RESTRICT", on_update: "CASCADE" },
    ]);
  });

  it("M1-06 ADMIN RESTRICT:被 Conversation 引用时删除 User 必须失败", async () => {
    await ctx.prisma.conversation.create({ data: { title: "restrict-probe", userId: ADMIN_ID } });

    const err = await ctx.prisma
      .$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = '${ADMIN_ID}'`)
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(err).not.toBeNull();
    expect(String(err)).toMatch(/FOREIGN KEY|foreign key/i);
    expect(await ctx.prisma.user.findUnique({ where: { id: ADMIN_ID } })).not.toBeNull();
  });

  it("M1-07 Session CASCADE:删除 User 自动删除其全部 Session", async () => {
    const user = await ctx.prisma.user.create({ data: { type: "ANONYMOUS" } });
    const session = await ctx.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: `m1-07-${user.id}`,
        expiresAt: new Date(Date.now() + 60_000),
        lastSeenAt: new Date(),
      },
    });

    await ctx.prisma.user.delete({ where: { id: user.id } });
    expect(await ctx.prisma.session.findUnique({ where: { id: session.id } })).toBeNull();
    expect(await ctx.prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
  });

  it("M1-08 历史不变量:两条触发器 / 活动态唯一索引 / Message 与 ModelRequest 关系原样保留", async () => {
    const objects = await sqliteObjects(
      `SELECT name, type FROM sqlite_master WHERE name IN (
         'trg_active_request_requires_active_conversation',
         'trg_active_request_blocks_conversation_status_change',
         'uk_active_request_per_conversation',
         'Message_conversationId_position_key')`,
    );
    expect(objects).toEqual(
      expect.arrayContaining([
        { name: "trg_active_request_requires_active_conversation", type: "trigger" },
        { name: "trg_active_request_blocks_conversation_status_change", type: "trigger" },
        { name: "uk_active_request_per_conversation", type: "index" },
        { name: "Message_conversationId_position_key", type: "index" },
      ]),
    );

    expect(await foreignKeys("Message")).toEqual([
      { table: "Conversation", from: "conversationId", to: "id", on_delete: "RESTRICT", on_update: "CASCADE" },
    ]);

    const requestFks = await foreignKeys("ModelRequest");
    expect(requestFks.map((fk) => `${fk.from}->${fk.table}.${fk.to}:${fk.on_delete}`).sort()).toEqual(
      [
        "assistantMessageId->Message.id:RESTRICT",
        "conversationId->Conversation.id:RESTRICT",
        "userMessageId->Message.id:RESTRICT",
      ].sort(),
    );
  });
});
