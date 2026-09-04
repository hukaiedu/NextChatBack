import { afterEach, describe, expect, it } from "vitest";

import { AppError } from "../../src/common/errors/app-error.js";
import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import type { BrowserManager } from "../../src/providers/gemini/browser-manager.js";
import { FAKE_CONVERSATION_URL, FakeDriver, FakeGeminiAdapter, createFakeManager } from "../fakes.js";
import type { FakeAdapterBehavior } from "../fakes.js";
import { createConversation, sendMessage, setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

const OTHER_CONVERSATION_URL = "https://gemini.google.com/app/7f21c9ab04de6612";
const CONV_URL_B = "https://gemini.google.com/app/0a1b2c3d4e5f6071";

interface SendBody {
  data: {
    request: { id: string; status: string };
    userMessage: { role: string; content: string; status: string };
    assistantMessage: { role: string; status: string; content: string };
    deduplicated: boolean;
  };
}

async function storedUrl(ctx: TestContext, id: string): Promise<string | null> {
  const row = await ctx.prisma.conversation.findUnique({ where: { id } });
  return row?.providerConversationUrl ?? null;
}

async function waitFor<T>(
  fn: () => Promise<T | null>,
  timeoutMs = 3000,
  description = "condition",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor timeout: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("正式发送链路:POST /messages → Scheduler → GeminiPromptService → Fake Adapter(真 SQLite)", () => {
  let ctx: TestContext;
  let driver: FakeDriver;
  let manager: BrowserManager;
  let adapter: FakeGeminiAdapter;

  async function mount(behavior: FakeAdapterBehavior = {}): Promise<void> {
    driver = new FakeDriver();
    manager = createFakeManager(driver);
    adapter = new FakeGeminiAdapter(behavior);
    ctx = await setupTestContext({
      browserManager: manager,
      geminiAdapter: adapter,
      scheduler: { scanIntervalMs: 25 },
    });
    // providerConversationUrl 是 @unique,用例之间必须清库
    await ctx.reset();
  }

  afterEach(async () => {
    await ctx.close();
  });

  async function sendAndTerminal(
    baseUrl: string,
    conversationId: string,
    content: string,
    key: string,
  ): Promise<{ sendStatus: number; body: SendBody["data"]; finalStatus: string; errorCode: string | null }> {
    const res = await sendMessage(baseUrl, conversationId, content, key);
    const body = (await res.json()) as SendBody;
    const request = await waitFor(async () => {
      const row = await ctx.prisma.modelRequest.findUnique({ where: { id: body.data.request.id } });
      if (!row) {
        return null;
      }
      return ["SUCCESS", "FAILED", "TIMEOUT", "CANCELLED"].includes(row.status)
        ? { status: row.status, errorCode: row.errorCode }
        : null;
    }, 3000, `request ${body.data.request.id} terminal`);
    return { sendStatus: res.status, body: body.data, finalStatus: request.status, errorCode: request.errorCode };
  }

  it("全链路成功:202 受理 → Scheduler 执行 → SUCCESS + assistant 回填 + USER 保留 + URL 已存", async () => {
    await mount({ answer: "假回答" });
    const conv = await createConversation(ctx.baseUrl);

    const { sendStatus, body, finalStatus } = await sendAndTerminal(ctx.baseUrl, conv.id, "你好", "flow-ok-1");

    expect(sendStatus).toBe(202);
    expect(body.request.status).toBe("PENDING");
    expect(body.userMessage).toMatchObject({ role: "USER", content: "你好", status: "COMPLETED" });
    expect(body.assistantMessage).toMatchObject({ role: "ASSISTANT", status: "PENDING" });

    const request = await ctx.prisma.modelRequest.findUnique({ where: { id: body.request.id } });
    expect(finalStatus).toBe("SUCCESS");
    expect(request?.status).toBe("SUCCESS");
    expect(request?.attemptCount).toBe(1);
    expect(request?.startedAt).not.toBeNull();
    expect(request?.completedAt).not.toBeNull();
    expect(request?.errorCode).toBeNull();

    const messages = await ctx.prisma.message.findMany({ orderBy: { position: "asc" } });
    expect(messages.map((m) => [m.role, m.status, m.content])).toEqual([
      ["USER", "COMPLETED", "你好"],
      ["ASSISTANT", "COMPLETED", "假回答"],
    ]);
    expect(await storedUrl(ctx, conv.id)).toBe(FAKE_CONVERSATION_URL);

    // GET /api/requests/:id 与库一致
    const get = await fetch(`${ctx.baseUrl}/api/requests/${body.request.id}`);
    expect(get.status).toBe(200);
    expect(((await get.json()) as { data: { status: string } }).data.status).toBe("SUCCESS");
  });

  it("§16:URL 在回答完成之前就已落库(beforeAnswer 钩子处读库验证)", async () => {
    let targetId = "";
    const seenBeforeAnswer: Array<string | null> = [];
    await mount({
      answer: "收到",
      beforeAnswer: async () => {
        seenBeforeAnswer.push(await storedUrl(ctx, targetId));
      },
    });
    const conv = await createConversation(ctx.baseUrl);
    targetId = conv.id;

    const { finalStatus } = await sendAndTerminal(ctx.baseUrl, conv.id, "你好", "flow-url-1");

    expect(finalStatus).toBe("SUCCESS");
    expect(seenBeforeAnswer).toEqual([FAKE_CONVERSATION_URL]);
  });

  it("第二次发送复用已存 URL,不开新会话", async () => {
    await mount({ answer: "回答" });
    const conv = await createConversation(ctx.baseUrl);

    const first = await sendAndTerminal(ctx.baseUrl, conv.id, "第一问", "reuse-1");
    const second = await sendAndTerminal(ctx.baseUrl, conv.id, "第二问", "reuse-2");

    expect(first.finalStatus).toBe("SUCCESS");
    expect(second.finalStatus).toBe("SUCCESS");
    expect(adapter.openCalls).toEqual([null, FAKE_CONVERSATION_URL]);
    expect(adapter.runCalls.map((c) => c.existingUrl)).toEqual([null, FAKE_CONVERSATION_URL]);
    expect(await storedUrl(ctx, conv.id)).toBe(FAKE_CONVERSATION_URL);
  });

  it("URL 规范化:query 与 hash 不入库", async () => {
    await mount({
      conversationUrl: `${FAKE_CONVERSATION_URL}?m=abc&udm=15#tab=history`,
    });
    const conv = await createConversation(ctx.baseUrl);

    const { finalStatus } = await sendAndTerminal(ctx.baseUrl, conv.id, "你好", "norm-1");

    expect(finalStatus).toBe("SUCCESS");
    expect(await storedUrl(ctx, conv.id)).toBe(FAKE_CONVERSATION_URL);
  });

  it("PROVIDER_RESPONSE_TIMEOUT → Request TIMEOUT,assistant FAILED,User 保留", async () => {
    await mount({
      runError: new AppError(
        ErrorCodes.PROVIDER_RESPONSE_TIMEOUT,
        "Gemini answer did not settle within 300000ms",
        500,
      ),
    });
    const conv = await createConversation(ctx.baseUrl);

    const { finalStatus, errorCode } = await sendAndTerminal(ctx.baseUrl, conv.id, "长任务", "timeout-1");

    expect(finalStatus).toBe("TIMEOUT");
    expect(errorCode).toBe(ErrorCodes.PROVIDER_RESPONSE_TIMEOUT);
    const messages = await ctx.prisma.message.findMany({ orderBy: { position: "asc" } });
    expect(messages[0]).toMatchObject({ role: "USER", status: "COMPLETED", content: "长任务" });
    expect(messages[1]).toMatchObject({ role: "ASSISTANT", status: "FAILED", content: "" });
  });

  it("PROVIDER_DOM_CHANGED → Request FAILED + errorCode", async () => {
    await mount({
      openError: new AppError(
        ErrorCodes.PROVIDER_DOM_CHANGED,
        "Gemini page does not match expected structure",
        500,
      ),
    });
    const conv = await createConversation(ctx.baseUrl);

    const { finalStatus, errorCode } = await sendAndTerminal(ctx.baseUrl, conv.id, "你好", "dom-1");

    expect(finalStatus).toBe("FAILED");
    expect(errorCode).toBe(ErrorCodes.PROVIDER_DOM_CHANGED);
  });

  it("未登录 → Request FAILED PROVIDER_LOGIN_REQUIRED,不触碰 Adapter(§14/原则 27)", async () => {
    await mount();
    driver.redirectToLogin = true;
    const conv = await createConversation(ctx.baseUrl);

    const { finalStatus, errorCode } = await sendAndTerminal(ctx.baseUrl, conv.id, "你好", "login-1");

    expect(finalStatus).toBe("FAILED");
    expect(errorCode).toBe(ErrorCodes.PROVIDER_LOGIN_REQUIRED);
    expect(adapter.openCalls).toEqual([]);
    expect(adapter.runCalls).toEqual([]);
    const assistant = await ctx.prisma.message.findFirst({ where: { role: "ASSISTANT" } });
    expect(assistant?.status).toBe("FAILED");
    expect(assistant?.content).toBe("");
  });

  it("会话已绑定别的 Gemini 会话 → FAILED PROVIDER_CONVERSATION_UNAVAILABLE 且不改绑", async () => {
    await mount();
    const conv = await createConversation(ctx.baseUrl);
    await ctx.prisma.conversation.update({
      where: { id: conv.id },
      data: { providerConversationUrl: OTHER_CONVERSATION_URL },
    });

    const { finalStatus, errorCode } = await sendAndTerminal(ctx.baseUrl, conv.id, "你好", "bound-1");

    expect(finalStatus).toBe("FAILED");
    expect(errorCode).toBe(ErrorCodes.PROVIDER_CONVERSATION_UNAVAILABLE);
    expect(await storedUrl(ctx, conv.id)).toBe(OTHER_CONVERSATION_URL);
  });

  it("不同 Conversation 同时排队:执行期间 BUSY,第二个等第一个完成,串行不并发", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mount({
      conversationUrls: [FAKE_CONVERSATION_URL, CONV_URL_B],
      beforeAnswer: () => gate,
    });
    const convA = await createConversation(ctx.baseUrl, "A");
    const convB = await createConversation(ctx.baseUrl, "B");

    const sendA = await sendMessage(ctx.baseUrl, convA.id, "A 的提问", "serial-a");
    const bodyA = ((await sendA.json()) as SendBody).data;
    // 等 A 进入执行(BUSY = claim 之后、执行中)
    await waitFor(async () => (manager.getStatus() === "BUSY" ? true : null), 3000, "browser BUSY");
    const rowA1 = await ctx.prisma.modelRequest.findUnique({ where: { id: bodyA.request.id } });
    expect(rowA1?.status).toBe("PROCESSING");

    // A 执行期间:B 的发送被受理但留在 PENDING(单飞 drain 掉 notify)
    const sendB = await sendMessage(ctx.baseUrl, convB.id, "B 的提问", "serial-b");
    expect(sendB.status).toBe(202);
    const bodyB = ((await sendB.json()) as SendBody).data;
    const rowB1 = await ctx.prisma.modelRequest.findUnique({ where: { id: bodyB.request.id } });
    expect(rowB1?.status).toBe("PENDING");

    // 同 Conversation 第二次发送:即使 Scheduler 忙,活动 Request 检查仍然即时 409
    const duplicate = await sendMessage(ctx.baseUrl, convA.id, "A 的第二个提问", "serial-a2");
    expect(duplicate.status).toBe(409);
    expect(((await duplicate.json()) as { error: { code: string } }).error.code).toBe(
      ErrorCodes.CONVERSATION_REQUEST_IN_PROGRESS,
    );

    release();
    await waitFor(async () => {
      const row = await ctx.prisma.modelRequest.findUnique({ where: { id: bodyA.request.id } });
      return row?.status === "SUCCESS" ? row : null;
    }, 3000, "request A SUCCESS");
    await waitFor(async () => {
      const row = await ctx.prisma.modelRequest.findUnique({ where: { id: bodyB.request.id } });
      return row?.status === "SUCCESS" ? row : null;
    }, 3000, "request B SUCCESS");

    // 串行:先 A 后 B,且执行结束后 BUSY 释放
    expect(adapter.runCalls.map((c) => c.prompt)).toEqual(["A 的提问", "B 的提问"]);
    expect(manager.getStatus()).toBe("READY");
  });

  it("第 4 阶段验证端点已移除:POST /api/provider/prompt → 404", async () => {
    await mount();
    const res = await fetch(`${ctx.baseUrl}/api/provider/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "whatever", prompt: "你好" }),
    });
    expect(res.status).toBe(404);
  });
});
