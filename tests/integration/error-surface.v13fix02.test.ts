import type { Server } from "node:http";

import express from "express";
import type { Express } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { markAdminErrorSurface } from "../../src/common/errors/error-exposure.js";
import { createLogger } from "../../src/common/logger/logger.js";
import { errorHandler } from "../../src/common/middleware/error-handler.js";
import { requestId as requestIdMiddleware } from "../../src/common/middleware/request-id.js";
import { ADMIN_USER_ID } from "../../src/config/constants.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { RequestService } from "../../src/modules/request/request.service.js";
import { computeRequestFingerprint } from "../../src/common/utils/fingerprint.js";
import { FakeDriver, FakeGeminiAdapter, createFakeManager } from "../fakes.js";
import {
  ADMIN_AUTH,
  SseTestClient,
  loginAdmin,
  setupTestContext,
  withAdminCookie,
} from "../helpers.js";
import type { TestContext } from "../helpers.js";

/**
 * V1.3-B3 FIX-02A:错误暴露级别由 **API surface** 决定,不是由 `req.auth.userType` 决定。
 *
 * 这一整组用例的共同前提都是「调用者确实是 ADMIN」—— 也就是说身份维度已经被拉满,
 * 剩下的差异只能来自路由:Public 路由必须仍是 Public Error,Admin surface 必须仍是运维语义。
 * 因此任何一条用例失败,都不可能靠「换个身份」绕过。
 */
const SECRET = "SECRET_ADMIN_PUBLIC_LEAK_123";
const CONTENT = "你好";

/**
 * 直接落一条 ADMIN 名下的 FAILED Request(带内部错误码与内部 message)。
 * owner 必须是 ADMIN:否则 ADMIN 的 Cookie 只会拿到 404,测的就是 ownership 而不是暴露面。
 */
async function seedAdminFailedRequest(
  ctx: TestContext,
  key: string,
  errorCode: string,
): Promise<{ conversationId: string; requestId: string }> {
  const conversation = await ctx.prisma.conversation.create({
    data: { title: `surface-${key}`, userId: ADMIN_USER_ID },
  });
  const userMessage = await ctx.prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "USER",
      content: CONTENT,
      status: "COMPLETED",
      position: 1,
    },
  });
  const assistantMessage = await ctx.prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "ASSISTANT",
      content: "半成品",
      status: "FAILED",
      position: 2,
    },
  });
  const request = await ctx.prisma.modelRequest.create({
    data: {
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      idempotencyKey: key,
      requestFingerprint: computeRequestFingerprint(conversation.id, CONTENT),
      status: "FAILED",
      errorCode,
      errorMessage: `Gemini DOM changed ${SECRET}`,
    },
  });
  return { conversationId: conversation.id, requestId: request.id };
}

describe("V1.3-B3 FIX-02A Public / Admin Error Surface", () => {
  let ctx: TestContext;
  let driver: FakeDriver;
  let admin: string;

  afterEach(async () => {
    await ctx.close();
  });

  /** 每个用例一套 app:04/05 要往 FakeDriver 注入启动故障,不能互相污染 */
  async function mountAsAdmin(): Promise<string> {
    driver = new FakeDriver();
    ctx = await setupTestContext({
      browserManager: createFakeManager(driver),
      geminiAdapter: new FakeGeminiAdapter({ answer: "假回答" }),
      auth: ADMIN_AUTH,
    });
    await ctx.reset();
    admin = await loginAdmin(ctx.baseUrl);
    return admin;
  }

  it("ERR-SURFACE-01 ADMIN 调 Public Request API:仍是 CHAT_FAILED,不泄露原码原文", async () => {
    await mountAsAdmin();
    const { requestId } = await seedAdminFailedRequest(
      ctx,
      "surface-01",
      ErrorCodes.PROVIDER_DOM_CHANGED,
    );

    const res = await fetch(
      `${ctx.baseUrl}/api/requests/${requestId}`,
      withAdminCookie(admin),
    );
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const data = (JSON.parse(text) as { data: Record<string, unknown> }).data;
    expect(data.errorCode).toBe("CHAT_FAILED");
    expect(data.errorMessage).toBe("Chat request failed.");
    expect(text).not.toContain(ErrorCodes.PROVIDER_DOM_CHANGED);
    expect(text).not.toContain(SECRET);

    // §18:映射只发生在对外视图,DB 里仍是原码原文
    const row = await ctx.prisma.modelRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(row.errorCode).toBe(ErrorCodes.PROVIDER_DOM_CHANGED);
    expect(row.errorMessage).toContain(SECRET);
  });

  it("ERR-SURFACE-02 ADMIN 调 Public Message History:内嵌 Request 也被映射", async () => {
    await mountAsAdmin();
    const { conversationId } = await seedAdminFailedRequest(
      ctx,
      "surface-02",
      ErrorCodes.PROVIDER_DOM_CHANGED,
    );

    const res = await fetch(
      `${ctx.baseUrl}/api/conversations/${conversationId}/messages`,
      withAdminCookie(admin),
    );
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const items = (JSON.parse(text) as { data: Record<string, unknown>[] }).data;
    const brief = items.find((m) => m.role === "ASSISTANT")!.request as Record<string, unknown>;
    expect(brief.errorCode).toBe("CHAT_FAILED");
    expect(brief.errorMessage).toBe("Chat request failed.");
    expect(text).not.toContain(ErrorCodes.PROVIDER_DOM_CHANGED);
    expect(text).not.toContain(SECRET);
  });

  it("ERR-SURFACE-03 ADMIN 调 Public SSE:error 帧同样只剩通用码", async () => {
    await mountAsAdmin();
    const { requestId } = await seedAdminFailedRequest(
      ctx,
      "surface-03",
      ErrorCodes.PROVIDER_BROWSER_CRASHED,
    );

    const client = await SseTestClient.connect(
      ctx.baseUrl,
      requestId,
      withAdminCookie(admin),
    );
    try {
      const frame = await client.waitFor((e) => e.event === "error", "ADMIN SSE error frame");
      const text = JSON.stringify(frame.data);
      expect(frame.data.code).toBe("CHAT_FAILED");
      expect(text).not.toContain(ErrorCodes.PROVIDER_BROWSER_CRASHED);
      expect(text).not.toContain(SECRET);
    } finally {
      client.close();
    }
  });

  it("ERR-SURFACE-04 canonical Admin surface:运维原始码不被 Public 映射误伤", async () => {
    await mountAsAdmin();
    driver.throwOnLaunch = new Error(`launch failed ${SECRET}`);

    const res = await fetch(
      `${ctx.baseUrl}/api/admin/browser/restart`,
      withAdminCookie(admin, { method: "POST" }),
    );
    const text = await res.text();
    // 对照 §17:同一个码若出现在 Public 面会被改写成 CHAT_FAILED;这里是 Admin surface,保持原样
    expect(res.status, text).toBe(500);
    expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe(
      ErrorCodes.BROWSER_LAUNCH_FAILED,
    );
    expect(text).not.toContain("CHAT_FAILED");
  });

  it("ERR-SURFACE-05 旧 alias 已退役:旧路径 404,canonical Admin surface 保持原运维码", async () => {
    await mountAsAdmin();
    driver.throwOnLaunch = new Error(`launch failed ${SECRET}`);

    // §25(V1.3-C):旧路径不再挂载任何 router —— 连 handler 都进不到
    const retired = await fetch(
      `${ctx.baseUrl}/api/browser/restart`,
      withAdminCookie(admin, { method: "POST" }),
    );
    expect(retired.status).toBe(404);

    const canonical = await fetch(
      `${ctx.baseUrl}/api/admin/browser/restart`,
      withAdminCookie(admin, { method: "POST" }),
    );
    const canonicalText = await canonical.text();
    expect(canonical.status, canonicalText).toBe(500);
    expect(
      (JSON.parse(canonicalText) as { error: { code: string } }).error.code,
    ).toBe(ErrorCodes.BROWSER_LAUNCH_FAILED);
  });

  it("ERR-SURFACE-06 Public 路由抛内部异常:ADMIN 的 HTTP 错误信封也只是通用码(判据改变的真实路径)", async () => {
    await mountAsAdmin();
    const { requestId } = await seedAdminFailedRequest(
      ctx,
      "surface-06",
      ErrorCodes.PROVIDER_DOM_CHANGED,
    );

    // FIX-02A 之前这里按 userType 推 exposure:ADMIN 会原样拿到 DATABASE_ERROR。
    // 现在判据是 surface,Public 路由上无论谁调用都只剩 CHAT_FAILED(500 状态仍由原码推导)。
    const failure = vi
      .spyOn(RequestService.prototype, "getOwnedById")
      .mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("database disk image is malformed", {
          code: "P2003",
          clientVersion: "test",
        }),
      );
    try {
      const res = await fetch(
        `${ctx.baseUrl}/api/requests/${requestId}`,
        withAdminCookie(admin),
      );
      const text = await res.text();
      expect(res.status, text).toBe(500);
      const error = (JSON.parse(text) as { error: { code: string; message: string } }).error;
      expect(error.code).toBe("CHAT_FAILED");
      expect(error.message).toBe("Chat request failed.");
      expect(text).not.toContain(ErrorCodes.DATABASE_ERROR);
      expect(text).not.toContain(ErrorCodes.INTERNAL_ERROR);
      expect(text).not.toMatch(/malformed/i);
    } finally {
      failure.mockRestore();
    }
    // Admin surface 的反面对照(同一注入手法保留原码)已由 ADM-R02 覆盖
  });
});

/**
 * ERR-SURFACE-07:把判据本身钉死在最小 express 链上。
 *
 * 上面 01..06 都经过完整装配,读起来是「路由行为」;这里只留 requestId + 抛错路由 + errorHandler,
 * 逐格穷举 身份 × surface 标记 四组合。旧实现(userType 推导)会在 ADMIN + 未标记这格返回
 * DATABASE_ERROR,所以这一格就是本文件的永久 RED 判据,不依赖一次性回退验证。
 */
describe("FIX-02A 判据矩阵:errorHandler 只认 surface 标记", () => {
  async function withBoomApp(userType: "ADMIN" | "ANONYMOUS", markAdmin: boolean) {
    const app: Express = express();
    app.use(requestIdMiddleware());
    app.get("/boom", (req, res) => {
      req.auth = {
        userId: userType === "ADMIN" ? ADMIN_USER_ID : "u-anon",
        userType,
        sessionId: null,
        expiresAt: null,
      };
      if (markAdmin) markAdminErrorSurface(res);
      throw new Prisma.PrismaClientKnownRequestError("internal db detail", {
        code: "P2003",
        clientVersion: "test",
      });
    });
    app.use(errorHandler(createLogger("silent")));

    const server: Server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    return {
      baseUrl,
      async close(): Promise<void> {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  it.each([
    { userType: "ADMIN", marked: false, expected: "CHAT_FAILED" },
    { userType: "ADMIN", marked: true, expected: "DATABASE_ERROR" },
    { userType: "ANONYMOUS", marked: false, expected: "CHAT_FAILED" },
    { userType: "ANONYMOUS", marked: true, expected: "DATABASE_ERROR" },
  ] as const)(
    "ERR-SURFACE-07 $userType + marked=$marked → $expected",
    async ({ userType, marked, expected }) => {
      const server = await withBoomApp(userType, marked);
      try {
        const res = await fetch(`${server.baseUrl}/boom`);
        // 状态码始终由原始码推导,不随暴露级别变化(§16)
        expect(res.status).toBe(500);
        const error = (JSON.parse(await res.text()) as {
          error: { code: string; message: string };
        }).error;
        expect(error.code).toBe(expected);
        expect(error.message).toBe(
          expected === "CHAT_FAILED" ? "Chat request failed." : "Database error",
        );
      } finally {
        await server.close();
      }
    },
  );
});
