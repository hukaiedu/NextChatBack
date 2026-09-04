import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { ConversationRepository } from "../../src/modules/conversation/conversation.repository.js";
import { MessageRepository } from "../../src/modules/message/message.repository.js";
import { RequestRepository } from "../../src/modules/request/request.repository.js";
import { RequestService } from "../../src/modules/request/request.service.js";
import { setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

interface Seeded {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  requestId: string;
}

describe("RequestService 状态流转(§11.4 状态同步唯一入口)", () => {
  let ctx: TestContext;
  let service: RequestService;
  let sequence = 0;

  beforeEach(async () => {
    ctx = await setupTestContext();
    await ctx.reset();
    service = new RequestService(
      ctx.prisma,
      new RequestRepository(),
      new MessageRepository(),
      new ConversationRepository(),
    );
  });

  afterEach(async () => {
    await ctx.close();
  });

  async function seed(): Promise<Seeded> {
    sequence++;
    const conversation = await ctx.prisma.conversation.create({
      data: { title: `conv-${sequence}`, status: "ACTIVE", provider: "GEMINI_WEB" },
    });
    const userMessage = await ctx.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "USER",
        content: "第一问",
        status: "COMPLETED",
        position: 1,
      },
    });
    const assistantMessage = await ctx.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "ASSISTANT",
        content: "",
        status: "PENDING",
        position: 2,
      },
    });
    const request = await ctx.prisma.modelRequest.create({
      data: {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        idempotencyKey: randomUUID(),
        requestFingerprint: randomUUID(),
        status: "PENDING",
        provider: "GEMINI_WEB",
      },
    });
    return {
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      requestId: request.id,
    };
  }

  it("claim:PENDING → PROCESSING,startedAt/attemptCount 就位,assistant 同步 STREAMING", async () => {
    const seeded = await seed();

    await expect(service.claim(seeded.requestId)).resolves.toBe(true);

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    const assistant = await ctx.prisma.message.findUnique({ where: { id: seeded.assistantMessageId } });
    expect(request?.status).toBe("PROCESSING");
    expect(request?.startedAt).not.toBeNull();
    expect(request?.attemptCount).toBe(1);
    expect(request?.completedAt).toBeNull();
    expect(assistant?.status).toBe("STREAMING");
  });

  it("claim 二次认领返回 false,状态不被重复推进", async () => {
    const seeded = await seed();
    await expect(service.claim(seeded.requestId)).resolves.toBe(true);

    await expect(service.claim(seeded.requestId)).resolves.toBe(false);

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    expect(request?.status).toBe("PROCESSING");
    expect(request?.attemptCount).toBe(1);
  });

  it("claim 不存在的 Request 返回 false", async () => {
    await expect(service.claim("no-such-request")).resolves.toBe(false);
  });

  it("complete:SUCCESS + assistant 回填 COMPLETED + 会话时间戳刷新(§12.10 一个事务)", async () => {
    const seeded = await seed();
    await service.claim(seeded.requestId);
    const beforeConversation = await ctx.prisma.conversation.findUnique({
      where: { id: seeded.conversationId },
    });
    await new Promise((resolve) => setTimeout(resolve, 15));

    await service.complete(seeded.requestId, "最终回答");

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    const assistant = await ctx.prisma.message.findUnique({ where: { id: seeded.assistantMessageId } });
    const conversation = await ctx.prisma.conversation.findUnique({
      where: { id: seeded.conversationId },
    });
    expect(request?.status).toBe("SUCCESS");
    expect(request?.completedAt).not.toBeNull();
    expect(request?.errorCode).toBeNull();
    expect(assistant?.status).toBe("COMPLETED");
    expect(assistant?.content).toBe("最终回答");
    expect(conversation!.updatedAt.getTime()).toBeGreaterThanOrEqual(
      beforeConversation!.updatedAt.getTime(),
    );
  });

  it("fail(FAILED):error_code/error_message/completedAt 落库,assistant FAILED(§12.11)", async () => {
    const seeded = await seed();
    await service.claim(seeded.requestId);

    await service.fail(seeded.requestId, "FAILED", ErrorCodes.PROVIDER_DOM_CHANGED, "composer is missing");

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    const assistant = await ctx.prisma.message.findUnique({ where: { id: seeded.assistantMessageId } });
    const user = await ctx.prisma.message.findUnique({ where: { id: seeded.userMessageId } });
    expect(request?.status).toBe("FAILED");
    expect(request?.errorCode).toBe(ErrorCodes.PROVIDER_DOM_CHANGED);
    expect(request?.errorMessage).toBe("composer is missing");
    expect(request?.completedAt).not.toBeNull();
    expect(assistant?.status).toBe("FAILED");
    expect(assistant?.content).toBe("");
    // §12.11:User Message 保留
    expect(user?.status).toBe("COMPLETED");
    expect(user?.content).toBe("第一问");
  });

  it("fail(TIMEOUT):Request TIMEOUT,assistant 仍映射 FAILED(§11.4)", async () => {
    const seeded = await seed();
    await service.claim(seeded.requestId);

    await service.fail(
      seeded.requestId,
      "TIMEOUT",
      ErrorCodes.PROVIDER_RESPONSE_TIMEOUT,
      "Gemini answer did not settle within 300000ms",
    );

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    const assistant = await ctx.prisma.message.findUnique({ where: { id: seeded.assistantMessageId } });
    expect(request?.status).toBe("TIMEOUT");
    expect(request?.errorCode).toBe(ErrorCodes.PROVIDER_RESPONSE_TIMEOUT);
    expect(assistant?.status).toBe("FAILED");
  });

  it("边沿守卫:未认领就 complete → INTERNAL_ERROR 且状态不变", async () => {
    const seeded = await seed();

    await expect(service.complete(seeded.requestId, "x")).rejects.toMatchObject({
      code: ErrorCodes.INTERNAL_ERROR,
    });

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    expect(request?.status).toBe("PENDING");
  });

  it("事务失败回滚:complete 抛错后无半提交状态,随后仍可正常 fail 收尾", async () => {
    const seeded = await seed();
    await service.claim(seeded.requestId);

    // $transaction 强制失败的 Prisma 代理(其余能力沿原型链可用)
    const failingPrisma = Object.create(ctx.prisma) as PrismaClient;
    Object.defineProperty(failingPrisma, "$transaction", {
      value: async () => {
        throw new Error("forced transaction failure");
      },
    });
    const broken = new RequestService(
      failingPrisma,
      new RequestRepository(),
      new MessageRepository(),
      new ConversationRepository(),
    );

    await expect(broken.complete(seeded.requestId, "不该落库的内容")).rejects.toThrow(
      "forced transaction failure",
    );

    // 无半提交:assistant 内容与状态都保持执行中快照
    const assistant = await ctx.prisma.message.findUnique({ where: { id: seeded.assistantMessageId } });
    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    expect(assistant?.content).toBe("");
    expect(assistant?.status).toBe("STREAMING");
    expect(request?.status).toBe("PROCESSING");

    await service.fail(seeded.requestId, "FAILED", ErrorCodes.DATABASE_ERROR, "tx failed");
    const recovered = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    expect(recovered?.status).toBe("FAILED");
    expect(recovered?.errorCode).toBe(ErrorCodes.DATABASE_ERROR);
  });

  it("AppError 语义守卫:getById 不存在 → 404 REQUEST_NOT_FOUND", async () => {
    await expect(service.getById("no-such-request")).rejects.toMatchObject({
      code: ErrorCodes.REQUEST_NOT_FOUND,
      statusCode: 404,
    });
  });
});
