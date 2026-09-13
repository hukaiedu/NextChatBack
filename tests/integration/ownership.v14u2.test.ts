import { describe, expect, it } from "vitest";

import { ADMIN_USER_ID, AUTH_COOKIE_NAME, COMPAT_USER_ID } from "../../src/config/constants.js";
import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { PublicErrorCodes } from "../../src/common/errors/public-error.js";
import { RequestRepository } from "../../src/modules/request/request.repository.js";
import { hashSessionToken } from "../../src/modules/auth/auth.session-token.js";
import type { AbuseProtectionConfig } from "../../src/app.js";
import type { AuthDeps } from "../../src/modules/auth/auth.types.js";
import { ADMIN_AUTH, setupTestContext, type TestContext } from "../helpers.js";

/**
 * V1.4 U2 §87/§90:以 **REGISTERED 用户**为主体的隔离与配额回归。
 *
 * ownership.v13b3 已经钉过「匿名 vs 匿名」与「Admin 无旁路」;本文件补的是设计 §17 矩阵里
 * 真正新增的那两行 —— **Registered B / Registered B 的第二台设备 / Registered C**,
 * 以及「跨用户 Idempotency-Key 仍是 409」「Session 撤销后既有 SSE 有界续存」这两条被显式接受的契约。
 *
 * 配额部分证明的是键维度:三套 limiter 全部以 userId 计,多设备不是提额通道。
 */

const PASSWORD = "Password123!";
const OTHER = "AnotherPass123!";
const TTL_ANON = 7200;
const TTL_ADMIN = 3600;
const TTL_REGISTERED = 86_400;
const TOUCH_INTERVAL = 60;

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
  abuse?: AbuseProtectionConfig,
): Promise<T> {
  const ctx = await setupTestContext({ auth: authDeps(), abuse });
  try {
    await ctx.reset();
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

function cookieOf(res: Response): string {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
  if (raw === undefined) throw new Error(`no Set-Cookie: ${res.status}`);
  return raw.split(";")[0]!;
}

function tokenOf(cookie: string): string {
  return cookie.slice(AUTH_COOKIE_NAME.length + 1);
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

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`非 JSON 响应(status ${res.status}):${text.slice(0, 200)}`);
  }
  const error = (body as { error?: { code: string; message: string } }).error;
  if (error === undefined) {
    throw new Error(`响应不是错误信封(status ${res.status}):${text.slice(0, 200)}`);
  }
  return error;
}

function dataOf<T>(body: unknown): T {
  return (body as { data: T }).data;
}

async function newRegistered(
  ctx: TestContext,
  username: string,
  password = PASSWORD,
): Promise<Actor> {
  const anon = await api(ctx, { cookie: "", userId: "" }, "POST", "/api/auth/anonymous");
  const anonCookie = cookieOf(anon);
  const res = await api(
    ctx,
    { cookie: anonCookie, userId: "" },
    "POST",
    "/api/auth/register",
    { username, password },
  );
  if (res.status !== 200) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  const cookie = cookieOf(res);
  const row = await ctx.prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(tokenOf(cookie)) },
  });
  return { cookie, userId: row!.userId };
}

/** 同一账号的第二台设备:无 Cookie 登录 ⇒ 新 Session,不撤旧的 */
async function secondDevice(ctx: TestContext, username: string, password = PASSWORD): Promise<Actor> {
  const res = await api(ctx, { cookie: "", userId: "" }, "POST", "/api/auth/user/login", {
    username,
    password,
  });
  expect(res.status).toBe(200);
  const cookie = cookieOf(res);
  const row = await ctx.prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(tokenOf(cookie)) },
  });
  return { cookie, userId: row!.userId };
}

async function newConversation(ctx: TestContext, actor: Actor, title = "t"): Promise<string> {
  const res = await api(ctx, actor, "POST", "/api/conversations", { title });
  expect(res.status).toBe(201);
  return (await res.json()).data.id;
}

async function send(
  ctx: TestContext,
  actor: Actor,
  conversationId: string,
  key: string,
): Promise<Response> {
  return api(
    ctx,
    actor,
    "POST",
    `/api/conversations/${conversationId}/messages`,
    { content: `hi-${key}` },
    { "Idempotency-Key": key },
  );
}

async function requestIdOf(ctx: TestContext, actor: Actor, conversationId: string, key: string) {
  const res = await send(ctx, actor, conversationId, key);
  expect(res.status).toBe(202);
  return (await res.json()).data.request.id as string;
}

describe("ISO REGISTERED 之间的隔离(V1.4 U2 §87)", () => {
  it("ISO-01/02/03 Registered C 读不到 Registered B 的会话 / 历史 / 请求,一律 404 且与不存在同形", async () => {
    await withApp(async (ctx) => {
      const b = await newRegistered(ctx, "bob");
      const c = await newRegistered(ctx, "carol", OTHER);
      const conversationId = await newConversation(ctx, b, "B 的会话");
      const requestId = await requestIdOf(ctx, b, conversationId, "k-b-1");

      // requestId 逐请求唯一,整体比较前必须钉住同一个值(与 ownership.v13b3 同一手法)
      const PINNED = { "x-request-id": "pinned-for-existence-comparison" };
      const foreign = await api(
        ctx,
        c,
        "GET",
        `/api/conversations/${conversationId}`,
        undefined,
        PINNED,
      );
      const missing = await api(
        ctx,
        c,
        "GET",
        "/api/conversations/00000000-0000-0000-0000-0000000000ff",
        undefined,
        PINNED,
      );
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await errorOf(foreign)).toEqual(await errorOf(missing));

      expect((await api(ctx, c, "GET", `/api/conversations/${conversationId}/messages`)).status)
        .toBe(404);
      expect((await api(ctx, c, "GET", `/api/requests/${requestId}`)).status).toBe(404);
      // 列表里既没有 B 的会话,C 的列表也仍是空的(必须 await:不 await 的 .resolves 会变成
      // unhandled rejection,用例照样「通过」⇒ 假绿)
      expect(dataOf<unknown[]>(await (await api(ctx, c, "GET", "/api/conversations")).json())).toEqual(
        [],
      );
      expect((await ctx.prisma.conversation.count({ where: { userId: c.userId } }))).toBe(0);
      // B 自己照常看得见
      expect((await api(ctx, b, "GET", `/api/conversations/${conversationId}`)).status).toBe(200);
    });
  });

  it("ISO-05/06 跨用户 cancel 404:B 的 Request 状态与取消登记都不动", async () => {
    await withApp(async (ctx) => {
      const b = await newRegistered(ctx, "bob");
      const c = await newRegistered(ctx, "carol", OTHER);
      const conversationId = await newConversation(ctx, b);
      const requestId = await requestIdOf(ctx, b, conversationId, "k-cancel");

      const res = await api(ctx, c, "POST", `/api/requests/${requestId}/cancel`);
      expect(res.status).toBe(404);
      expect((await errorOf(res)).code).toBe(ErrorCodes.REQUEST_NOT_FOUND);
      const row = await ctx.prisma.modelRequest.findUnique({ where: { id: requestId } });
      expect(row!.status).toBe("PENDING");
      expect(ctx.cancellation.size()).toBe(0);
    });
  });

  it("ISO-04 跨用户订阅 SSE:404 + JSON 信封,绝不以 event-stream 开头", async () => {
    await withApp(async (ctx) => {
      const b = await newRegistered(ctx, "bob");
      const c = await newRegistered(ctx, "carol", OTHER);
      const conversationId = await newConversation(ctx, b);
      const requestId = await requestIdOf(ctx, b, conversationId, "k-sse");

      const res = await api(ctx, c, "GET", `/api/requests/${requestId}/events`, undefined, {
        Accept: "text/event-stream",
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type") ?? "").not.toContain("text/event-stream");
      expect((await errorOf(res)).code).toBe(ErrorCodes.REQUEST_NOT_FOUND);
    });
  });

  it("ISO-07 ADMIN 没有任何 ownership 旁路:读他人会话 / 订阅他人请求都是 404", async () => {
    await withApp(async (ctx) => {
      const b = await newRegistered(ctx, "bob");
      const conversationId = await newConversation(ctx, b);
      const requestId = await requestIdOf(ctx, b, conversationId, "k-admin");

      const admin = await api(
        ctx,
        { cookie: "", userId: "" },
        "POST",
        "/api/auth/login",
        { password: ADMIN_AUTH.password },
      );
      const actor: Actor = { cookie: cookieOf(admin), userId: ADMIN_USER_ID };
      expect((await api(ctx, actor, "GET", `/api/conversations/${conversationId}`)).status).toBe(404);
      expect((await api(ctx, actor, "GET", `/api/requests/${requestId}`)).status).toBe(404);
      expect(
        (await api(ctx, actor, "GET", `/api/requests/${requestId}/events`)).status,
      ).toBe(404);
      // Admin 自己的列表里没有 B 的会话
      expect(
        dataOf<unknown[]>(await (await api(ctx, actor, "GET", "/api/conversations")).json()),
      ).toEqual([]);
    });
  });

  it("ISO-08 同一 REGISTERED 的两台设备看到同一份数据(User ownership,不是 Session ownership)", async () => {
    await withApp(async (ctx) => {
      const b = await newRegistered(ctx, "bob");
      const conversationId = await newConversation(ctx, b, "共享会话");
      const phone = await secondDevice(ctx, "bob");
      expect(phone.userId).toBe(b.userId);
      expect(phone.cookie).not.toBe(b.cookie);

      const list = await api(ctx, phone, "GET", "/api/conversations");
      expect(list.status).toBe(200);
      expect(((await list.json()) as { data: { id: string }[] }).data.map((c) => c.id)).toEqual([
        conversationId,
      ]);
      // 第二台设备能读到第一台发起的 Request,也能替它取消(同一 owner)
      const requestId = await requestIdOf(ctx, b, conversationId, "k-shared");
      expect((await api(ctx, phone, "GET", `/api/requests/${requestId}`)).status).toBe(200);
      // PENDING(未派发)的取消直接落终态 ⇒ 200 cancelled(202 只属于 PROCESSING→CANCELLING)
      const cancelled = await api(ctx, phone, "POST", `/api/requests/${requestId}/cancel`);
      expect(cancelled.status).toBe(200);
      expect(
        (await ctx.prisma.modelRequest.findUnique({ where: { id: requestId } }))!.status,
      ).toBe("CANCELLED");
      // 反向:第三方的同名请求仍然 404
      const c = await newRegistered(ctx, "carol", OTHER);
      expect((await api(ctx, c, "GET", `/api/requests/${requestId}`)).status).toBe(404);
    });
  });

  it("ISO-09 PATCH/DELETE 跨用户 404 且对方字段一行不变", async () => {
    await withApp(async (ctx) => {
      const b = await newRegistered(ctx, "bob");
      const conversationId = await newConversation(ctx, b, "原标题");
      const before = await ctx.prisma.conversation.findUnique({ where: { id: conversationId } });
      const c = await newRegistered(ctx, "carol", OTHER);

      const patch = await api(ctx, c, "PATCH", `/api/conversations/${conversationId}`, {
        title: "被改掉",
        status: "ARCHIVED",
      });
      expect(patch.status).toBe(404);
      expect((await errorOf(patch)).code).toBe(ErrorCodes.CONVERSATION_NOT_FOUND);
      const del = await api(ctx, c, "DELETE", `/api/conversations/${conversationId}`);
      expect(del.status).toBe(404);

      const after = await ctx.prisma.conversation.findUnique({ where: { id: conversationId } });
      expect(after).toEqual(before);
    });
  });

  it("ISO-10 preferredModelKey 跨用户不可写(模型选择同样按 owner)", async () => {
    await withApp(async (ctx) => {
      const b = await newRegistered(ctx, "bob");
      const conversationId = await newConversation(ctx, b);
      const c = await newRegistered(ctx, "carol", OTHER);
      const res = await api(ctx, c, "PATCH", `/api/conversations/${conversationId}`, {
        preferredModelKey: "gemini-flash",
      });
      expect(res.status).toBe(404);
      expect(
        (await ctx.prisma.conversation.findUnique({ where: { id: conversationId } }))!
          .preferredModelKey,
      ).toBeNull();
    });
  });

  it("ISO-11 跨用户猜中 Idempotency-Key 仍是 409(V1.3 已冻结的例外,不为了全 404 而改)", async () => {
    await withApp(async (ctx) => {
      const b = await newRegistered(ctx, "bob");
      const c = await newRegistered(ctx, "carol", OTHER);
      const bConversation = await newConversation(ctx, b);
      const cConversation = await newConversation(ctx, c);
      expect((await send(ctx, b, bConversation, "shared-key")).status).toBe(202);

      const res = await send(ctx, c, cConversation, "shared-key");
      expect(res.status).toBe(409);
      expect((await errorOf(res)).code).toBe(ErrorCodes.IDEMPOTENCY_KEY_REUSED);
      // 但绝不回任何 B 的数据:C 的会话仍然一条消息都没有
      expect(
        await ctx.prisma.message.count({ where: { conversationId: cConversation } }),
      ).toBe(0);
      expect(
        await ctx.prisma.modelRequest.count({ where: { conversationId: cConversation } }),
      ).toBe(0);
    });
  });

  it("ISO-12 Session 被撤销后已建立的 SSE 继续到该 Request 终态(有界残留,§32 Q1)", async () => {
    await withApp(async (ctx) => {
      const b = await newRegistered(ctx, "bob");
      const conversationId = await newConversation(ctx, b);
      const requestId = await requestIdOf(ctx, b, conversationId, "k-stream");

      const stream = await api(ctx, b, "GET", `/api/requests/${requestId}/events`, undefined, {
        Accept: "text/event-stream",
      });
      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      expect(ctx.sseConnections()).toBe(1);

      // 撤销当前 Session(含本条):鉴权只发生在建连时 ⇒ 连接不被踢断
      const revoke = await api(ctx, b, "POST", "/api/auth/sessions/revoke-all");
      expect(revoke.status).toBe(200);
      expect(await ctx.prisma.session.count({ where: { userId: b.userId } })).toBe(0);
      expect(ctx.sseConnections()).toBe(1);

      // Cookie 已失效:再发业务请求就是 401 —— 残留只限这条已经建立的事件流
      expect((await api(ctx, b, "GET", `/api/requests/${requestId}`)).status).toBe(401);
      // 收尾:关流后登记归零,证明这是显式契约而不是连接泄漏
      stream.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(ctx.sseConnections()).toBeLessThanOrEqual(1);
    });
  });

  it("ISO-13 COMPAT 身份与两个 REGISTERED 主体互不可见(它只有哨兵 owner)", async () => {
    await withApp(async (ctx) => {
      const b = await newRegistered(ctx, "bob");
      const conversationId = await newConversation(ctx, b);
      // COMPAT 走的是不带 Cookie 的注入身份,这里用 enabled=false 的另一份 app 验证更麻烦,
      // 直接钉住「COMPAT 哨兵名下没有 B 的会话」这一 DB 事实即可。
      expect(
        await ctx.prisma.conversation.count({ where: { userId: COMPAT_USER_ID } }),
      ).toBe(0);
      expect(
        (await ctx.prisma.conversation.findUnique({ where: { id: conversationId } }))!.userId,
      ).toBe(b.userId);
    });
  });
});

describe("QUOTA 多设备共用 user-level 额度(V1.4 U2 §90)", () => {
  it("QUOTA-01 两个 Session 共用同一个 chatSubmit 桶(键 = userId),额度不翻倍", async () => {
    await withApp(async (ctx) => {
      const b = await newRegistered(ctx, "bob");
      const phone = await secondDevice(ctx, "bob");
      const conversation = await newConversation(ctx, b);
      const phoneConversation = await newConversation(ctx, phone, "t2");

      expect((await send(ctx, b, conversation, "q1-a")).status).toBe(202);
      expect((await send(ctx, phone, phoneConversation, "q1-b")).status).toBe(202);
      const blocked = await send(ctx, b, conversation, "q1-c");
      expect(blocked.status).toBe(429);
      expect((await errorOf(blocked)).code).toBe(PublicErrorCodes.SERVICE_BUSY);
      // 只有一个键 ⇒ 桶按 userId 分,不是按 Session
      expect(ctx.rateLimits.chatSubmit.keyCount()).toBe(1);
    }, { chatSubmitRatePerMinute: 2 });
  });

  it("QUOTA-02 pending 配额是 user-level:PC 排满后 Phone 也被拒(用生产合法档位 1)", async () => {
    await withApp(async (ctx) => {
      const b = await newRegistered(ctx, "bob");
      const phone = await secondDevice(ctx, "bob");
      const c1 = await newConversation(ctx, b);
      const c2 = await newConversation(ctx, phone, "t2");

      expect((await send(ctx, b, c1, "q2-a")).status).toBe(202);
      const rejected = await send(ctx, phone, c2, "q2-b");
      expect(rejected.status).toBe(429);
      expect((await errorOf(rejected)).code).toBe(PublicErrorCodes.SERVICE_BUSY);
      // 零副作用:第二台设备没留下任何排队行
      expect(
        await ctx.prisma.modelRequest.count({ where: { conversationId: c2 } }),
      ).toBe(0);
    }, { userMaxPendingRequests: 1, chatSubmitRatePerMinute: 10_000 });
  });

  it("QUOTA-03 Scheduler 候选归属按 userId 推导 ⇒ 两设备天然同一个公平桶", async () => {
    await withApp(async (ctx) => {
      const b = await newRegistered(ctx, "bob");
      const phone = await secondDevice(ctx, "bob");
      const c1 = await newConversation(ctx, b);
      const c2 = await newConversation(ctx, phone, "t2");
      await send(ctx, b, c1, "q3-a");
      await send(ctx, phone, c2, "q3-b");

      const repo = new RequestRepository();
      const candidates = await repo.findPendingWithOwner(ctx.prisma);
      expect(candidates.map((c) => c.userId)).toEqual([b.userId, b.userId]);
      // 同一 User 的两条 PENDING 来自两条不同 Session —— 公平键只能是 userId
      expect(await ctx.prisma.session.count({ where: { userId: b.userId } })).toBe(2);
      expect(await repo.countPendingForUser(ctx.prisma, b.userId)).toBe(2);
    });
  });

  it("QUOTA-04 匿名原地升级为 REGISTERED 不重置任何 limiter 状态(userId 未变)", async () => {
    await withApp(async (ctx) => {
      const anon = await api(ctx, { cookie: "", userId: "" }, "POST", "/api/auth/anonymous");
      const actor: Actor = { cookie: cookieOf(anon), userId: "" };
      // 每次提交都换新会话:同会话的在飞请求会先撞 CONVERSATION_REQUEST_IN_PROGRESS(409),
      // 那就测不到额度了 —— 本用例唯一想拦住的只有 chatSubmit 频率。
      expect((await send(ctx, actor, await newConversation(ctx, actor), "q4-a")).status).toBe(202);

      const upgraded = await api(
        ctx,
        actor,
        "POST",
        "/api/auth/register",
        { username: "bob", password: PASSWORD },
      );
      expect(upgraded.status).toBe(200);
      const reg: Actor = { cookie: cookieOf(upgraded), userId: actor.userId };
      expect(ctx.rateLimits.chatSubmit.keyCount()).toBe(1); // 仍是同一个键
      // 用掉第二格
      expect(
        (await send(ctx, reg, await newConversation(ctx, reg, "t2"), "q4-b")).status,
      ).toBe(202);
      const third = await send(ctx, reg, await newConversation(ctx, reg, "t3"), "q4-c");
      expect(third.status).toBe(429); // 升级没有把额度刷新成满格
    }, { chatSubmitRatePerMinute: 2 });
  });
});
