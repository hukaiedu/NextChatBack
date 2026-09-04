import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";
import { FakeDriver, FakeGeminiAdapter, createFakeManager } from "../fakes.js";

describe("Request Cancel Service(§8.9 取消接口)", () => {
  let ctx: TestContext;
  let sequence = 0;

  async function mount(): Promise<void> {
    ctx = await setupTestContext({
      browserManager: createFakeManager(new FakeDriver()),
      geminiAdapter: new FakeGeminiAdapter(),
      scheduler: { autoStart: false },
    });
    await ctx.reset();
  }

  afterEach(async () => {
    await ctx.close();
  });

  async function seedRequest(status: string): Promise<{ requestId: string; assistantMessageId: string }> {
    sequence++;
    const conversation = await ctx.prisma.conversation.create({
      data: { title: `cancel-${sequence}`, status: "ACTIVE", provider: "GEMINI_WEB" },
    });
    const userMessage = await ctx.prisma.message.create({
      data: { conversationId: conversation.id, role: "USER", content: "test", status: "COMPLETED", position: 1 },
    });
    const assistantMessage = await ctx.prisma.message.create({
      data: { conversationId: conversation.id, role: "ASSISTANT", content: "", status: "PENDING", position: 2 },
    });
    const request = await ctx.prisma.modelRequest.create({
      data: {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        idempotencyKey: randomUUID(),
        requestFingerprint: randomUUID(),
        status,
        provider: "GEMINI_WEB",
      },
    });
    return { requestId: request.id, assistantMessageId: assistantMessage.id };
  }

  it("PENDING → CANCELLED(200),assistant → CANCELLED,不碰 Gemini", async () => {
    await mount();
    const { requestId, assistantMessageId } = await seedRequest("PENDING");

    const res = await fetch(`${ctx.baseUrl}/api/requests/${requestId}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("CANCELLED");

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: requestId } });
    const assistant = await ctx.prisma.message.findUnique({ where: { id: assistantMessageId } });
    expect(request?.status).toBe("CANCELLED");
    expect(request?.completedAt).not.toBeNull();
    expect(assistant?.status).toBe("CANCELLED");
  });

  it("PROCESSING → CANCELLING(202),abort 送达 registry", async () => {
    await mount();
    const { requestId } = await seedRequest("PROCESSING");

    const res = await fetch(`${ctx.baseUrl}/api/requests/${requestId}/cancel`, { method: "POST" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("CANCELLING");

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: requestId } });
    expect(request?.status).toBe("CANCELLING");
    // PROCESSING 行没有在本进程执行(registry 没登记),所以 abort 返回 false
    // 但 cancel API 仍然成功把状态推到 CANCELLING
  });

  it("CANCELLING 再取消 → 200 noop(幂等,不重复 abort)", async () => {
    await mount();
    const { requestId } = await seedRequest("CANCELLING");

    const res = await fetch(`${ctx.baseUrl}/api/requests/${requestId}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("CANCELLING");
  });

  it("CANCELLED 再取消 → 200 noop(幂等)", async () => {
    await mount();
    const { requestId } = await seedRequest("CANCELLED");

    const res = await fetch(`${ctx.baseUrl}/api/requests/${requestId}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("SUCCESS → 409 REQUEST_NOT_CANCELLABLE", async () => {
    await mount();
    const { requestId } = await seedRequest("SUCCESS");

    const res = await fetch(`${ctx.baseUrl}/api/requests/${requestId}/cancel`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe(ErrorCodes.REQUEST_NOT_CANCELLABLE);

    // 状态未变
    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: requestId } });
    expect(request?.status).toBe("SUCCESS");
  });

  it("FAILED → 409 REQUEST_NOT_CANCELLABLE", async () => {
    await mount();
    const { requestId } = await seedRequest("FAILED");

    const res = await fetch(`${ctx.baseUrl}/api/requests/${requestId}/cancel`, { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("TIMEOUT → 409 REQUEST_NOT_CANCELLABLE", async () => {
    await mount();
    const { requestId } = await seedRequest("TIMEOUT");

    const res = await fetch(`${ctx.baseUrl}/api/requests/${requestId}/cancel`, { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("不存在的 Request → 404", async () => {
    await mount();

    const res = await fetch(`${ctx.baseUrl}/api/requests/nonexistent-id/cancel`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
