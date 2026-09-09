import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { AppError } from "../../src/common/errors/app-error.js";
import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { createLogger } from "../../src/common/logger/logger.js";
import { isContextClosedError } from "../../src/providers/gemini/gemini.errors.js";
import { BrowserManager } from "../../src/providers/gemini/browser-manager.js";
import {
  FAKE_CONVERSATION_URL,
  FakeDriver,
  FakeGeminiAdapter,
  ScriptedSessionChecker,
  createFakeManager,
} from "../fakes.js";
import type { FakeAdapterBehavior } from "../fakes.js";
import { setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

const CONV_URL_A = "https://gemini.google.com/app/9999aaaa8888bbbb";
const CONV_URL_B = "https://gemini.google.com/app/0a1b2c3d4e5f6071";
const GEMINI_BASE_URL = "https://gemini.google.com/app";

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

  async function mount(
    behavior: FakeAdapterBehavior = {},
    executionTimeoutMs?: number,
    prebuilt?: { driver: FakeDriver; manager: BrowserManager },
  ): Promise<void> {
    adapter = new FakeGeminiAdapter(behavior);
    if (prebuilt) {
      // P8-SESSION-04:注入自定义 checker/settle 窗口的 manager,driver 必须同源
      driver = prebuilt.driver;
      manager = prebuilt.manager;
    } else {
      driver = new FakeDriver();
      manager = createFakeManager(driver);
    }
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

  it("P8-SESSION-04 冷启动导航后水合窗口内 INDETERMINATE×2 → AUTHENTICATED → SUCCESS,不误判 PROVIDER_LOGIN_REQUIRED", async () => {
    // P8-FIX-01/Rev3.1 回归:goto 刚返回时 Gemini SPA 尚未水合出登录证据(前两次
    // check=INDETERMINATE —— 无 signed-out 证据也不算已登录),水合完成后第三次
    // check=AUTHENTICATED。修复前 settle 缺失 → 一次非正判即定案 LOGIN_REQUIRED
    // → 请求被误判 FAILED;修复后经有界轮询读到 READY → 正常执行。
    driver = new FakeDriver();
    const checker = new ScriptedSessionChecker(GEMINI_BASE_URL, [
      "INDETERMINATE",
      "INDETERMINATE",
      "AUTHENTICATED",
    ]);
    const settleManager = new BrowserManager({
      driver,
      profileDir: "./data/browser-profile",
      headless: true,
      geminiBaseUrl: GEMINI_BASE_URL,
      logger: createLogger("silent"),
      sessionChecker: checker,
      postNavSettle: { timeoutMs: 150, pollMs: 10 },
    });
    await mount({ answer: "水合后回答" }, undefined, { driver, manager: settleManager });
    const seeded = await seedPending("冷启动问题");

    await ctx.scheduler!.runOnce();

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    const assistant = await ctx.prisma.message.findUnique({
      where: { id: seeded.assistantMessageId },
    });
    expect(request?.status).toBe("SUCCESS");
    expect(request?.attemptCount).toBe(1);
    expect(assistant?.status).toBe("COMPLETED");
    expect(assistant?.content).toBe("水合后回答");
    expect(adapter.runCalls).toHaveLength(1);
    expect(manager.getStatus()).toBe("READY");
    // settle 轮询真实发生过(false→false→true),不是 goto 后单次判定放行
    expect(checker.calls).toBeGreaterThanOrEqual(3);
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

  // ---------------------------------------------------------------------------
  // §8.8 Context 关闭竞态:close/crash 事件是异步的,执行异常可能先于事件到达。
  // "Target page, context or browser has been closed" 等文案为 Page 单独关闭与
  // Context 崩溃共用,归类必须按 BrowserManager 的 Page/Context 状态裁定,
  // 不得按文案一刀切成 Browser Crash。
  // ---------------------------------------------------------------------------

  it("竞态:裸 Target page... 异常先抛,Context close 事件晚 10ms 落地 → PROVIDER_BROWSER_CRASHED", async () => {
    await mount({
      runError: new Error("Target page, context or browser has been closed"),
      beforeRunError: () => {
        setTimeout(() => driver.latestContext?.emitClosed(), 10);
      },
    });
    const seeded = await seedPending("问题");

    await ctx.scheduler!.runOnce();

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    expect(request?.status).toBe("FAILED");
    expect(request?.errorCode).toBe(ErrorCodes.PROVIDER_BROWSER_CRASHED);
    expect(request?.errorMessage).toBe("Target page, context or browser has been closed");
    // 粘性码已被分类读并清,不残留到下一条请求
    expect(manager.takeProviderFault()).toBeNull();
  });

  it("误分类边界:裸 Target page... 异常 + 仅 Gemini Page 关闭(Context 存活)→ PROVIDER_PAGE_CLOSED", async () => {
    await mount({
      runError: new Error("Target page, context or browser has been closed"),
      beforeRunError: () => {
        setTimeout(() => driver.latestContext?.lastPage?.emitClosed(), 10);
      },
    });
    const seeded = await seedPending("问题");

    await ctx.scheduler!.runOnce();

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    expect(request?.status).toBe("FAILED");
    expect(request?.errorCode).toBe(ErrorCodes.PROVIDER_PAGE_CLOSED);
    // Page 单独关闭不写粘性码:故障不会以崩溃形式残留
    expect(manager.takeProviderFault()).toBeNull();
  });

  it("竞态:裸 Target crashed 异常 + Page renderer crash 事件晚 10ms 落地 → PROVIDER_BROWSER_CRASHED", async () => {
    await mount({
      runError: new Error("Target crashed"),
      beforeRunError: () => {
        setTimeout(() => driver.latestContext?.lastPage?.emitCrashed(), 10);
      },
    });
    const seeded = await seedPending("问题");

    await ctx.scheduler!.runOnce();

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    expect(request?.status).toBe("FAILED");
    expect(request?.errorCode).toBe(ErrorCodes.PROVIDER_BROWSER_CRASHED);
  });

  it("裸关闭族异常 + 窗口内无任何事件落地 → INTERNAL_ERROR 兜底(等待有界,维持旧语义)", async () => {
    await mount({
      runError: new Error("Target page, context or browser has been closed"),
    });
    const seeded = await seedPending("问题");

    await ctx.scheduler!.runOnce();

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    expect(request?.status).toBe("FAILED");
    expect(request?.errorCode).toBe(ErrorCodes.INTERNAL_ERROR);
  });

  it("cause 链:adapter 把 Context 崩溃包进 domChanged,close 事件晚 10ms 落地 → PROVIDER_BROWSER_CRASHED", async () => {
    await mount({
      runError: new AppError(
        ErrorCodes.PROVIDER_DOM_CHANGED,
        "Gemini page does not match expected structure: composer is not editable",
        new Error("Target closed"),
      ),
      beforeRunError: () => {
        setTimeout(() => driver.latestContext?.emitClosed(), 10);
      },
    });
    const seeded = await seedPending("问题");

    await ctx.scheduler!.runOnce();

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    expect(request?.status).toBe("FAILED");
    expect(request?.errorCode).toBe(ErrorCodes.PROVIDER_BROWSER_CRASHED);
  });

  it("主动关页不是崩溃:pageClosed() 维持 PROVIDER_PAGE_CLOSED,不误判", async () => {
    await mount({
      runError: new AppError(
        ErrorCodes.PROVIDER_PAGE_CLOSED,
        "Gemini page was closed during execution",
      ),
    });
    const seeded = await seedPending("问题");

    await ctx.scheduler!.runOnce();

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    expect(request?.status).toBe("FAILED");
    expect(request?.errorCode).toBe(ErrorCodes.PROVIDER_PAGE_CLOSED);
  });

  it("无关原始异常仍兜底 INTERNAL_ERROR(识别不扩大化)", async () => {
    await mount({
      runError: new TypeError("Cannot read properties of undefined (reading 'click')"),
    });
    const seeded = await seedPending("问题");

    await ctx.scheduler!.runOnce();

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: seeded.requestId } });
    expect(request?.status).toBe("FAILED");
    expect(request?.errorCode).toBe(ErrorCodes.INTERNAL_ERROR);
  });
});

describe("isContextClosedError(Playwright 关闭族文案检测,§8.8)", () => {
  it("命中各类 Playwright 关闭/崩溃文案", () => {
    expect(isContextClosedError(new Error("Target closed"))).toBe(true);
    expect(
      isContextClosedError(new Error("Target page, context or browser has been closed")),
    ).toBe(true);
    expect(isContextClosedError(new Error("Browser has been closed"))).toBe(true);
    expect(isContextClosedError(new Error("Browser has disconnected"))).toBe(true);
    expect(isContextClosedError(new Error("Target crashed"))).toBe(true);
    expect(isContextClosedError(new Error("Page crashed"))).toBe(true);
  });

  it("沿 cause 链下钻:err 本身 + 最多 4 层 cause,超限停止(防环)", () => {
    const leaf = new Error("Target closed");
    const level1 = new Error("wrap-1", { cause: leaf });
    const level2 = new Error("wrap-2", { cause: level1 });
    const level3 = new Error("wrap-3", { cause: level2 });
    const level4 = new Error("wrap-4", { cause: level3 });

    expect(isContextClosedError(new Error("outer", { cause: leaf }))).toBe(true);
    expect(isContextClosedError(new Error("outer", { cause: level3 }))).toBe(true);
    // leaf 已在第 5 层 cause,超出下钻上限
    expect(isContextClosedError(new Error("outer", { cause: level4 }))).toBe(false);
  });

  it("超时/业务文案/非 Error 值不误判", () => {
    expect(isContextClosedError(new Error("Timeout 30000ms exceeded"))).toBe(false);
    expect(
      isContextClosedError(
        new AppError(ErrorCodes.PROVIDER_PAGE_CLOSED, "Gemini page was closed during execution"),
      ),
    ).toBe(false);
    expect(isContextClosedError("Target closed")).toBe(false);
    expect(isContextClosedError(undefined)).toBe(false);
  });
});
