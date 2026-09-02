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
    const body = (await res.json()) as {
      data: {
        id: string;
        status: string;
        idempotencyKey: string;
        conversationId: string;
        provider: string;
        attemptCount: number;
        errorCode: string | null;
        errorMessage: string | null;
        userMessageId: string;
        assistantMessageId: string;
      };
    };

    expect(body.data).toMatchObject({
      id: requestId,
      status: "PENDING",
      idempotencyKey: "req-key-1",
      conversationId: conv.id,
      provider: "GEMINI_WEB",
      attemptCount: 0,
      errorCode: null,
      errorMessage: null,
    });
    expect(body.data.userMessageId).toBeTruthy();
    expect(body.data.assistantMessageId).toBeTruthy();
  });

  it("GET /api/requests/:id 不存在 → 404 REQUEST_NOT_FOUND", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/requests/no-such-request`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "REQUEST_NOT_FOUND",
    );
  });
});
