import { describe, expect, it } from "vitest";

import {
  ADMIN_USER_ID,
  AUTH_COOKIE_NAME,
  COMPAT_USER_ID,
} from "../../src/config/constants.js";
import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeDriver, FakeGeminiAdapter, createFakeManager } from "../fakes.js";
import { attachment } from "../attachment-fixtures.js";
import type { RequestScheduler } from "../../src/modules/request/request.scheduler.js";
import { hashSessionToken } from "../../src/modules/auth/auth.session-token.js";
import type { SchedulerConfig } from "../../src/app.js";
import type { AbuseProtectionConfig } from "../../src/app.js";
import type { AuthDeps } from "../../src/modules/auth/auth.types.js";
import { ADMIN_AUTH, setupTestContext, type TestContext } from "../helpers.js";

/**
 * V1.4 U3:以真实 REGISTERED 身份重做 ownership / multi-session / 身份转换 验收。
 *
 * 与 U2 的分工（任务书 §46/§47）：ISO-01..13、QUOTA-01..04、REG/LOGIN/PWD/REV 的
 * 「拒绝 + 状态码 + 基本 DB 守恒」已由 U2 覆盖，本文件**不复制**，只补 U2 没有的七类证据：
 *
 * 1. 跨用户 404 与不存在 404 的**整体信封同形**（含不含任何内部字段）；
 * 2. Admin 对**每一条**资源面（含写侧 PATCH/DELETE/send/cancel）都无旁路；
 * 3. logout → 新匿名看不到 → 重新登录历史回来（账号持久化的核心 Gate）；
 * 4. 三 Session 改密后的旧/新口令登录语义；
 * 5. DISABLED 注册账号在**业务面**是 401 AUTH_REQUIRED（与 Auth 面的 AUTH_USER_DISABLED 不混淆）；
 * 6. Session 不是 owner：一条设备退出/撤销不影响另一条；
 * 7. 配额与公平的**身份维度是 userId**：readyUsers 槽位、activeByUser、执行次序。
 *
 * 全部经真实 Auth/Session 建立身份（anonymous bootstrap → register → user/login），
 * 不直接写 req.auth;主矩阵在 AUTH_ENABLED=true 下跑（§59）。
 */

const PASSWORD = "Password123!";
const NEW_PASSWORD = "Rotated123!";
const OTHER = "AnotherPass123!";
const TTL_ANON = 7200;
const TTL_ADMIN = 3600;
const TTL_REGISTERED = 86_400;
const TOUCH_INTERVAL = 60;
/** 404 整体比较必须逐请求唯一的 requestId 相同 —— 与 ownership.v13b3 同一手法 */
const PINNED = { "x-request-id": "u3-pinned-request-id" };

interface Actor {
  cookie: string;
  userId: string;
}

function authDeps(overrides: Partial<AuthDeps> = {}): AuthDeps {
  return {
    enabled: true,
    password: ADMIN_AUTH.password,
    ttlAnonymousSeconds: TTL_ANON,
    ttlRegisteredSeconds: TTL_REGISTERED,
    ttlAdminSeconds: TTL_ADMIN,
    touchIntervalSeconds: TOUCH_INTERVAL,
    allowedOrigins: null,
    trustProxy: false,
    cookieSecureAlways: false,
    ...overrides,
  };
}

async function withApp<T>(
  fn: (ctx: TestContext) => Promise<T>,
  options?: {
    auth?: AuthDeps | null;
    abuse?: AbuseProtectionConfig;
    scheduler?: SchedulerConfig;
    adapter?: FakeGeminiAdapter;
  },
): Promise<T> {
  const ctx = await setupTestContext({
    // COMPAT 只做单独 regression(§59):主矩阵一律显式传 AuthDeps
    auth: options && "auth" in options ? options.auth! : authDeps(),
    abuse: options?.abuse,
    scheduler: options?.scheduler,
    browserManager: createFakeManager(new FakeDriver()),
    geminiAdapter: options?.adapter ?? new FakeGeminiAdapter(),
  });
  try {
    await ctx.reset();
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

async function api(
  ctx: TestContext,
  actor: Actor,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: {
      ...(actor.cookie === "" ? {} : { Cookie: actor.cookie }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function cookieOf(res: Response): string {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
  if (raw === undefined) throw new Error(`no Set-Cookie: ${res.status}`);
  return raw.split(";")[0]!;
}

function tokenOf(cookie: string): string {
  return cookie.slice(AUTH_COOKIE_NAME.length + 1);
}

async function bodyOf(ctx: TestContext, actor: Actor, path: string): Promise<Record<string, unknown>> {
  const res = await api(ctx, actor, "GET", path);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function errorOf(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`非 JSON 响应(status ${res.status}):${text.slice(0, 200)}`);
  }
  const error = (parsed as { error?: Record<string, unknown> }).error;
  if (error === undefined) {
    throw new Error(`响应不是错误信封(status ${res.status}):${text.slice(0, 200)}`);
  }
  return error;
}

/** 真实 Auth 建立 REGISTERED：anonymous bootstrap → register（§60） */
async function registered(
  ctx: TestContext,
  username: string,
  password = PASSWORD,
): Promise<Actor> {
  const anon = await api(ctx, { cookie: "", userId: "" }, "POST", "/api/auth/anonymous");
  const cookie = cookieOf(anon);
  const res = await api(
    ctx,
    { cookie, userId: "" },
    "POST",
    "/api/auth/register",
    { username, password },
  );
  if (res.status !== 200) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  const next = cookieOf(res);
  const row = await ctx.prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(tokenOf(next)) },
  });
  return { cookie: next, userId: row!.userId };
}

/** 第二/第三台设备：真实 user/login 取新 Session（§60） */
async function device(
  ctx: TestContext,
  username: string,
  password = PASSWORD,
  presented?: string,
): Promise<Actor> {
  const res = await api(
    ctx,
    { cookie: presented ?? "", userId: "" },
    "POST",
    "/api/auth/user/login",
    { username, password },
  );
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const cookie = cookieOf(res);
  const row = await ctx.prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(tokenOf(cookie)) },
  });
  return { cookie, userId: row!.userId };
}

async function anonymous(ctx: TestContext): Promise<Actor> {
  const res = await api(ctx, { cookie: "", userId: "" }, "POST", "/api/auth/anonymous");
  const cookie = cookieOf(res);
  const row = await ctx.prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(tokenOf(cookie)) },
  });
  return { cookie, userId: row!.userId };
}

async function admin(ctx: TestContext): Promise<Actor> {
  const res = await api(ctx, { cookie: "", userId: "" }, "POST", "/api/auth/login", {
    password: ADMIN_AUTH.password,
  });
  return { cookie: cookieOf(res), userId: ADMIN_USER_ID };
}

async function newConversation(
  ctx: TestContext,
  actor: Actor,
  body: Record<string, unknown> = {},
): Promise<string> {
  const res = await api(ctx, actor, "POST", "/api/conversations", body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

async function send(
  ctx: TestContext,
  actor: Actor,
  conversationId: string,
  content: string,
  key: string,
  extra: Record<string, string> = {},
  attachments?: Array<{ name: string; mimeType: string; data: string }>,
): Promise<Response> {
  return api(
    ctx,
    actor,
    "POST",
    `/api/conversations/${conversationId}/messages`,
    attachments === undefined ? { content } : { content, attachments },
    { "Idempotency-Key": key, ...extra },
  );
}

/** 发一条并等它成为 PENDING Request（Scheduler 未启动 ⇒ 状态稳定） */
async function seedRequest(
  ctx: TestContext,
  actor: Actor,
  title: string,
  content: string,
  key: string,
): Promise<{ conversationId: string; requestId: string }> {
  const conversationId = await newConversation(ctx, actor, { title });
  const res = await send(ctx, actor, conversationId, content, key);
  expect(res.status).toBe(202);
  const body = (await res.json()) as { data: { request: { id: string } } };
  return { conversationId, requestId: body.data.request.id };
}

async function conversationIds(ctx: TestContext, actor: Actor): Promise<string[]> {
  const res = await api(ctx, actor, "GET", "/api/conversations");
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { id: string }[] }).data.map((c) => c.id);
}

async function fullSnapshot(ctx: TestContext, userId: string) {
  const conversations = await ctx.prisma.conversation.findMany({
    where: { userId },
    orderBy: { id: "asc" },
    select: { id: true, userId: true, title: true, status: true, preferredModelKey: true },
  });
  const ids = conversations.map((c) => c.id);
  const messages = await ctx.prisma.message.findMany({
    where: { conversationId: { in: ids } },
    orderBy: [{ conversationId: "asc" }, { position: "asc" }],
    select: { id: true, conversationId: true, role: true, content: true, status: true, position: true },
  });
  const requests = await ctx.prisma.modelRequest.findMany({
    where: { conversationId: { in: ids } },
    orderBy: { id: "asc" },
    select: { id: true, conversationId: true, status: true, idempotencyKey: true, attemptCount: true },
  });
  return { conversations, messages, requests };
}

describe("U3-OWN 归属与身份转换验收(V1.4 U3)", () => {
  it("U3-OWN-01 跨用户 404 与不存在 404 整体信封同形,且不含任何内部字段", async () => {
    await withApp(async (ctx) => {
      const b = await registered(ctx, "bob");
      const c = await registered(ctx, "carol", OTHER);
      const { conversationId, requestId } = await seedRequest(ctx, b, "B 的会话", "B 的提问", "k-own-01");

      const surfaces: Array<[string, string]> = [
        ["conversation", `/api/conversations/${conversationId}`],
        ["request", `/api/requests/${requestId}`],
        ["messages", `/api/conversations/${conversationId}/messages`],
      ];
      const missing: Record<string, string> = {
        conversation: "/api/conversations/00000000-0000-0000-0000-0000000000fe",
        request: "/api/requests/00000000-0000-0000-0000-0000000000fe",
        messages: "/api/conversations/00000000-0000-0000-0000-0000000000fe/messages",
      };
      for (const [key, path] of surfaces) {
        const foreign = await api(ctx, c, "GET", path, undefined, PINNED);
        const absent = await api(ctx, c, "GET", missing[key]!, undefined, PINNED);
        expect(foreign.status, key).toBe(404);
        expect(absent.status, key).toBe(404);
        const foreignError = await errorOf(foreign);
        // 整体信封同形:状态码 + 精确三键 + 逐字段相等
        expect(Object.keys(foreignError).sort()).toEqual(["code", "message", "requestId"]);
        expect(foreignError).toEqual(await errorOf(absent));
        const text = JSON.stringify(foreignError);
        for (const leak of [conversationId, requestId, b.userId, "bob", "carol", "Prisma", "SELECT", "foreign key", "providerConversationUrl"]) {
          expect(text, `${key} 泄漏 ${leak}`).not.toContain(leak);
        }
      }

      // SSE 面:preflight 404 且不得先提交 event-stream 头
      const sse = await api(ctx, c, "GET", `/api/requests/${requestId}/events`, undefined, {
        ...PINNED,
        Accept: "text/event-stream",
      });
      expect(sse.status).toBe(404);
      expect(sse.headers.get("content-type") ?? "").not.toContain("text/event-stream");
      const sseMissing = await api(
        ctx,
        c,
        "GET",
        "/api/requests/00000000-0000-0000-0000-0000000000fe/events",
        undefined,
        { ...PINNED, Accept: "text/event-stream" },
      );
      expect(sseMissing.status).toBe(404);
      expect(await errorOf(sse)).toEqual(await errorOf(sseMissing));

      // 本人仍可读,且 public DTO 不含内部字段
      const mine = await bodyOf(ctx, b, `/api/requests/${requestId}`);
      const payload = JSON.stringify(mine);
      for (const internalField of ["providerConversationUrl", "requestFingerprint", "resolvedModelKey", "attemptCount", "userId"]) {
        expect(payload, internalField).not.toContain(internalField);
      }
    });
  });

  it("U3-OWN-02 Admin 对 REGISTERED 的每一条资源面都无旁路,运维能力仍在", async () => {
    await withApp(async (ctx) => {
      const b = await registered(ctx, "bob");
      const { conversationId, requestId } = await seedRequest(ctx, b, "B 的会话", "B 的提问", "k-own-02");
      const before = await fullSnapshot(ctx, b.userId);
      const actor = await admin(ctx);

      const reads: Array<[string, string]> = [
        ["GET", `/api/conversations/${conversationId}`],
        ["GET", `/api/conversations/${conversationId}/messages`],
        ["GET", `/api/requests/${requestId}`],
      ];
      for (const [method, path] of reads) {
        const res = await api(ctx, actor, method, path);
        expect(res.status, `Admin ${method} ${path}`).toBe(404);
      }
      // 写侧同样按普通 ownership:PATCH / DELETE / 代发 / 代取消
      expect((await api(ctx, actor, "PATCH", `/api/conversations/${conversationId}`, { title: "改掉" })).status).toBe(404);
      expect((await api(ctx, actor, "PATCH", `/api/conversations/${conversationId}`, { status: "ARCHIVED" })).status).toBe(404);
      expect((await api(ctx, actor, "PATCH", `/api/conversations/${conversationId}`, { preferredModelKey: "gemini-flash" })).status).toBe(404);
      expect((await api(ctx, actor, "DELETE", `/api/conversations/${conversationId}`)).status).toBe(404);
      expect((await send(ctx, actor, conversationId, "admin 代发", "k-admin-send")).status).toBe(404);
      expect((await api(ctx, actor, "POST", `/api/requests/${requestId}/cancel`)).status).toBe(404);

      // Admin 的列表里不能出现 B 的会话(它自己的 owner 是 ADMIN_USER_ID)
      expect(await conversationIds(ctx, actor)).toEqual([]);
      // 业务数据一行未动
      expect(await fullSnapshot(ctx, b.userId)).toEqual(before);
      expect(
        await ctx.prisma.message.count({ where: { conversationId } }),
      ).toBe(before.messages.length);
      // 冻结的运维能力仍然可用(证明 404 来自 ownership,不是 Admin 被整体降权)
      expect((await api(ctx, actor, "GET", "/api/admin/browser/status")).status).toBe(200);
      // B 自己照常可写
      expect(
        (await api(ctx, b, "PATCH", `/api/conversations/${conversationId}`, { title: "B 自己改" })).status,
      ).toBe(200);
    });
  });

  it("U3-OWN-03 logout → 新匿名看不到 → 重新登录历史回来(§28 核心 Gate)", async () => {
    await withApp(async (ctx) => {
      const b = await registered(ctx, "bob");
      const { conversationId, requestId } = await seedRequest(ctx, b, "持久化会话", "B 的提问", "k-own-03");
      const before = await fullSnapshot(ctx, b.userId);

      const logout = await api(ctx, b, "POST", "/api/auth/logout");
      expect(logout.status).toBe(204);
      expect(await ctx.prisma.session.findUnique({ where: { tokenHash: hashSessionToken(tokenOf(b.cookie)) } })).toBeNull();
      expect((await api(ctx, b, "GET", `/api/conversations/${conversationId}`)).status).toBe(401);

      // 退出后按产品语义 bootstrap 一个全新匿名身份:看不到 B 的任何数据
      const fresh = await anonymous(ctx);
      expect(fresh.userId).not.toBe(b.userId);
      expect(await conversationIds(ctx, fresh)).toEqual([]);
      expect((await api(ctx, fresh, "GET", `/api/conversations/${conversationId}`)).status).toBe(404);
      expect((await api(ctx, fresh, "GET", `/api/requests/${requestId}`)).status).toBe(404);
      // B 的业务数据在退出期间一行未动,也没有被迁走或删除
      expect(await fullSnapshot(ctx, b.userId)).toEqual(before);
      expect(await ctx.prisma.conversation.count({ where: { userId: fresh.userId } })).toBe(0);

      // 重新登录 B ⇒ 历史原样回来(用户名+口令即账号可恢复)
      const again = await device(ctx, "bob");
      expect(again.userId).toBe(b.userId);
      expect(await conversationIds(ctx, again)).toEqual([conversationId]);
      expect((await api(ctx, again, "GET", `/api/requests/${requestId}`)).status).toBe(200);
      expect(await fullSnapshot(ctx, b.userId)).toEqual(before);
    });
  });

  it("U3-OWN-04 三 Session 改密:当前设备换发、其它设备退出、数据不动,旧口令被拒", async () => {
    await withApp(async (ctx) => {
      const b1 = await registered(ctx, "bob");
      const b2 = await device(ctx, "bob");
      const b3 = await device(ctx, "bob");
      expect(b2.userId).toBe(b1.userId);
      expect(b3.userId).toBe(b1.userId);
      const { conversationId } = await seedRequest(ctx, b1, "改密前的会话", "提问", "k-own-04");
      const before = await fullSnapshot(ctx, b1.userId);
      expect(before.conversations).toHaveLength(1);

      const changed = await api(
        ctx,
        b1,
        "POST",
        "/api/auth/password/change",
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      );
      expect(changed.status).toBe(200);
      const rotated = cookieOf(changed);

      // 旧 B1 token 失效,新 token 有效;B2/B3 全部失效
      expect((await api(ctx, b1, "GET", `/api/conversations/${conversationId}`)).status).toBe(401);
      expect((await api(ctx, { cookie: rotated, userId: b1.userId }, "GET", `/api/conversations/${conversationId}`)).status).toBe(200);
      for (const stale of [b2, b3]) {
        expect((await api(ctx, stale, "GET", `/api/conversations/${conversationId}`)).status).toBe(401);
        expect(await ctx.prisma.session.findUnique({ where: { tokenHash: hashSessionToken(tokenOf(stale.cookie)) } })).toBeNull();
      }
      // 业务数据零修改
      expect(await fullSnapshot(ctx, b1.userId)).toEqual(before);

      // 旧口令登录被拒,新口令登录历史可见
      const withOld = await api(ctx, { cookie: "", userId: "" }, "POST", "/api/auth/user/login", {
        username: "bob",
        password: PASSWORD,
      });
      expect(withOld.status).toBe(401);
      expect((await errorOf(withOld)).code).toBe(ErrorCodes.AUTH_INVALID_CREDENTIALS);
      const withNew = await device(ctx, "bob", NEW_PASSWORD);
      expect(withNew.userId).toBe(b1.userId);
      expect(await conversationIds(ctx, withNew)).toEqual([conversationId]);
    });
  });

  it("U3-OWN-05 自助 revoke-all 后 B 数据完好,C/Admin Session 与 B 重新登录都不受影响", async () => {
    await withApp(async (ctx) => {
      const b1 = await registered(ctx, "bob");
      const b2 = await device(ctx, "bob");
      const c = await registered(ctx, "carol", OTHER);
      const cDevice = await device(ctx, "carol", OTHER);
      const adm = await admin(ctx);
      const { conversationId } = await seedRequest(ctx, b1, "撤销前会话", "提问", "k-own-05");
      const before = await fullSnapshot(ctx, b1.userId);

      const res = await api(ctx, b1, "POST", "/api/auth/sessions/revoke-all");
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { data: { revoked: number } };
      expect(payload.data.revoked).toBe(2);

      expect(await ctx.prisma.session.count({ where: { userId: b1.userId } })).toBe(0);
      expect(await fullSnapshot(ctx, b1.userId)).toEqual(before);
      // 别人的 Session 一条都没被牵连
      expect((await api(ctx, c, "GET", "/api/conversations")).status).toBe(200);
      expect((await api(ctx, cDevice, "GET", "/api/conversations")).status).toBe(200);
      expect((await api(ctx, adm, "GET", "/api/admin/browser/status")).status).toBe(200);
      // B 重新登录仍能看到自己的历史
      const back = await device(ctx, "bob");
      expect(await conversationIds(ctx, back)).toEqual([conversationId]);
    });
  });

  it("U3-OWN-06 DISABLED 注册账号在业务面一律 401 AUTH_REQUIRED(与 Auth 面的 AUTH_USER_DISABLED 不混淆)", async () => {
    await withApp(async (ctx) => {
      const d = await registered(ctx, "dave");
      const { conversationId, requestId } = await seedRequest(ctx, d, "D 的会话", "提问", "k-own-06");
      await ctx.prisma.user.update({ where: { id: d.userId }, data: { status: "DISABLED" } });

      const surfaces: Array<[string, string, unknown?]> = [
        ["GET", `/api/conversations/${conversationId}`],
        ["GET", "/api/conversations"],
        ["GET", `/api/conversations/${conversationId}/messages`],
        ["GET", `/api/requests/${requestId}`],
        ["POST", `/api/requests/${requestId}/cancel`],
        ["PATCH", `/api/conversations/${conversationId}`, { title: "禁用后改名" }],
        ["DELETE", `/api/conversations/${conversationId}`],
        ["GET", `/api/requests/${requestId}/events`],
      ];
      for (const [method, path, body] of surfaces) {
        const res = await api(ctx, d, method, path, body, method === "GET" && path.endsWith("/events") ? { Accept: "text/event-stream" } : {});
        expect(res.status, `DISABLED ${method} ${path}`).toBe(401);
        expect((await errorOf(res)).code, `${method} ${path}`).toBe(ErrorCodes.AUTH_REQUIRED);
      }
      // 与「完全没有身份」不可区分(middleware 刻意同码)
      const unauth = await api(ctx, { cookie: "", userId: "" }, "GET", `/api/conversations/${conversationId}`, undefined, PINNED);
      const disabled = await api(ctx, d, "GET", `/api/conversations/${conversationId}`, undefined, PINNED);
      expect(disabled.status).toBe(unauth.status);
      expect(await errorOf(disabled)).toEqual(await errorOf(unauth));
      // 数据仍在,只是身份失效
      expect(await ctx.prisma.conversation.findUnique({ where: { id: conversationId } })).not.toBeNull();

      // Auth credential 面按 U2 冻结给更精确的码,两类 surface 不混
      expect((await api(ctx, d, "POST", "/api/auth/password/change", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(401);
      expect((await errorOf(await api(ctx, d, "POST", "/api/auth/sessions/revoke-all"))).code).toBe(ErrorCodes.AUTH_USER_DISABLED);
      const loginDisabled = await api(ctx, { cookie: "", userId: "" }, "POST", "/api/auth/user/login", {
        username: "dave",
        password: PASSWORD,
      });
      expect(loginDisabled.status).toBe(401);
      expect((await errorOf(loginDisabled)).code).toBe(ErrorCodes.AUTH_INVALID_CREDENTIALS);
    });
  });

  it("U3-OWN-07 DISABLED 不能借 /auth/anonymous 绕过(COVERED BY EXISTING REG-12)", async () => {
    await withApp(async (ctx) => {
      const d = await registered(ctx, "dave");
      await ctx.prisma.user.update({ where: { id: d.userId }, data: { status: "DISABLED" } });
      const res = await api(ctx, d, "POST", "/api/auth/anonymous");
      expect(res.status).toBe(401);
      expect((await errorOf(res)).code).toBe(ErrorCodes.AUTH_REQUIRED);
      // 不新建身份、不覆盖 Cookie:库里 User 集合与 Cookie 都未变化
      expect(await ctx.prisma.user.count({ where: { id: { notIn: [ADMIN_USER_ID, COMPAT_USER_ID] } } })).toBe(1);
      expect(res.headers.getSetCookie()).toHaveLength(0);
      expect(await ctx.prisma.session.count({ where: { userId: d.userId } })).toBe(1);
    });
  });

  it("U3-OWN-08 Session 不是 owner:一条设备 logout 后另一条仍拥有全部 B 数据", async () => {
    await withApp(async (ctx) => {
      const b1 = await registered(ctx, "bob");
      const b2 = await device(ctx, "bob");
      const { conversationId, requestId } = await seedRequest(ctx, b1, "共享会话", "提问", "k-own-08");

      const logout = await api(ctx, b1, "POST", "/api/auth/logout");
      expect(logout.status).toBe(204);
      expect((await api(ctx, b1, "GET", `/api/conversations/${conversationId}`)).status).toBe(401);

      // 另一台设备完全不受影响:列表、详情、历史、请求读取与取消权都在
      expect(await conversationIds(ctx, b2)).toEqual([conversationId]);
      expect((await api(ctx, b2, "GET", `/api/conversations/${conversationId}`)).status).toBe(200);
      expect((await api(ctx, b2, "GET", `/api/conversations/${conversationId}/messages`)).status).toBe(200);
      expect((await api(ctx, b2, "GET", `/api/requests/${requestId}`)).status).toBe(200);
      expect((await api(ctx, b2, "POST", `/api/requests/${requestId}/cancel`)).status).toBe(200);
      expect(
        (await ctx.prisma.modelRequest.findUnique({ where: { id: requestId } }))!.status,
      ).toBe("CANCELLED");
      // 只删掉了这一条 Session
      expect(await ctx.prisma.session.count({ where: { userId: b1.userId } })).toBe(1);
    });
  });

  it("U3-OWN-09/10 配额与公平的身份维度是 userId:同 User 两 Session 只占一个公平槽,在飞不超一档,执行按用户轮转", async () => {
    // 每次执行在「回答即将返回」这一刻抓一张调度快照:serial drain 下这就是在飞状态的唯一可观测点
    let schedulerRef: RequestScheduler | null = null;
    const inFlight: Array<ReturnType<RequestScheduler["snapshotQueue"]>> = [];
    const adapter = new FakeGeminiAdapter({
      conversationUrls: [
        "https://gemini.google.com/app/u3000000000001",
        "https://gemini.google.com/app/u3000000000002",
        "https://gemini.google.com/app/u3000000000003",
      ],
      beforeAnswer: async () => {
        if (schedulerRef !== null) inFlight.push(schedulerRef.snapshotQueue());
      },
    });

    await withApp(
      async (ctx) => {
        const scheduler = ctx.scheduler!;
        schedulerRef = scheduler;
        const b1 = await registered(ctx, "bob");
        const b2 = await device(ctx, "bob");
        const c = await registered(ctx, "carol", OTHER);
        expect(b2.userId).toBe(b1.userId);

        await seedRequest(ctx, b1, "b1", "B-first", "k-fair-b1");
        await seedRequest(ctx, b2, "b2", "B-second", "k-fair-b2");
        await seedRequest(ctx, c, "c1", "C-first", "k-fair-c1");

        // 派发之前:公平结构已经是「每用户一项」,B 的两条只在 perUser 队列里排第二
        const queued = scheduler.snapshotQueue();
        expect(queued.readyUsers.filter((u) => u === b1.userId)).toHaveLength(1);
        expect(queued.perUser[b1.userId]).toHaveLength(2);
        expect(queued.perUser[c.userId]).toHaveLength(1);

        await scheduler.runOnce();

        // 每条 Request 执行期间,该 User 名下在飞恒 ≤1(两个 Session 不会各占一格)
        expect(inFlight).toHaveLength(3);
        for (const snap of inFlight) {
          expect(snap.current, "执行中 current 必须非空").not.toBeNull();
          expect(snap.activeByUser[snap.current!.userId] ?? 0).toBe(1);
          for (const userId of [b1.userId, c.userId]) {
            expect(snap.activeByUser[userId] ?? 0).toBeLessThanOrEqual(1);
          }
        }
        // 执行次序 = userId 轮转:B 不能因为有两个 Session 就连吃两条
        expect(adapter.runCalls.map((call) => call.prompt)).toEqual([
          "B-first",
          "C-first",
          "B-second",
        ]);
        // 收尾:队列空,不残留任何在飞计数
        const done = scheduler.snapshotQueue();
        expect(done.current).toBeNull();
        expect(done.activeByUser).toEqual({});
        expect(done.readyUsers).toEqual([]);
      },
      { scheduler: { autoStart: false }, adapter, abuse: { chatSubmitRatePerMinute: 10_000 } },
    );
  });

  it("U3-LIST-01 title/status/preferredModelKey 完全相同时,B 的列表也只见自己的", async () => {
    await withApp(async (ctx) => {
      const b = await registered(ctx, "bob");
      const c = await registered(ctx, "carol", OTHER);
      const adm = await admin(ctx);
      const anon = await anonymous(ctx);
      const actors = [b, c, adm, anon];
      const ids: string[] = [];
      for (const actor of actors) {
        // 四条会话的 title / status / preferredModelKey 逐字段相同 ⇒ 唯一区分只能是 owner
        const id = await newConversation(ctx, actor, { title: "同名会话" });
        const patched = await api(
          ctx,
          actor,
          "PATCH",
          `/api/conversations/${id}`,
          { status: "ACTIVE", preferredModelKey: null },
        );
        expect(patched.status).toBe(200);
        ids.push(id);
      }

      const snapshots = await Promise.all(
        actors.map(async (actor) => ({
          ids: await ctx.prisma.conversation.findMany({
            where: { userId: actor.userId },
            select: { id: true },
          }),
        })),
      );
      expect(snapshots.map((s) => s.ids.map((c) => c.id).sort())).toEqual(
        ids.map((id) => [id]),
      );

      const listed = await conversationIds(ctx, b);
      expect(listed).toEqual([ids[0]]);
      const cListed = await conversationIds(ctx, c);
      expect(cListed).toEqual([ids[1]]);
      expect(cListed).not.toContain(ids[0]!);
      // 归档维度同样只按 owner 过滤
      const archived = await api(ctx, b, "GET", "/api/conversations?status=ARCHIVED");
      expect((await archived.json()).data).toEqual([]);
    });
  });

  it("U3-SEND-01 跨用户代发 404:零 Message、零 Request、零附件占位、不消耗目标用户额度", async () => {
    await withApp(
      async (ctx) => {
        const b = await registered(ctx, "bob");
        const c = await registered(ctx, "carol", OTHER);
        const conversationId = await newConversation(ctx, b, { title: "B 的会话" });
        const before = await fullSnapshot(ctx, b.userId);
        const storeBefore = ctx.attachmentStore.stats();
        // 额度只有 1 格:被拒的代发若消耗了 B 的额度,下面 B 自己的发送就会 429
        const res = await send(
          ctx,
          c,
          conversationId,
          "越权代发",
          "k-inject-1",
          {},
          [attachment()],
        );
        expect(res.status).toBe(404);
        expect((await errorOf(res)).code).toBe(ErrorCodes.CONVERSATION_NOT_FOUND);

        expect(await fullSnapshot(ctx, b.userId)).toEqual(before);
        const storeAfter = ctx.attachmentStore.stats();
        expect(storeAfter.slotCount).toBe(storeBefore.slotCount);
        expect(storeAfter.liveBytes).toBe(storeBefore.liveBytes);
        expect(ctx.rateLimits.chatSubmit.keyCount()).toBeLessThanOrEqual(1);

        // B 本人的额度未被越权请求吃掉
        expect((await send(ctx, b, conversationId, "B 自己发", "k-inject-2")).status).toBe(202);
        // 越权方自己的列表也不会多出这条会话
        expect(await conversationIds(ctx, c)).toEqual([]);
      },
      { abuse: { chatSubmitRatePerMinute: 1 } },
    );
  });

  it("U3-REG-01 注册升级:Messages 与 Requests 也逐行不变(不止 Conversation)", async () => {
    await withApp(async (ctx) => {
      const y = await anonymous(ctx);
      const { conversationId, requestId } = await seedRequest(
        ctx,
        y,
        "Y1",
        "Y 的提问",
        "k-reg-full",
      );
      await seedRequest(ctx, y, "Y2", "Y 的第二问", "k-reg-full-2");
      const before = await fullSnapshot(ctx, y.userId);
      expect(before.conversations).toHaveLength(2);
      expect(before.messages.length).toBeGreaterThanOrEqual(4);
      expect(before.requests).toHaveLength(2);

      const cookie = cookieOf(await api(ctx, y, "POST", "/api/auth/register", {
        username: "yuki",
        password: PASSWORD,
      }));
      const upgraded = { cookie, userId: y.userId };

      expect(await fullSnapshot(ctx, y.userId)).toEqual(before);
      const stillMine = await api(ctx, upgraded, "GET", `/api/requests/${requestId}`);
      expect(stillMine.status).toBe(200);
      expect((await stillMine.json()) as unknown).toHaveProperty("data");
      expect([...(await conversationIds(ctx, upgraded))].sort()).toEqual(
        before.conversations.map((c) => c.id).sort(),
      );
      const user = await ctx.prisma.user.findUnique({ where: { id: y.userId } });
      expect(user!.type).toBe("REGISTERED");
      expect(user!.id).toBe(y.userId);
    });
  });

  it("U3-OWNER-KEY-01 username 与 sessionId 都不是 ownership 键", async () => {
    await withApp(async (ctx) => {
      const b = await registered(ctx, "bob");
      const { conversationId } = await seedRequest(ctx, b, "归属会话", "提问", "k-owner-key");
      const before = await fullSnapshot(ctx, b.userId);
      const sessionsBefore = await ctx.prisma.session.findMany({
        where: { userId: b.userId },
        orderBy: { id: "asc" },
      });

      // 产品没有改用户名的 API,这里按任务书 §41 只在 DB 层动展示名与归一化名
      await ctx.prisma.user.update({
        where: { id: b.userId },
        data: { username: "Renamed", usernameNormalized: "renamed" },
      });
      expect(await fullSnapshot(ctx, b.userId)).toEqual(before);
      expect(await conversationIds(ctx, b)).toEqual([conversationId]);
      // 撤销全部 Session(owner 键消失)后,业务数据仍完整归属同一 User
      await ctx.prisma.session.deleteMany({ where: { userId: b.userId } });
      expect(await ctx.prisma.session.count({ where: { userId: b.userId } })).toBe(0);
      expect(await fullSnapshot(ctx, b.userId)).toEqual(before);
      expect(
        await ctx.prisma.conversation.count({ where: { userId: b.userId } }),
      ).toBe(before.conversations.length);
      // 归一化后的外键关系仍在 Session 之上,而不是业务表
      expect(sessionsBefore.length).toBe(1);
      const columns = await ctx.prisma.$queryRawUnsafe<
        Array<{ name: string }>
      >(`PRAGMA table_info('Conversation')`);
      const names = columns.map((c) => c.name);
      expect(names).toContain("userId");
      for (const forbidden of ["sessionId", "username", "usernameNormalized", "tokenHash"]) {
        expect(names, forbidden).not.toContain(forbidden);
      }
    });

    // 业务与调度实现里根本不存在这三个字段 ⇒ 它们没有机会成为 where 条件
    const scanned = [
      "src/modules/conversation",
      "src/modules/message",
      "src/modules/request",
      "src/modules/sse",
    ];
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) sources.push(full);
      }
    };
    for (const dir of scanned) walk(join(process.cwd(), dir));
    expect(sources.length).toBeGreaterThanOrEqual(15);
    for (const file of sources) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const forbidden of ["username", "usernameNormalized", "sessionId"]) {
        expect(code, `${file} 出现 ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("U3-SWITCH-01 匿名 X 登录为 B 之后,配额身份是 B 而不是 X", async () => {
    await withApp(
      async (ctx) => {
        const b = await registered(ctx, "bob");
        const conversation = await newConversation(ctx, b, { title: "B 的会话" });
        const x = await anonymous(ctx);
        // 额度 1 格:X 先用掉自己的那一格(键 = X.userId)
        expect((await send(ctx, x, await newConversation(ctx, x), "X 的提问", "k-switch-x")).status).toBe(202);
        // 此刻只有 X 用过额度:B 尚未提交 ⇒ 键集合里只有 X 一个
        expect(ctx.rateLimits.chatSubmit.keyCount()).toBe(1);

        // X 的 Cookie 登录为 B ⇒ 身份切换,后续提交按 B 的桶计
        const switched = { cookie: "", userId: "" };
        const login = await api(ctx, x, "POST", "/api/auth/user/login", {
          username: "bob",
          password: PASSWORD,
        });
        expect(login.status).toBe(200);
        switched.cookie = cookieOf(login);
        switched.userId = b.userId;

        // B 的额度是全新的:若仍按 X 记账,这一发就会 429
        expect((await send(ctx, switched, conversation, "B 的提问", "k-switch-b")).status).toBe(202);
        expect(await conversationIds(ctx, switched)).toEqual([conversation]);
        expect(ctx.rateLimits.chatSubmit.keyCount()).toBe(2);
        // X 的旧 Cookie 已被撤销(§31 首写删除),其数据一行未迁
        expect((await api(ctx, x, "GET", "/api/conversations")).status).toBe(401);
        expect(await ctx.prisma.conversation.count({ where: { userId: x.userId } })).toBe(1);
      },
      { abuse: { chatSubmitRatePerMinute: 1 } },
    );
  });
});
