import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { AppError } from "../../src/common/errors/app-error.js";
import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import type { BrowserManager } from "../../src/providers/gemini/browser-manager.js";
import { FAKE_CONVERSATION_URL, FakeDriver, FakeGeminiAdapter, createFakeManager } from "../fakes.js";
import type { FakeAdapterBehavior } from "../fakes.js";
import { setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

const CONV_URL_A = "https://gemini.google.com/app/9999aaaa8888bbbb";
const CONV_URL_B = "https://gemini.google.com/app/0a1b2c3d4e5f6071";

interface Seeded {
  conversationId: string;
  requestId: string;
  assistantMessageId: string;
}

describe("RequestScheduler(单进程串行调度,Fake Adapter + 真 SQLite)", () => {
  let ctx: TestContext;
  let driver: FakeDriver;
  let manager: BrowserManager;
  let adapter: FakeGeminiAdapter;
  let sequence = 0;

  async function mount(behavior: FakeAdapterBehavior = {}, executionTimeoutMs?: number): Promise<void> {
    driver = new FakeDriver();
    manager = createFakeManager(driver);
    adapter = new FakeGeminiAdapter(behavior);
    ctx = await setupTestContext({
      browserManager: manager,
      geminiAdapter: adapter,
      // 不用 interval,统一 runOnce 手动驱动,断言确定性
      scheduler: { autoStart: false, executionTimeoutMs },
    });
    // providerConversationUrl 是 @unique,用例之间必须清库
    await ctx.reset();
  }

  afterEach(async () => {
    await ctx.close();
  });

  /** 直接落一条 PENDING(绕过 HTTP;createdAt 可控) */
  async function seedPending(content: string, createdAt?: Date): Promise<Seeded> {
    sequence++;
    const conversation = await ctx.prisma.conversation.create({
      data: { title: `conv-${sequence}`, status: "ACTIVE", provider: "GEMINI_WEB" },
    });
    const userMessage = await ctx.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "USER",
        content,
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
        ...(createdAt ? { createdAt } : {}),
      },
    });
    return {
      conversationId: conversation.id,
      requestId: request.id,
      assistantMessageId: assistantMessage.id,
    };
  }

  it("成功路径:认领 → 执行期间 BUSY → SUCCESS + assistant 回填 + URL 落库", async () => {
    const statusesDuringRun: string[] = [];
    await mount({
      answer: "最终回答",
      beforeAnswer: async () => {
        statusesDuringRun.push(manager.getStatus());
      },
    });
    const seeded = await seedPending("第一问");

    await ctx.scheduler!.runOnce();

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    const assistant = await ctx.prisma.message.findUnique({ where: { id: seeded.assistantMessageId } });
    const conversation = await ctx.prisma.conversation.findUnique({
      where: { id: seeded.conversationId },
    });
    expect(request?.status).toBe("SUCCESS");
    expect(request?.attemptCount).toBe(1);
    expect(request?.startedAt).not.toBeNull();
    expect(request?.completedAt).not.toBeNull();
    expect(assistant?.status).toBe("COMPLETED");
    expect(assistant?.content).toBe("最终回答");
    expect(conversation?.providerConversationUrl).toBe(FAKE_CONVERSATION_URL);
    // §12.5/§11.2:执行期间 BUSY,结束后释放
    expect(statusesDuringRun).toEqual(["BUSY"]);
    expect(manager.getStatus()).toBe("READY");
  });

  it("认领顺序:多个 PENDING 按 createdAt 从老到新逐个执行", async () => {
    await mount({ conversationUrls: [CONV_URL_A, CONV_URL_B] });
    await seedPending("老问题", new Date(Date.now() - 60_000));
    await seedPending("新问题", new Date());

    await ctx.scheduler!.runOnce();

    expect(adapter.runCalls.map((call) => call.prompt)).toEqual(["老问题", "新问题"]);
    const requests = await ctx.prisma.modelRequest.findMany({ orderBy: { createdAt: "asc" } });
    expect(requests.map((r) => r.status)).toEqual(["SUCCESS", "SUCCESS"]);
  });

  it("登录失效 → 认领后 FAILED PROVIDER_LOGIN_REQUIRED,从不触碰 Adapter", async () => {
    await mount();
    driver.sameOriginNotLoggedIn = true;
    const first = await seedPending("问题一");
    const second = await seedPending("问题二");

    await ctx.scheduler!.runOnce();

    expect(adapter.openCalls).toEqual([]);
    expect(adapter.runCalls).toEqual([]);
    const requests = await ctx.prisma.modelRequest.findMany();
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.status).toBe("FAILED");
      expect(request.errorCode).toBe(ErrorCodes.PROVIDER_LOGIN_REQUIRED);
      expect(request.completedAt).not.toBeNull();
    }
    const assistants = await ctx.prisma.message.findMany({
      where: { id: { in: [first.assistantMessageId, second.assistantMessageId] } },
    });
    expect(assistants.every((m) => m.status === "FAILED")).toBe(true);
  });

  it("Browser 启动失败 → 请求留在 PENDING 等待(§12.2),不认领不失败", async () => {
    await mount();
    driver.throwOnLaunch = new Error("browser start failed");
    const seeded = await seedPending("问题");

    await ctx.scheduler!.runOnce();

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    expect(request?.status).toBe("PENDING");
    expect(request?.attemptCount).toBe(0);
    expect(request?.startedAt).toBeNull();
    expect(adapter.runCalls).toEqual([]);

    // Browser 恢复后下一轮继续(§12.1:内存队列重启丢失,PENDING 靠扫描自然恢复)
    driver.throwOnLaunch = null;
    await ctx.scheduler!.runOnce();
    const recovered = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    expect(recovered?.status).toBe("SUCCESS");
  });

  it("PROVIDER_RESPONSE_TIMEOUT → Request TIMEOUT + errorCode(§12.13 映射)", async () => {
    await mount({
      runError: new AppError(
        ErrorCodes.PROVIDER_RESPONSE_TIMEOUT,
        "Gemini answer did not settle within 300000ms",
        500,
      ),
    });
    const seeded = await seedPending("长任务");

    await ctx.scheduler!.runOnce();

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    expect(request?.status).toBe("TIMEOUT");
    expect(request?.errorCode).toBe(ErrorCodes.PROVIDER_RESPONSE_TIMEOUT);
    expect(request?.completedAt).not.toBeNull();
  });

  it("PROVIDER_DOM_CHANGED → Request FAILED + errorCode + assistant FAILED", async () => {
    await mount({
      openError: new AppError(
        ErrorCodes.PROVIDER_DOM_CHANGED,
        "Gemini page does not match expected structure",
        500,
      ),
    });
    const seeded = await seedPending("问题");

    await ctx.scheduler!.runOnce();

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    const assistant = await ctx.prisma.message.findUnique({ where: { id: seeded.assistantMessageId } });
    expect(request?.status).toBe("FAILED");
    expect(request?.errorCode).toBe(ErrorCodes.PROVIDER_DOM_CHANGED);
    expect(assistant?.status).toBe("FAILED");
  });

  it("执行器挂死 → watchdog 把 PROCESSING 判 TIMEOUT,Browser 仍释放", async () => {
    // 60ms 上限:Adapter 永不返回,只有 Scheduler 的 watchdog 能收尾
    await mount({ hang: true }, 60);
    const seeded = await seedPending("挂死的问题");

    await ctx.scheduler!.runOnce();

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    const assistant = await ctx.prisma.message.findUnique({
      where: { id: seeded.assistantMessageId },
    });
    const conversation = await ctx.prisma.conversation.findUnique({
      where: { id: seeded.conversationId },
    });
    expect(request?.status).toBe("TIMEOUT");
    expect(request?.errorCode).toBe(ErrorCodes.PROVIDER_RESPONSE_TIMEOUT);
    expect(request?.errorMessage).toContain("60ms");
    expect(request?.completedAt).not.toBeNull();
    expect(assistant?.status).toBe("FAILED");
    expect(assistant?.content).toBe("");
    // §12.1:挂死前已落库的会话 URL 保留,不做 Gemini Cancel
    expect(conversation?.providerConversationUrl).toBe(FAKE_CONVERSATION_URL);
    expect(manager.getStatus()).toBe("READY");
  });

  it("终态不再被扫描:SUCCESS 的请求不会二次执行(不自动重试,原则 30)", async () => {
    await mount({ answer: "第一次回答" });
    const seeded = await seedPending("问题");

    await ctx.scheduler!.runOnce();
    await ctx.scheduler!.runOnce();

    expect(adapter.runCalls).toHaveLength(1);
    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    expect(request?.attemptCount).toBe(1);
  });
});
