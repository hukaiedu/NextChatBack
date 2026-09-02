import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createConversation, sendMessage, setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

const ACTIVE_STATUSES = ["PENDING", "PROCESSING", "CANCELLING"];

/**
 * Phase 2.1 并发不变量:
 *   - 只有 ACTIVE Conversation 才能产生活动 ModelRequest
 *   - 存在活动 ModelRequest 时不能 ARCHIVE / DELETE Conversation
 *
 * 保护层:数据库 Trigger(写语句原子串行,检查最新已提交状态),
 * 应用层把 trigger abort 映射回业务错误。
 */
describe("Send Message ↔ Archive/Delete 并发一致性", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestContext();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx.close();
  });

  /** 数据库终态合法性:不允许出现任何"半成品组合" */
  async function assertLegalState(conversationId: string): Promise<void> {
    const conversation = await ctx.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    const activeCount = await ctx.prisma.modelRequest.count({
      where: { conversationId, status: { in: ACTIVE_STATUSES } },
    });
    const messageCount = await ctx.prisma.message.count({ where: { conversationId } });
    const requestCount = await ctx.prisma.modelRequest.count({ where: { conversationId } });

    // 消息与 Request 成对:要么都创建(2 消息 1 Request),要么都没创建(0/0)
    expect(messageCount).toBe(requestCount * 2);

    // 不变量:非 ACTIVE 会话不允许存在活动 Request
    if (conversation.status !== "ACTIVE") {
      expect(activeCount).toBe(0);
      expect(requestCount).toBe(0);
    }
    // send 成功(1 Request)则会话必须仍为 ACTIVE
    if (requestCount === 1) {
      expect(conversation.status).toBe("ACTIVE");
    }
  }

  it("并发 Send + Archive:一个成功一个被拒,数据库始终合法", async () => {
    for (let round = 0; round < 6; round++) {
      await ctx.reset();
      const conv = await createConversation(ctx.baseUrl);

      const [sendRes, archiveRes] = await Promise.all([
        sendMessage(ctx.baseUrl, conv.id, "并发问题", `send-arch-${round}`),
        fetch(`${ctx.baseUrl}/api/conversations/${conv.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "ARCHIVED" }),
        }),
      ]);

      const combo = [sendRes.status, archiveRes.status] as const;
      const legal =
        (combo[0] === 202 && combo[1] === 409) || // Send 先赢,Archive 被拒
        (combo[0] === 409 && combo[1] === 200); // Archive 先赢,Send 被拒
      expect(legal, `round ${round}: illegal combo ${JSON.stringify(combo)}`).toBe(true);

      await assertLegalState(conv.id);
    }
  });

  it("并发 Send + Delete:一个成功一个被拒,数据库始终合法", async () => {
    for (let round = 0; round < 6; round++) {
      await ctx.reset();
      const conv = await createConversation(ctx.baseUrl);

      const [sendRes, deleteRes] = await Promise.all([
        sendMessage(ctx.baseUrl, conv.id, "并发问题", `send-del-${round}`),
        fetch(`${ctx.baseUrl}/api/conversations/${conv.id}`, { method: "DELETE" }),
      ]);

      const combo = [sendRes.status, deleteRes.status] as const;
      const legal =
        (combo[0] === 202 && combo[1] === 409) || // Send 先赢,Delete 被拒
        (combo[0] === 409 && combo[1] === 204); // Delete 先赢,Send 被拒
      expect(legal, `round ${round}: illegal combo ${JSON.stringify(combo)}`).toBe(true);

      await assertLegalState(conv.id);
    }
  });
});
