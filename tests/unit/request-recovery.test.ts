import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

const STALE_URL = "https://gemini.google.com/app/1111222233334444";

interface Seeded {
  conversationId: string;
  requestId: string;
  userMessageId: string;
  assistantMessageId: string;
}

/**
 * 服务启动恢复(prd §12.1)。
 * 每个请求都自带一个 Conversation,避免 providerConversationUrl 的 @unique 相互干扰。
 */
describe("RequestRecovery(重启后遗留 PROCESSING 的处置)", () => {
  let ctx: TestContext;
  let sequence = 0;

  beforeEach(async () => {
    ctx = await setupTestContext({ scheduler: { autoStart: false } });
    await ctx.reset();
  });

  afterEach(async () => {
    await ctx.close();
  });

  /** 造一条指定状态的 Request(assistant 状态按 §11.4 映射摆好) */
  async function seed(
    status: "PENDING" | "PROCESSING" | "SUCCESS",
    options: { url?: string } = {},
  ): Promise<Seeded> {
    sequence++;
    const assistantStatus =
      status === "PROCESSING" ? "STREAMING" : status === "SUCCESS" ? "COMPLETED" : "PENDING";
    const conversation = await ctx.prisma.conversation.create({
      data: {
        title: `conv-${sequence}`,
        status: "ACTIVE",
        provider: "GEMINI_WEB",
        ...(options.url ? { providerConversationUrl: options.url } : {}),
      },
    });
    const userMessage = await ctx.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "USER",
        content: "重启前的问题",
        status: "COMPLETED",
        position: 1,
      },
    });
    const assistantMessage = await ctx.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "ASSISTANT",
        content: assistantStatus === "COMPLETED" ? "重启前的回答" : "",
        status: assistantStatus,
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
        status,
        provider: "GEMINI_WEB",
        ...(status === "PROCESSING" || status === "SUCCESS"
          ? { attemptCount: 1, startedAt: new Date() }
          : {}),
        ...(status === "SUCCESS" ? { completedAt: new Date() } : {}),
      },
    });
    return {
      conversationId: conversation.id,
      requestId: request.id,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
    };
  }

  it("PROCESSING → FAILED(SERVER_RESTARTED_DURING_PROCESSING),Assistant STREAMING → FAILED,数据全保留", async () => {
    const stale = await seed("PROCESSING", { url: STALE_URL });

    const report = await ctx.recovery.run();
    expect(report.processingFailed).toBe(1);

    const request = await ctx.prisma.modelRequest.findUniqueOrThrow({
      where: { id: stale.requestId },
    });
    expect(request.status).toBe("FAILED");
    expect(request.errorCode).toBe(ErrorCodes.SERVER_RESTARTED_DURING_PROCESSING);
    expect(request.errorMessage).toBeTruthy();
    expect(request.completedAt).not.toBeNull();
    // 禁止自动重发:不重新排队,attemptCount 停在重启前的值
    expect(request.attemptCount).toBe(1);

    const assistant = await ctx.prisma.message.findUniqueOrThrow({
      where: { id: stale.assistantMessageId },
    });
    expect(assistant.status).toBe("FAILED");
    expect(assistant.content).toBe("");

    // §12.1 保留清单:User Message / Assistant Message / Request / Provider Conversation URL
    const user = await ctx.prisma.message.findUniqueOrThrow({
      where: { id: stale.userMessageId },
    });
    expect(user).toMatchObject({ role: "USER", status: "COMPLETED", content: "重启前的问题" });
    const conversation = await ctx.prisma.conversation.findUniqueOrThrow({
      where: { id: stale.conversationId },
    });
    expect(conversation.providerConversationUrl).toBe(STALE_URL);
  });

  it("PENDING 不被恢复逻辑改动,之后仍可被 Scheduler 正常执行(§12.1 允许自动恢复)", async () => {
    const waiting = await seed("PENDING");

    const report = await ctx.recovery.run();
    expect(report.processingFailed).toBe(0);

    const afterRecovery = await ctx.prisma.modelRequest.findUniqueOrThrow({
      where: { id: waiting.requestId },
    });
    expect(afterRecovery.status).toBe("PENDING");
    expect(afterRecovery.attemptCount).toBe(0);
    expect(afterRecovery.startedAt).toBeNull();

    // 启动扫描重新入队并执行
    await ctx.scheduler!.runOnce();

    const executed = await ctx.prisma.modelRequest.findUniqueOrThrow({
      where: { id: waiting.requestId },
    });
    expect(executed.status).toBe("SUCCESS");
    expect(executed.attemptCount).toBe(1);
    const assistant = await ctx.prisma.message.findUniqueOrThrow({
      where: { id: waiting.assistantMessageId },
    });
    expect(assistant).toMatchObject({ status: "COMPLETED" });
  });

  it("混合状态一次启动:只有 PROCESSING 被判失败;重复执行幂等,终态行不受影响", async () => {
    const stale = await seed("PROCESSING");
    const waiting = await seed("PENDING");
    const done = await seed("SUCCESS", { url: STALE_URL.replace("11112222", "aaaabbbb") });

    await ctx.recovery.run();

    const staleAfter = await ctx.prisma.modelRequest.findUnique({ where: { id: stale.requestId } });
    const waitingAfter = await ctx.prisma.modelRequest.findUnique({
      where: { id: waiting.requestId },
    });
    const doneAfter = await ctx.prisma.modelRequest.findUnique({ where: { id: done.requestId } });
    expect(staleAfter?.status).toBe("FAILED");
    expect(waitingAfter?.status).toBe("PENDING");
    expect(doneAfter).toMatchObject({ status: "SUCCESS", errorCode: null });

    // 再来一次(模拟重启两次):不重复计数、不改动任何行
    const secondRun = await ctx.recovery.run();
    expect(secondRun.processingFailed).toBe(0);
    expect(await ctx.prisma.modelRequest.count()).toBe(3);
    expect(await ctx.prisma.message.count()).toBe(6);
  });
});
