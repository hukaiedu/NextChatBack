import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ADMIN_USER_ID, AUTH_COOKIE_NAME, COMPAT_USER_ID } from "../../src/config/constants.js";
import { hashSessionToken } from "../../src/modules/auth/auth.session-token.js";
import { ADMIN_AUTH, loginAnonymous, setupTestContext, type TestContext } from "../helpers.js";

function tokenOf(cookie: string): string {
  return cookie.slice(AUTH_COOKIE_NAME.length + 1);
}

async function ownerOf(ctx: TestContext, cookie: string): Promise<string> {
  const session = await ctx.prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(tokenOf(cookie)) },
  });
  if (session === null) throw new Error("anonymous session not found");
  return session.userId;
}

async function request(
  ctx: TestContext,
  cookie: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Cookie: cookie,
    },
  });
}

async function createConversation(ctx: TestContext, cookie: string): Promise<string> {
  const response = await request(ctx, cookie, "/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "短期游客历史" }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { data: { id: string } }).data.id;
}

async function expireSessions(ctx: TestContext, userId: string): Promise<void> {
  await ctx.prisma.session.updateMany({
    where: { userId },
    data: { expiresAt: new Date(0), lastSeenAt: new Date(0) },
  });
}

async function assertGuestDataGone(ctx: TestContext, userId: string, conversationId: string) {
  expect(await ctx.prisma.user.findUnique({ where: { id: userId } })).toBeNull();
  expect(await ctx.prisma.conversation.findUnique({ where: { id: conversationId } })).toBeNull();
  expect(await ctx.prisma.message.count({ where: { conversationId } })).toBe(0);
  expect(await ctx.prisma.modelRequest.count({ where: { conversationId } })).toBe(0);
  expect(
    await ctx.prisma.user.count({
      where: { type: "ANONYMOUS", id: { notIn: [ADMIN_USER_ID, COMPAT_USER_ID] } },
    }),
  ).toBe(0);
}

describe("游客短期历史生命周期", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestContext({ auth: ADMIN_AUTH });
    await ctx.reset();
  });

  afterEach(async () => {
    await ctx.close();
  });

  it("Session 失效后 sweep 按 ModelRequest → Message → Conversation → User 清理，且重复执行幂等", async () => {
    const cookie = await loginAnonymous(ctx.baseUrl);
    const userId = await ownerOf(ctx, cookie);
    const conversationId = await createConversation(ctx, cookie);
    const messageResponse = await request(ctx, cookie, `/api/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "guest-cleanup-1" },
      body: JSON.stringify({ content: "游客消息" }),
    });
    expect(messageResponse.status).toBe(202);
    const modelRequest = await ctx.prisma.modelRequest.findUnique({
      where: { idempotencyKey: "guest-cleanup-1" },
    });
    expect(modelRequest).not.toBeNull();
    await ctx.prisma.modelRequest.update({
      where: { id: modelRequest!.id },
      data: { status: "SUCCESS" },
    });

    await expireSessions(ctx, userId);
    expect(await ctx.authSessions!.sweepExpired()).toBe(1);
    await assertGuestDataGone(ctx, userId, conversationId);

    await expect(ctx.authSessions!.sweepExpired()).resolves.toBe(0);
    await assertGuestDataGone(ctx, userId, conversationId);
  });

  it("有效匿名 Session 经 refresh 后仍可恢复 Conversation 历史", async () => {
    const cookie = await loginAnonymous(ctx.baseUrl);
    const conversationId = await createConversation(ctx, cookie);

    const refresh = await request(ctx, cookie, "/api/auth/anonymous", { method: "POST" });
    expect(refresh.status).toBe(200);
    const list = await request(ctx, cookie, "/api/conversations");
    expect(list.status).toBe(200);
    const conversations = ((await list.json()) as { data: Array<{ id: string }> }).data;
    expect(conversations.map(({ id }) => id)).toContain(conversationId);
  });

  it("游客注册升级保留原 User 及其 Conversation 历史", async () => {
    const cookie = await loginAnonymous(ctx.baseUrl);
    const userId = await ownerOf(ctx, cookie);
    const conversationId = await createConversation(ctx, cookie);
    const register = await request(ctx, cookie, "/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "guest-retain-1", password: "Password123!" }),
    });
    expect(register.status).toBe(200);
    const registeredCookie = register.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${AUTH_COOKIE_NAME}=`))
      ?.split(";")[0];
    expect(registeredCookie).toBeDefined();

    const list = await request(ctx, registeredCookie!, "/api/conversations");
    expect(list.status).toBe(200);
    expect(((await list.json()) as { data: Array<{ id: string }> }).data.map(({ id }) => id)).toContain(
      conversationId,
    );

    await expireSessions(ctx, userId);
    await ctx.authSessions!.sweepExpired();
    expect((await ctx.prisma.user.findUnique({ where: { id: userId } }))?.type).toBe("REGISTERED");
    expect(await ctx.prisma.conversation.findUnique({ where: { id: conversationId } })).not.toBeNull();
  });

  it("logout 会调用统一 cleanup service", async () => {
    const cookie = await loginAnonymous(ctx.baseUrl);
    const userId = await ownerOf(ctx, cookie);
    const conversationId = await createConversation(ctx, cookie);
    const logout = await request(ctx, cookie, "/api/auth/logout", { method: "POST" });
    expect(logout.status).toBe(204);
    await assertGuestDataGone(ctx, userId, conversationId);
  });

  it("保护 ADMIN、COMPAT_USER_ID、REGISTERED，不受匿名清理影响", async () => {
    const registeredId = "registered-protected-user";
    await ctx.prisma.user.create({
      data: { id: registeredId, type: "REGISTERED", status: "ACTIVE", username: "protected-user" },
    });
    const protectedIds = [ADMIN_USER_ID, COMPAT_USER_ID, registeredId];
    const conversationIds = await Promise.all(
      protectedIds.map(async (userId, index) =>
        (
          await ctx.prisma.conversation.create({
            data: {
              title: `protected-${index}`,
              status: "ACTIVE",
              provider: "GEMINI_WEB",
              userId,
            },
          })
        ).id,
      ),
    );

    await expect(ctx.authSessions!.sweepExpired()).resolves.toBe(0);
    for (const userId of protectedIds) {
      expect(await ctx.prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
    }
    for (const conversationId of conversationIds) {
      expect(await ctx.prisma.conversation.findUnique({ where: { id: conversationId } })).not.toBeNull();
    }
  });

  it("活动 PENDING Request 延迟清理，完成后 sweep 才删除历史", async () => {
    const cookie = await loginAnonymous(ctx.baseUrl);
    const userId = await ownerOf(ctx, cookie);
    const conversationId = await createConversation(ctx, cookie);
    const messageResponse = await request(ctx, cookie, `/api/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "guest-active-1" },
      body: JSON.stringify({ content: "活动请求" }),
    });
    expect(messageResponse.status).toBe(202);
    const modelRequest = await ctx.prisma.modelRequest.findUnique({
      where: { idempotencyKey: "guest-active-1" },
    });
    expect(modelRequest?.status).toBe("PENDING");

    await expireSessions(ctx, userId);
    await ctx.authSessions!.sweepExpired();
    expect(await ctx.prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
    expect(await ctx.prisma.conversation.findUnique({ where: { id: conversationId } })).not.toBeNull();
    expect(await ctx.prisma.modelRequest.findUnique({ where: { id: modelRequest!.id } })).not.toBeNull();

    await ctx.prisma.modelRequest.update({
      where: { id: modelRequest!.id },
      data: { status: "SUCCESS" },
    });
    await ctx.authSessions!.sweepExpired();
    await assertGuestDataGone(ctx, userId, conversationId);
  });
});
