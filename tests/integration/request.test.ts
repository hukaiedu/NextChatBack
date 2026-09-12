import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createConversation, sendMessage, setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

describe("Request API", () => {
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

  it("GET /api/requests/:id 返回数据库当前状态", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const sent = await sendMessage(ctx.baseUrl, conv.id, "你好", "req-key-1");
    const sentBody = (await sent.json()) as {
      data: { request: { id: string } };
    };
    const requestId = sentBody.data.request.id;

    const res = await fetch(`${ctx.baseUrl}/api/requests/${requestId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(body.data).toMatchObject({
      id: requestId,
      status: "PENDING",
      conversationId: conv.id,
      errorCode: null,
      errorMessage: null,
      attachmentCount: 0,
    });
    expect(body.data.userMessageId).toBeTruthy();
    expect(body.data.assistantMessageId).toBeTruthy();
    // §9/§11(B3-2):幂等键 / 指纹 / 重试次数 / provider / 模型快照都属内部字段
    expect(Object.keys(body.data).sort()).toEqual(
      [
        "id",
        "conversationId",
        "userMessageId",
        "assistantMessageId",
        "status",
        "errorCode",
        "errorMessage",
        "attachmentCount",
        "createdAt",
        "updatedAt",
      ].sort(),
    );

    // 内部真值仍完整落库:收口只删对外可见面,不删证据(§18)
    const row = await ctx.prisma.modelRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(row.idempotencyKey).toBe("req-key-1");
    expect(row.provider).toBe("GEMINI_WEB");
    expect(row.attemptCount).toBe(0);
  });

  it("GET /api/requests/:id 不存在 → 404 REQUEST_NOT_FOUND", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/requests/no-such-request`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "REQUEST_NOT_FOUND",
    );
  });
});
