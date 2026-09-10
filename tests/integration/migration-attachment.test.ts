import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isUniqueViolation, uniqueViolationInfo } from "../../src/common/utils/prisma-error.js";
import { setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

/**
 * V1.2 I1 §五:attachmentCount 迁移的不变量。
 *
 * 这条 migration 只做一件事(ADD COLUMN),所以断言的重点全在「其他一切原样不动」:
 * 状态七态 CHECK、Phase 2.1 两条 trigger、活动 Request 唯一索引都不许被顺手改掉;
 * 旧行必须自动读到 0;表结构里也根本没有能装图片字节的列 ——
 * 「字节不落库」在这里是结构事实,不是团队约定。
 */

interface Column {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestContext();
  await ctx.reset();
});

afterAll(async () => {
  await ctx.close();
});

async function columns(table: string): Promise<Column[]> {
  const rows = await ctx.prisma.$queryRawUnsafe<
    { name: string; type: string; notnull: bigint; dflt_value: string | null }[]
  >(`SELECT name, type, "notnull", dflt_value FROM pragma_table_info('${table}')`);
  return rows.map((row) => ({
    name: row.name,
    type: row.type,
    notnull: Number(row.notnull),
    dflt_value: row.dflt_value,
  }));
}

/**
 * 裸 SQL 插入一条「迁移之前那种写法」的 Request:列表里没有 attachmentCount。
 * 绕开 Prisma 默认值,才能验到 DDL 的 DEFAULT 0 真的对既有行生效。
 */
async function seedLegacyRequest(
  key: string,
): Promise<{ requestId: string; conversationId: string }> {
  const conversation = await ctx.prisma.conversation.create({ data: { title: key } });
  const user = await ctx.prisma.message.create({
    data: { conversationId: conversation.id, role: "USER", content: "u", status: "COMPLETED", position: 0 },
  });
  const assistant = await ctx.prisma.message.create({
    data: { conversationId: conversation.id, role: "ASSISTANT", content: "", status: "PENDING", position: 1 },
  });
  const requestId = `legacy-${key}`;
  await ctx.prisma.$executeRawUnsafe(
    `INSERT INTO "ModelRequest"
       ("id","conversationId","userMessageId","assistantMessageId","idempotencyKey",
        "requestFingerprint","status","provider","createdAt","updatedAt")
     VALUES ('${requestId}','${conversation.id}','${user.id}','${assistant.id}','${key}',
        'fp','PENDING','GEMINI_WEB',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
  );
  return { requestId, conversationId: conversation.id };
}

describe("attachmentCount 迁移(§五)", () => {
  it("ATT-MG-01 新列存在且为 INTEGER NOT NULL DEFAULT 0", async () => {
    const column = (await columns("ModelRequest")).find((c) => c.name === "attachmentCount");
    expect(column).toEqual({
      name: "attachmentCount",
      type: "INTEGER",
      notnull: 1,
      dflt_value: "0",
    });
  });

  it("ATT-MG-02 状态七态 CHECK、两条 trigger、活动 Request 唯一索引全部原样保留", async () => {
    const tableSql = (
      await ctx.prisma.$queryRawUnsafe<{ sql: string }[]>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='ModelRequest'`,
      )
    )[0]!.sql;
    expect(tableSql).toContain(
      `CHECK ("status" IN ('PENDING', 'PROCESSING', 'CANCELLING', 'SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT'))`,
    );

    // 两条 trigger 分别挂在 ModelRequest 与 Conversation 上,只能按名字取
    const triggers = (
      await ctx.prisma.$queryRawUnsafe<{ name: string }[]>(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_%'`,
      )
    ).map((row) => row.name);
    expect(triggers).toContain("trg_active_request_requires_active_conversation");
    expect(triggers).toContain("trg_active_request_blocks_conversation_status_change");

    const indexes = (
      await ctx.prisma.$queryRawUnsafe<{ name: string }[]>(
        `SELECT name FROM sqlite_master WHERE tbl_name='ModelRequest' AND type='index'`,
      )
    ).map((row) => row.name);
    expect(indexes).toContain("uk_active_request_per_conversation");
  });

  it("ATT-MG-03 不带该列的旧式插入自动读到 0,可空列仍为 NULL", async () => {
    const { requestId } = await seedLegacyRequest("mg-03");
    const row = await ctx.prisma.modelRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(row.attachmentCount).toBe(0);
    expect(row.requestedModelKey).toBeNull();
  });

  it("ATT-MG-04 表里没有 BLOB 列,也没有任何能放附件内容的列", async () => {
    const all = await columns("ModelRequest");
    expect(all.map((c) => c.type).filter((t) => t.toUpperCase() === "BLOB")).toEqual([]);
    expect(all.map((c) => c.name).filter((n) => /byte|blob|payload|image|data/i.test(n))).toEqual(
      [],
    );
  });

  it("ATT-MG-05 活动 Request 唯一索引仍然生效:同会话第二条活动行被数据库拒", async () => {
    const { conversationId } = await seedLegacyRequest("mg-05");
    const messages = await ctx.prisma.message.findMany({ where: { conversationId } });
    const err = await ctx.prisma.modelRequest
      .create({
        data: {
          conversationId,
          userMessageId: messages.find((m) => m.role === "USER")!.id,
          assistantMessageId: messages.find((m) => m.role === "ASSISTANT")!.id,
          idempotencyKey: "mg-05-second",
          requestFingerprint: "fp",
          status: "PENDING",
          // 新列可正常写入,但不能绕过活动态唯一索引
          attachmentCount: 2,
        },
      })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(isUniqueViolation(err)).toBe(true);
    // adapter 只报列名:ModelRequest 上单列 conversationId 的唯一约束只有那条活动态部分索引
    expect(uniqueViolationInfo(err).fields).toEqual(["conversationId"]);
    expect(
      await ctx.prisma.modelRequest.count({
        where: { conversationId, status: { in: ["PENDING", "PROCESSING", "CANCELLING"] } },
      }),
    ).toBe(1);
  });

  it("ATT-MG-06 attachmentCount 可正常读写,status 七态 CHECK 仍然拦非法态", async () => {
    const { requestId } = await seedLegacyRequest("mg-06");
    await ctx.prisma.modelRequest.update({
      where: { id: requestId },
      data: { attachmentCount: 4 },
    });
    expect(
      (await ctx.prisma.modelRequest.findUniqueOrThrow({ where: { id: requestId } })).attachmentCount,
    ).toBe(4);

    await expect(
      ctx.prisma.modelRequest.update({ where: { id: requestId }, data: { status: "RETRYING" } }),
    ).rejects.toThrow(/constraint failed/i);
    expect(
      (await ctx.prisma.modelRequest.findUniqueOrThrow({ where: { id: requestId } })).status,
    ).toBe("PENDING");
  });
});
