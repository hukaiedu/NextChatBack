import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ADMIN_USER_ID, COMPAT_USER_ID } from "../../src/config/constants.js";
import { setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";
import {
  columnsOf,
  foreignKeysOf,
  foreignKeyViolations,
  insertMessagePair,
  insertRequest,
  migrationSql,
  objectSql,
  rawCount,
  replayMigrations,
  withFreshDb,
} from "../migration-harness.js";
import type { RawDb } from "../migration-harness.js";

/**
 * V1.3-B4:Conversation.userId 收紧为 NOT NULL 的最终态不变量(§35..§46)。
 *
 * 两条证据线(与 migration-v13b1 同一套路):
 * - B4-01..04 在临时库上从历史基线重放,覆盖「先有数据、后迁移」与迁移前后的逐字段守恒;
 * - B4-05..06 在测试库上验证真实 schema 与运行期约束。
 *
 * §42 明确禁止拿「trigger 名字还在」当验收:两条触发器都跑真实行为(TRG-01/01N/02/02N),
 * 因为本次重建会 DROP Conversation,而 ModelRequest 上那条的 body 引用 Conversation 名。
 */

const B4_MIGRATION = "20260911170000_v13_b4_conversation_owner_not_null";
/** B4 之前的完整链路(V1.2 → M1 → I1 → B1) */
const PRE_B4_MIGRATIONS = [
  "20260902135110_init_core_tables",
  "20260902150000_phase_2_1_concurrency_guards",
  "20260905024947_m1_model_selection",
  "20260910120547_v12_i1_attachment_count",
  "20260911120000_v13_b1_user_session",
];

const INDEX_NAMES = [
  "Conversation_providerConversationUrl_key",
  "Conversation_status_idx",
  "Conversation_updatedAt_idx",
  "Conversation_userId_status_updatedAt_idx",
];

const TRIGGER_NAMES = [
  "trg_active_request_blocks_conversation_status_change",
  "trg_active_request_requires_active_conversation",
];

/** 会话全字段快照:时间列统一 CAST 成文本,避免迁移前后因表述差异产生假阳性 */
const CONVERSATION_SNAPSHOT = `
  SELECT "id" id, "title" title, "status" status, "provider" provider,
         "providerConversationUrl" providerConversationUrl,
         CAST("preferredModelKey" AS TEXT) preferredModelKey,
         CAST("createdAt" AS TEXT) createdAt, CAST("updatedAt" AS TEXT) updatedAt,
         CAST("deletedAt" AS TEXT) deletedAt, "userId" userId
  FROM "Conversation" ORDER BY "id"`;

function snapshot(db: RawDb): Record<string, unknown>[] {
  return db.prepare(CONVERSATION_SNAPSHOT).all() as Record<string, unknown>[];
}

/** 造一条「每个可空列都有值」的历史会话,守恒测试才有意义 */
function insertFullConversation(db: RawDb, id: string): void {
  db.exec(
    `INSERT INTO "Conversation"
       ("id","title","status","provider","providerConversationUrl","preferredModelKey",
        "createdAt","updatedAt","deletedAt","userId")
     VALUES ('${id}','历史标题','ACTIVE','GEMINI_WEB','https://gemini.example/app/${id}','model-b',
             '2026-01-02 03:04:05','2026-02-03 04:05:06','2026-03-04 05:06:07','${COMPAT_USER_ID}')`,
  );
}

describe("V1.3-B4 migration:Conversation.userId NOT NULL", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestContext();
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("B4-01 历史链 V1.2 → B1 → B4 重放成功且最终结构就位(§37/§38/§39/§40)", () => {
    withFreshDb((db) => {
      replayMigrations(db, PRE_B4_MIGRATIONS);

      const columnsBefore = columnsOf(db, "Conversation");
      const foreignKeysBefore = foreignKeysOf(db, "Conversation");
      // 迁移前:userId 可空(B1 语义)
      expect(columnsBefore.find((c) => c.name === "userId")).toMatchObject({ notnull: 0 });
      const indexSqlBefore = Object.fromEntries(INDEX_NAMES.map((n) => [n, objectSql(db, n)]));
      const triggerSqlBefore = Object.fromEntries(TRIGGER_NAMES.map((n) => [n, objectSql(db, n)]));

      db.exec(migrationSql(B4_MIGRATION));

      // §38:列集合与顺序逐字保留,唯一变化是 userId 的 notnull 0 → 1;且它没有拿到默认值(§36)
      const columnsAfter = columnsOf(db, "Conversation");
      expect(columnsAfter.map((c) => c.name)).toEqual(columnsBefore.map((c) => c.name));
      const drifted = columnsAfter
        .map((column, index) => ({ before: columnsBefore[index]!, after: column }))
        .filter(({ before, after }) => JSON.stringify(before) !== JSON.stringify(after));
      expect(drifted).toEqual([
        { before: expect.objectContaining({ name: "userId", notnull: 0 }), after: expect.objectContaining({ name: "userId", notnull: 1 }) },
      ]);
      expect(columnsAfter.find((c) => c.name === "userId")!.dflt_value).toBeNull();
      expect(columnsAfter.find((c) => c.name === "id")!.pk).toBe(1);

      // status 的 CHECK 与三列默认值必须随重建一起保留
      const ddl = objectSql(db, "Conversation");
      expect(ddl).toContain(`CHECK ("status" IN ('ACTIVE', 'ARCHIVED', 'DELETED'))`);
      expect(ddl).toContain(`"status" TEXT NOT NULL DEFAULT 'ACTIVE'`);
      expect(ddl).toContain(`"provider" TEXT NOT NULL DEFAULT 'GEMINI_WEB'`);
      expect(ddl).toContain(`"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`);
      expect(columnsAfter.find((c) => c.name === "updatedAt")!.notnull).toBe(1);
      expect(columnsAfter.find((c) => c.name === "updatedAt")!.dflt_value).toBeNull();

      // §39:索引定义逐字节不变(名字、UNIQUE、列序)
      for (const name of INDEX_NAMES) {
        expect(objectSql(db, name)).toBe(indexSqlBefore[name]);
      }

      // §40:FK 指向与动作不变,并且整库外键检查为空
      expect(foreignKeysOf(db, "Conversation")).toEqual(foreignKeysBefore);
      expect(foreignKeysOf(db, "Conversation")).toEqual([
        { table: "User", from: "userId", to: "id", on_delete: "RESTRICT", on_update: "CASCADE" },
      ]);
      expect(foreignKeysOf(db, "Message")).toEqual([
        { table: "Conversation", from: "conversationId", to: "id", on_delete: "RESTRICT", on_update: "CASCADE" },
      ]);
      expect(foreignKeysOf(db, "ModelRequest").map((fk) => fk.table).sort()).toEqual(
        ["Conversation", "Message", "Message"],
      );
      expect(foreignKeyViolations(db)).toEqual([]);

      // §41/§42:两条触发器都按原 body 恢复
      for (const name of TRIGGER_NAMES) {
        expect(objectSql(db, name)).toBe(triggerSqlBefore[name]);
      }
    });
  });

  it("B4-02 数据守恒:每个字段逐值不变(§45)", () => {
    withFreshDb((db) => {
      replayMigrations(db, PRE_B4_MIGRATIONS);
      insertFullConversation(db, "conv-full");
      db.exec(
        `INSERT INTO "Conversation" ("id","title","status","provider","createdAt","updatedAt","userId")
         VALUES ('conv-plain','普通会话','ACTIVE','GEMINI_WEB',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'${ADMIN_USER_ID}')`,
      );
      const pair = insertMessagePair(db, "conv-full", "1");
      insertRequest(db, {
        id: "req-terminal",
        conversationId: "conv-full",
        userMessageId: pair.userMessageId,
        assistantMessageId: pair.assistantMessageId,
        status: "SUCCESS",
      });

      const before = snapshot(db);
      const messagesBefore = db.prepare(`SELECT COUNT(*) c FROM "Message"`).all();
      db.exec(migrationSql(B4_MIGRATION));

      // 逐字段比较,而不是只比行数
      expect(snapshot(db)).toEqual(before);
      expect(before.map((row) => row.id)).toEqual(["conv-full", "conv-plain"]);
      expect(before.find((row) => row.id === "conv-full")).toMatchObject({
        title: "历史标题",
        status: "ACTIVE",
        provider: "GEMINI_WEB",
        providerConversationUrl: "https://gemini.example/app/conv-full",
        preferredModelKey: "model-b",
        createdAt: "2026-01-02 03:04:05",
        updatedAt: "2026-02-03 04:05:06",
        deletedAt: "2026-03-04 05:06:07",
        userId: COMPAT_USER_ID,
      });
      expect(db.prepare(`SELECT COUNT(*) c FROM "Message"`).all()).toEqual(messagesBefore);
      expect(rawCount(db, `SELECT COUNT(*) c FROM "ModelRequest"`)).toBe(1);
      expect(rawCount(db, `SELECT COUNT(*) c FROM "Conversation" WHERE "userId" IS NULL`)).toBe(0);
    });
  });

  it("B4-03 存在 NULL owner 时 migration 必须失败且不静默认领(§46)", () => {
    withFreshDb((db) => {
      replayMigrations(db, PRE_B4_MIGRATIONS);
      // B1 阶段仍然合法的无主行:正常部署链走到 B4 时不该再出现
      db.exec(
        `INSERT INTO "Conversation" ("id","title","createdAt","updatedAt")
         VALUES ('orphan','无主会话',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      );

      // B4 自带 BEGIN…COMMIT 边界(FIX-02B),所以这里不能再开外层事务
      const error = (() => {
        try {
          db.exec(migrationSql(B4_MIGRATION));
          return null;
        } catch (caught) {
          return caught;
        }
      })();
      // 失败发生在迁移自己的事务里 ⇒ 显式回滚,不留半成品
      db.exec("ROLLBACK");

      expect(String(error)).toMatch(/NOT NULL constraint failed/);
      // 失败即回滚:未知归属的数据不会被偷偷写成 ADMIN 后继续上线
      expect(rawCount(db, `SELECT COUNT(*) c FROM "Conversation" WHERE "userId" IS NULL`)).toBe(1);
      expect(rawCount(db, `SELECT COUNT(*) c FROM "Conversation" WHERE "userId" = '${ADMIN_USER_ID}'`)).toBe(0);
      expect(
        db.prepare(`SELECT name FROM sqlite_master WHERE name = 'new_Conversation'`).all(),
      ).toEqual([]);
    });
  });

  it("B4-04 触发器行为:TRG-01 / TRG-01N / TRG-02 / TRG-02N 在最终态仍然生效(§42/§43)", () => {
    withFreshDb((db) => {
      replayMigrations(db, PRE_B4_MIGRATIONS);
      db.exec(migrationSql(B4_MIGRATION));

      function prepared(conversationId: string, status: string): void {
        db.exec(
          `INSERT INTO "Conversation" ("id","title","status","createdAt","updatedAt","userId")
           VALUES ('${conversationId}','t','${status}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'${COMPAT_USER_ID}')`,
        );
        const pair = insertMessagePair(db, conversationId, "x");
        insertRequest(db, {
          id: `req-${conversationId}`,
          conversationId,
          userMessageId: pair.userMessageId,
          assistantMessageId: pair.assistantMessageId,
          status: "SUCCESS",
        });
      }

      // TRG-01:非 ACTIVE 会话上插入活动 Request 必须 ABORT;DELETED 变体同理
      for (const status of ["ARCHIVED", "DELETED"]) {
        const id = `trg01-${status}`;
        prepared(id, status);
        const pair = insertMessagePair(db, id, "act", 3);
        expect(() =>
          insertRequest(db, {
            id: `req-active-${id}`,
            conversationId: id,
            userMessageId: pair.userMessageId,
            assistantMessageId: pair.assistantMessageId,
            status: "PENDING",
          }),
        ).toThrow(/model_request_active_requires_active_conversation/);
      }

      // TRG-01N:ACTIVE 会话上的合法活动 Request 不受影响
      prepared("trg01n", "ACTIVE");
      const okPair = insertMessagePair(db, "trg01n", "act", 3);
      insertRequest(db, {
        id: "req-active-trg01n",
        conversationId: "trg01n",
        userMessageId: okPair.userMessageId,
        assistantMessageId: okPair.assistantMessageId,
        status: "PENDING",
      });
      expect(rawCount(db, `SELECT COUNT(*) c FROM "ModelRequest" WHERE "id" = 'req-active-trg01n'`)).toBe(1);

      // TRG-02:有活动 Request 的会话不能转 ARCHIVED / DELETED
      expect(() => db.exec(`UPDATE "Conversation" SET "status" = 'ARCHIVED' WHERE "id" = 'trg01n'`)).toThrow(
        /active_request_blocks_conversation_status_change/,
      );
      expect(() => db.exec(`UPDATE "Conversation" SET "status" = 'DELETED' WHERE "id" = 'trg01n'`)).toThrow(
        /active_request_blocks_conversation_status_change/,
      );

      // TRG-02N:没有活动 Request 的会话改状态正常成功(顺带确认不是「把所有 UPDATE 都挡死」)
      prepared("trg02n", "ACTIVE");
      db.exec(`UPDATE "Conversation" SET "status" = 'ARCHIVED' WHERE "id" = 'trg02n'`);
      expect(
        (db.prepare(`SELECT "status" s FROM "Conversation" WHERE "id" = 'trg02n'`).get() as { s: string }).s,
      ).toBe("ARCHIVED");
    });
  });

  it("B4-05 运行期 NOT NULL 负例:raw SQL 与 Prisma client 都进不来无主会话(§44)", async () => {
    const raw = await ctx.prisma
      .$executeRawUnsafe(
        `INSERT INTO "Conversation" ("id","title","createdAt","updatedAt") VALUES ('b4-no-owner','x',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      )
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(String(raw)).toMatch(/NOT NULL constraint failed: Conversation\.userId/);

    // 两层防线:上面的 raw SQL 证明数据库级 NOT NULL 真的挡住了;这一层证明 Prisma client
    // 在必填关系缺失时连 SQL 都不发(§44:ConversationCreateInput 要求 owner)。
    // 编译期证据(§44,不使用 as any 绕过):这一行必须报错 —— 项目 tests 不在 typecheck 覆盖内,
    // 由一次性 `npx tsc --noEmit --strict --module nodenext --target es2022 --skipLibCheck <本文件>`
    // 复核(见实施报告)。若 userId 又变回可选,该指令会反过来报「未使用」。
    const missingOwner = await ctx.prisma.conversation
      .create({
        // @ts-expect-error §44:ConversationCreateInput 已要求 userId,漏 owner 不是合法入参
        data: { title: "no-owner" },
      })
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(String(missingOwner)).toMatch(/Argument `user` is missing/);
    expect(await ctx.prisma.conversation.findUnique({ where: { id: "b4-no-owner" } })).toBeNull();
  });

  it("B4-06 测试库最终态:列必填、FK/索引/两条触发器齐全、外键检查为空(§35/§39/§40/§41)", async () => {
    const columns = await ctx.prisma.$queryRawUnsafe<
      { name: string; notnull: bigint; dflt_value: string | null }[]
    >(`SELECT "name", "notnull", "dflt_value" FROM pragma_table_info('Conversation')`);
    const userId = columns.find((c) => c.name === "userId")!;
    expect(Number(userId.notnull)).toBe(1);
    expect(userId.dflt_value).toBeNull(); // §36:禁止数据库默认 owner

    expect(
      await ctx.prisma.$queryRawUnsafe(
        `SELECT "table", "from", "to", "on_delete", "on_update" FROM pragma_foreign_key_list('Conversation')`,
      ),
    ).toEqual([
      { table: "User", from: "userId", to: "id", on_delete: "RESTRICT", on_update: "CASCADE" },
    ]);

    const objects = await ctx.prisma.$queryRawUnsafe<{ name: string; type: string }[]>(
      `SELECT name, type FROM sqlite_master WHERE tbl_name='Conversation' AND name NOT LIKE 'sqlite_autoindex%'
         AND (type='index' OR (type='trigger' AND name='trg_active_request_blocks_conversation_status_change'))
       UNION ALL
       SELECT name, type FROM sqlite_master WHERE type='trigger' AND name='trg_active_request_requires_active_conversation'`,
    );
    expect(objects.map((o) => o.name).sort()).toEqual(
      [...INDEX_NAMES, ...TRIGGER_NAMES].sort(),
    );

    expect(
      await ctx.prisma.$queryRawUnsafe(`SELECT * FROM pragma_foreign_key_check()`),
    ).toEqual([]);

    // 显式 owner 正常写入;引用不存在的 User 仍被 FK 拒
    const created = await ctx.prisma.conversation.create({ data: { title: "ok", userId: COMPAT_USER_ID } });
    expect(created.userId).toBe(COMPAT_USER_ID);
    await expect(
      ctx.prisma.$executeRawUnsafe(`UPDATE "Conversation" SET "userId" = 'ghost' WHERE "id" = '${created.id}'`),
    ).rejects.toThrow(/FOREIGN KEY|foreign key/i);
  });
});
