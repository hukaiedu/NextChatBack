import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

describe("统一错误处理", () => {
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

  it("非法 JSON body 返回 400 VALIDATION_ERROR", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("错误响应 requestId 与 x-request-id 响应头一致", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/conversations/nonexistent`);
    expect(res.status).toBe(404);

    const headerRequestId = res.headers.get("x-request-id");
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    expect(headerRequestId).toBeTruthy();
    expect(body.error.requestId).toBe(headerRequestId);
  });

  it("50001 字符消息返回 400 VALIDATION_ERROR 且带 requestId", async () => {
    const created = await fetch(`${ctx.baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const conversation = (await created.json()) as { data: { id: string } };

    const res = await fetch(
      `${ctx.baseUrl}/api/conversations/${conversation.data.id}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "err-key-1",
        },
        body: JSON.stringify({ content: "a".repeat(50001) }),
      },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.requestId).toBe(res.headers.get("x-request-id"));
  });
});
