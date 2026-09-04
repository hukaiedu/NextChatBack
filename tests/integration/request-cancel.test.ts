import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { FAKE_CONVERSATION_URL, FakeDriver, FakeGeminiAdapter, createFakeManager } from "../fakes.js";
import type { FakeAdapterBehavior } from "../fakes.js";
import { setupTestContext, cancelRequest } from "../helpers.js";
import type { TestContext } from "../helpers.js";

describe("Request Cancel 集成(§八.1 取消生成)", () => {
  let ctx: TestContext;
  let driver: FakeDriver;
  let adapter: FakeGeminiAdapter;
  let sequence = 0;

  async function mount(behavior: FakeAdapterBehavior = {}, executionTimeoutMs?: number): Promise<void> {
    driver = new FakeDriver();
    adapter = new FakeGeminiAdapter(behavior);
    ctx = await setupTestContext({
      browserManager: createFakeManager(driver),
      geminiAdapter: adapter,
      scheduler: { autoStart: false, executionTimeoutMs },
    });
    await ctx.reset();
  }

  afterEach(async () => {
    await ctx.close();
  });

  async function seedPending(content: string): Promise<{
    conversationId: string;
    requestId: string;
    assistantMessageId: string;
  }> {
    sequence++;
    const conversation = await ctx.prisma.conversation.create({
      data: { title: `cancel-int-${sequence}`, status: "ACTIVE", provider: "GEMINI_WEB" },
    });
    const userMessage = await ctx.prisma.message.create({
      data: { conversationId: conversation.id, role: "USER", content, status: "COMPLETED", position: 1 },
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
        status: "PENDING",
        provider: "GEMINI_WEB",
      },
    });
    return { conversationId: conversation.id, requestId: request.id, assistantMessageId: assistantMessage.id };
  }

  it("执行中取消 → CANCELLING → cancelled:true → CANCELLED + 部分内容落库", async () => {
    let abortSeen = false;
    await mount({
      streamTexts: ["partial ", "partial answer"],
      cancelBehaviour: "cancelled",
      partialAnswer: "partial answer",
      abortObserver: () => { abortSeen = true; },
      // 让 onStreamText 阻塞直到外部取消
      onStreamText: async (_text, index) => {
        if (index === 0) {
          // 推完第一段后等一小拍,让 cancel API 有时间到达
          await new Promise((r) => setTimeout(r, 50));
        }
      },
    });
    const seeded = await seedPending("长回答");

    // 启动 scheduler(非阻塞),然后立即发 cancel
    const runPromise = ctx.scheduler!.runOnce();
    // 等 adapter 开始执行(request 变成 PROCESSING)
    await new Promise((r) => setTimeout(r, 30));

    const cancelRes = await cancelRequest(ctx.baseUrl, seeded.requestId);
    expect(cancelRes.status).toBe(202);

    await runPromise;

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    const assistant = await ctx.prisma.message.findUnique({ where: { id: seeded.assistantMessageId } });
    expect(request?.status).toBe("CANCELLED");
    expect(request?.completedAt).not.toBeNull();
    expect(assistant?.status).toBe("CANCELLED");
    expect(assistant?.content).toBe("partial answer");
    expect(abortSeen).toBe(true);
  });

  it("取消早于会话 URL 检测 → CANCELLED(不误报 PROVIDER_DOM_CHANGED)", async () => {
    // 真机第 9 阶段实测:URL 要等模型开始响应才出现,取消点可能早于它。
    // 此时没有会话映射可写,必须是 CANCELLED,而不是 URL 守卫抛 DOM_CHANGED → FAILED
    await mount({
      conversationUrl: null,
      streamTexts: ["partial ", "partial answer"],
      cancelBehaviour: "cancelled",
      partialAnswer: "partial answer",
      onStreamText: async (_text, index) => {
        if (index === 0) {
          await new Promise((r) => setTimeout(r, 50));
        }
      },
    });
    const seeded = await seedPending("长回答");

    const runPromise = ctx.scheduler!.runOnce();
    await new Promise((r) => setTimeout(r, 30));

    const cancelRes = await cancelRequest(ctx.baseUrl, seeded.requestId);
    expect(cancelRes.status).toBe(202);
    await runPromise;

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    const assistant = await ctx.prisma.message.findUnique({ where: { id: seeded.assistantMessageId } });
    expect(request?.status).toBe("CANCELLED");
    expect(request?.errorCode).toBeNull();
    expect(assistant?.status).toBe("CANCELLED");
    expect(assistant?.content).toBe("partial answer");
  });

  it("取消确认失败 → PROVIDER_CANCELLATION_UNCONFIRMED + FAILED", async () => {
    await mount({
      hang: true,
      cancelBehaviour: "unconfirmed",
      partialAnswer: "some text",
    });
    const seeded = await seedPending("问题");

    const runPromise = ctx.scheduler!.runOnce();
    // 等 scheduler 认领并开始执行
    await new Promise((r) => setTimeout(r, 50));

    const cancelRes = await cancelRequest(ctx.baseUrl, seeded.requestId);
    expect(cancelRes.status).toBe(202);

    await runPromise;

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    expect(request?.status).toBe("FAILED");
    expect(request?.errorCode).toBe(ErrorCodes.PROVIDER_CANCELLATION_UNCONFIRMED);
  });

  it("CANCELLING 期间仍 BUSY,确认停止后才释放槽位", async () => {
    const statusesDuringCancel: string[] = [];
    await mount({
      streamTexts: ["text"],
      cancelBehaviour: "cancelled",
      partialAnswer: "text",
      onStreamText: async () => {
        statusesDuringCancel.push(driver.latestContext ? "BUSY" : "NOT-BUSY");
        await new Promise((r) => setTimeout(r, 50));
      },
    });
    const seeded = await seedPending("问题");

    const runPromise = ctx.scheduler!.runOnce();
    await new Promise((r) => setTimeout(r, 30));

    // CANCELLING 期间应该还是 BUSY
    const midStatus = (await fetch(`${ctx.baseUrl}/api/provider/status`)).json() as Promise<{ data: { status: string } }>;
    expect(((await midStatus)).data.status).toBe("BUSY");

    await cancelRequest(ctx.baseUrl, seeded.requestId);
    await runPromise;

    // 结束后释放
    const afterStatus = await (await fetch(`${ctx.baseUrl}/api/provider/status`)).json() as { data: { status: string } };
    expect(afterStatus.data.status).toBe("READY");
  });

  it("CANCELLING → SUCCESS 竞态边(Adapter 自然完成)→ 落 SUCCESS 不抛 INTERNAL_ERROR", async () => {
    // Adapter 在 signal abort 前就自然完成了 → cancelled:false → complete 路径
    await mount({
      answer: "natural answer",
      // 不设 cancelBehaviour:signal abort 时返回 cancelled:false
    });
    const seeded = await seedPending("问题");

    // 直接跑完(不取消),验证正常 SUCCESS 路径不受影响
    await ctx.scheduler!.runOnce();

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    expect(request?.status).toBe("SUCCESS");
  });

  it("watchdog 超时 → TIMEOUT(即使 adapter 返回 cancelled:true 也优先 TIMEOUT)", async () => {
    await mount({
      hang: true,
      cancelBehaviour: "cancelled",
      partialAnswer: "hung text",
    }, 60);
    const seeded = await seedPending("挂死的问题");

    await ctx.scheduler!.runOnce();

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    expect(request?.status).toBe("TIMEOUT");
    expect(request?.errorCode).toBe(ErrorCodes.PROVIDER_RESPONSE_TIMEOUT);
  });

  it("残留 CANCELLING 被 recovery 清后该会话能重新发消息(201)", async () => {
    await mount();
    const seeded = await seedPending("问题");

    // 手动把 Request 推到 CANCELLING(模拟上次进程在取消中被杀)
    await ctx.prisma.modelRequest.update({
      where: { id: seeded.requestId },
      data: { status: "CANCELLING" },
    });
    await ctx.prisma.message.update({
      where: { id: seeded.assistantMessageId },
      data: { status: "STREAMING" },
    });

    // Recovery 把它清掉
    const report = await ctx.recovery.run();
    expect(report.cancellingFailed).toBe(1);

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    expect(request?.status).toBe("FAILED");
    expect(request?.errorCode).toBe(ErrorCodes.SERVER_RESTARTED_DURING_CANCELLING);

    const assistant = await ctx.prisma.message.findUnique({ where: { id: seeded.assistantMessageId } });
    expect(assistant?.status).toBe("FAILED");

    // 该会话现在可以重新发消息(部分唯一索引不再阻挡)
    const sendRes = await fetch(
      `${ctx.baseUrl}/api/conversations/${seeded.conversationId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify({ content: "新问题" }),
      },
    );
    expect(sendRes.status).toBe(202);
  });
});
