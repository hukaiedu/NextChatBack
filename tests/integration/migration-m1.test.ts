import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

interface TableColumn {
  name: string;
  notnull: number;
}

interface DbObject {
  name: string;
  type: string;
}

/**
 * M1 迁移不变量(migration.sql 只做 ADD COLUMN):
 * - 新增 4 列存在且可空(旧数据保持 NULL,无回填)
 * - Phase 2.1 触发器、Conversation.providerConversationUrl 唯一索引未被破坏
 * - Prisma 层写入旧行为不变:不传模型字段 → 列为 NULL
 */
describe("M1 migration: 模型选择字段", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function tableColumns(table: string): Promise<TableColumn[]> {
    const rows = await ctx.prisma.$queryRawUnsafe<{ name: string; notnull: bigint }[]>(
      `SELECT name, "notnull" FROM pragma_table_info('${table}')`,
    );
    return rows.map((row) => ({ name: row.name, notnull: Number(row.notnull) }));
  }

  it("新增列存在且均可空", async () => {
    const conversation = (await tableColumns("Conversation")).find((c) => c.name === "preferredModelKey");
    expect(conversation).toMatchObject({ notnull: 0 });

    const request = await tableColumns("ModelRequest");
    for (const name of ["requestedModelKey", "resolvedModelKey", "resolvedModelLabel"]) {
      expect(request.find((c) => c.name === name)).toMatchObject({ notnull: 0 });
    }
  });

  it("Phase 2.1 触发器与 provider 会话 URL 唯一索引仍存在", async () => {
    const objects = await ctx.prisma.$queryRawUnsafe<DbObject[]>(
      `SELECT name, type FROM sqlite_master WHERE name LIKE 'trg_%' OR name LIKE 'Conversation_provider%'`,
    );

    expect(objects).toContainEqual({ name: "trg_active_request_requires_active_conversation", type: "trigger" });
    expect(objects).toContainEqual({ name: "trg_active_request_blocks_conversation_status_change", type: "trigger" });
    expect(objects).toContainEqual({ name: "Conversation_providerConversationUrl_key", type: "index" });
  });

  it("不传模型字段创建的 Conversation / ModelRequest 列保持 NULL(旧行为兼容)", async () => {
    const conversation = await ctx.prisma.conversation.create({ data: { title: "migration-it" } });
    const user = await ctx.prisma.message.create({
      data: { conversationId: conversation.id, role: "USER", content: "u", status: "COMPLETED", position: 0 },
    });
    const assistant = await ctx.prisma.message.create({
      data: { conversationId: conversation.id, role: "ASSISTANT", content: "a", status: "PENDING", position: 1 },
    });
    await ctx.prisma.modelRequest.create({
      data: {
        conversationId: conversation.id,
        userMessageId: user.id,
        assistantMessageId: assistant.id,
        idempotencyKey: "migration-it-key",
        requestFingerprint: "fingerprint",
        status: "PENDING",
      },
    });

    const reloaded = await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    const requests = await ctx.prisma.modelRequest.findMany({ where: { conversationId: conversation.id } });
    expect(reloaded.preferredModelKey).toBeNull();
    expect(requests[0]?.requestedModelKey).toBeNull();
    expect(requests[0]?.resolvedModelKey).toBeNull();
    expect(requests[0]?.resolvedModelLabel).toBeNull();
  });

  it("preferredModelKey 更新不触发状态变更触发器(UPDATE OF status 列级触发)", async () => {
    const conversation = await ctx.prisma.conversation.create({
      data: { title: "trigger-it", preferredModelKey: "model-a" },
    });
    // 同会话存在活跃 Request,验证仅改 preferredModelKey 仍可成功(状态触发器不拦)
    const user = await ctx.prisma.message.create({
      data: { conversationId: conversation.id, role: "USER", content: "u", status: "COMPLETED", position: 0 },
    });
    const assistant = await ctx.prisma.message.create({
      data: { conversationId: conversation.id, role: "ASSISTANT", content: "a", status: "PENDING", position: 1 },
    });
    await ctx.prisma.modelRequest.create({
      data: {
        conversationId: conversation.id,
        userMessageId: user.id,
        assistantMessageId: assistant.id,
        idempotencyKey: "trigger-it-key",
        requestFingerprint: "fingerprint",
        status: "PENDING",
      },
    });

    const updated = await ctx.prisma.conversation.update({
      where: { id: conversation.id },
      data: { preferredModelKey: "model-b" },
    });
    expect(updated.preferredModelKey).toBe("model-b");
    expect(updated.status).toBe("ACTIVE");
  });
});
