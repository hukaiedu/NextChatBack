import { describe, expect, it, vi } from "vitest";

import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { ADMIN_USER_ID, AUTH_COOKIE_NAME, COMPAT_USER_ID } from "../../src/config/constants.js";
import { hashSessionToken } from "../../src/modules/auth/auth.session-token.js";
import type { AuthDeps } from "../../src/modules/auth/auth.types.js";
import { setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";
import { attachment } from "../attachment-fixtures.js";

/**
 * V1.3-B3-1:多用户 ownership / IDOR(§29..§36)。
 *
 * 身份一律走真实 HTTP:POST /api/auth/anonymous 拿独立 Cookie,再按 Session 行回读 userId,
 * 不在测试里手工伪造 req.auth —— 伪造只能证明 Service 写了 if,证明不了 Cookie 到 DB 这条链。
 *
 * 断言口径:跨用户访问必须与「资源不存在」同形(§9/§34)。响应含动态 requestId,
 * 所以这里用 x-request-id 透传(request-id.ts 会原样回显客户端提供的值)把两次请求的
 * requestId 钉成同一个,再整体深比较 —— 不是删掉 requestId 来凑一致。
 */

const PASSWORD = "test-password-123";
/** 与 auth.v13b2 同量级的短 TTL:本文件不测续期,只需要 Session 在用例内有效 */
const TTL_ANON = 7200;
const TTL_ADMIN = 3600;
/** V1.4 U2:REGISTERED 走自己那一档,与 anon/admin 取不同值 */
const TTL_REGISTERED = 86_400;
const TOUCH_INTERVAL = 60;

function authDeps(overrides: Partial<AuthDeps> = {}): AuthDeps {
  return {
    enabled: true,
    password: PASSWORD,
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
  auth: AuthDeps | null = authDeps(),
): Promise<T> {
  const ctx = await setupTestContext({ auth });
  try {
    await ctx.reset();
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

function cookieHeader(res: Response): string {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
  if (raw === undefined) {
    throw new Error("no session cookie in response");
  }
  return raw.split(";")[0]!;
}

function rawTokenOf(cookie: string): string {
  return cookie.slice(AUTH_COOKIE_NAME.length + 1);
}

/** 一次真实匿名进入:Cookie + 该 Cookie 背后的 userId(按 Session 行回读,不是猜的) */
interface Actor {
  cookie: string;
  userId: string;
}

async function newAnonymous(ctx: TestContext): Promise<Actor> {
  const res = await fetch(`${ctx.baseUrl}/api/auth/anonymous`, { method: "POST" });
  expect(res.status).toBe(200);
  const cookie = cookieHeader(res);
  const session = await ctx.prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(rawTokenOf(cookie)) },
  });
  return { cookie, userId: session!.userId };
}

async function newAdmin(ctx: TestContext): Promise<Actor> {
  const res = await fetch(`${ctx.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return { cookie: cookieHeader(res), userId: ADMIN_USER_ID };
}

/** COMPAT 模式(AUTH_ENABLED=false)没有 Cookie:身份固定为 COMPAT 哨兵行 */
const COMPAT_ACTOR: Actor = { cookie: "", userId: COMPAT_USER_ID };

type Body = Record<string, unknown> | undefined;

function headersOf(actor: Actor, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(actor.cookie === "" ? {} : { Cookie: actor.cookie }),
    ...extra,
  };
}

async function api(
  ctx: TestContext,
  actor: Actor,
  method: string,
  path: string,
  body: Body = undefined,
  extra: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: headersOf(
      actor,
      body === undefined ? extra : { "Content-Type": "application/json", ...extra },
    ),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createConversation(ctx: TestContext, actor: Actor, body: Body = {}): Promise<string> {
  const res = await api(ctx, actor, "POST", "/api/conversations", body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

async function send(
  ctx: TestContext,
  actor: Actor,
  conversationId: string,
  key: string,
  body: Body = { content: "hi" },
): Promise<Response> {
  return api(ctx, actor, "POST", `/api/conversations/${conversationId}/messages`, body, {
    "Idempotency-Key": key,
  });
}

interface ErrorEnvelope {
  error: { code: string; message: string; requestId: string };
}

async function errorOf(res: Response): Promise<ErrorEnvelope["error"]> {
  return ((await res.json()) as ErrorEnvelope).error;
}

/** §9/§34:两次请求的 404 必须整体同形 —— 同一个钉住的 requestId 下逐字段相等 */
const PINNED = { "x-request-id": "pinned-for-existence-comparison" };

describe("OWN-CONV Conversation 归属隔离(§6/§7/§8/§9/§29)", () => {
  it("OWN-CONV-01 创建写入当前用户;body 里的 userId 不参与 owner 判定", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      const b = await newAnonymous(ctx);

      const res = await api(
        ctx,
        a,
        "POST",
        "/api/conversations",
        { title: "attempted", userId: b.userId },
      );
      expect(res.status).toBe(201);
      const id = ((await res.json()) as { data: { id: string } }).data.id;

      const row = await ctx.prisma.conversation.findUnique({ where: { id } });
      expect(row!.userId).toBe(a.userId);
      expect(row!.userId).not.toBe(b.userId);
    });
  });

  it("OWN-CONV-02 列表只返回自己的会话;游标翻页也不会漏出他人同 status/同 updatedAt 的记录", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      const b = await newAnonymous(ctx);
      const aIds = [await createConversation(ctx, a), await createConversation(ctx, a)];
      for (let i = 0; i < 3; i += 1) {
        await createConversation(ctx, b);
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      for (;;) {
        const res = await api(
          ctx,
          a,
          "GET",
          `/api/conversations?status=ACTIVE&limit=1${cursor === null ? "" : `&cursor=${cursor}`}`,
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          data: Array<Record<string, unknown>>;
          meta: { nextCursor: string | null };
        };
        for (const item of body.data) {
          // §6(B3-2):userId 是内部字段,Public 列表项连键都不该有。
          // 归属判定因此改由数据库侧对最终 id 集合独立核对,HTTP 侧只证明不外泄。
          expect(Object.keys(item)).not.toContain("userId");
          seen.push(item.id as string);
        }
        cursor = body.meta.nextCursor;
        if (cursor === null) {
          break;
        }
      }
      const rows = await ctx.prisma.conversation.findMany({
        where: { id: { in: seen } },
        select: { userId: true },
      });
      expect(rows).toHaveLength(seen.length);
      expect(rows.every((row) => row.userId === a.userId)).toBe(true);
      expect(seen.sort()).toEqual(aIds.slice().sort());
    });
  });

  it("OWN-CONV-03 GET 自己的会话 200;他人的与不存在的 404 同形", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      const b = await newAnonymous(ctx);
      const ca = await createConversation(ctx, a);
      const cb = await createConversation(ctx, b);

      expect((await api(ctx, a, "GET", `/api/conversations/${ca}`)).status).toBe(200);

      const foreign = await api(ctx, a, "GET", `/api/conversations/${cb}`, undefined, PINNED);
      const missing = await api(
        ctx,
        a,
        "GET",
        "/api/conversations/00000000-0000-0000-0000-0000000000ff",
        undefined,
        PINNED,
      );
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await errorOf(foreign)).toEqual(await errorOf(missing));
    });
  });

  it("OWN-CONV-04 PATCH 跨用户 404,对方标题与状态分毫不动", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      const b = await newAnonymous(ctx);
      const cb = await createConversation(ctx, b, { title: "victim" });

      const res = await api(ctx, a, "PATCH", `/api/conversations/${cb}`, {
        title: "hijacked",
        status: "ARCHIVED",
      });
      expect(res.status).toBe(404);

      const row = await ctx.prisma.conversation.findUnique({ where: { id: cb } });
      expect(row!.title).toBe("victim");
      expect(row!.status).toBe("ACTIVE");
    });
  });

  it("OWN-CONV-05 DELETE 跨用户 404,对方不会被软删除", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      const b = await newAnonymous(ctx);
      const cb = await createConversation(ctx, b);

      expect((await api(ctx, a, "DELETE", `/api/conversations/${cb}`)).status).toBe(404);

      const row = await ctx.prisma.conversation.findUnique({ where: { id: cb } });
      expect(row!.status).toBe("ACTIVE");
      expect(row!.deletedAt).toBeNull();
    });
  });

  it("OWN-CONV-06 模型偏好跨用户 404,对方 preferredModelKey 不变(§19)", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      const b = await newAnonymous(ctx);
      const cb = await createConversation(ctx, b);
      await api(ctx, b, "PATCH", `/api/conversations/${cb}`, { preferredModelKey: "model-b" });

      const res = await api(ctx, a, "PATCH", `/api/conversations/${cb}`, {
        preferredModelKey: "model-a",
      });
      expect(res.status).toBe(404);
      const row = await ctx.prisma.conversation.findUnique({ where: { id: cb } });
      expect(row!.preferredModelKey).toBe("model-b");
    });
  });

  it("OWN-CONV-07 跨用户不泄露对方会话状态:DELETED 与 ARCHIVED 都是 404 CONVERSATION_NOT_FOUND(§21)", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      const b = await newAnonymous(ctx);
      const deleted = await createConversation(ctx, b);
      await api(ctx, b, "DELETE", `/api/conversations/${deleted}`);
      const archived = await createConversation(ctx, b);
      // 先证明 A 改不动 B 的会话状态,再由 B 自己归档
      expect(
        (await api(ctx, a, "PATCH", `/api/conversations/${archived}`, { status: "ARCHIVED" }))
          .status,
      ).toBe(404);
      await api(ctx, b, "PATCH", `/api/conversations/${archived}`, { status: "ARCHIVED" });

      for (const id of [deleted, archived]) {
        const read = await api(ctx, a, "GET", `/api/conversations/${id}`);
        expect(read.status).toBe(404);
        expect((await errorOf(read)).code).toBe(ErrorCodes.CONVERSATION_NOT_FOUND);

        const patch = await api(ctx, a, "PATCH", `/api/conversations/${id}`, { title: "x" });
        expect(patch.status).toBe(404);
        expect((await errorOf(patch)).code).toBe(ErrorCodes.CONVERSATION_NOT_FOUND);
      }

      // 本人读自己已归档的会话仍然可读(既有语义未被 owner 过滤改坏)
      expect((await api(ctx, b, "GET", `/api/conversations/${archived}`)).status).toBe(200);
    });
  });
});

describe("OWN-MSG Message 历史与发送(§11/§12/§30)", () => {
  it("OWN-MSG-01 跨用户读历史 404,不是 200 空页", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      const b = await newAnonymous(ctx);
      const cb = await createConversation(ctx, b);
      expect((await send(ctx, b, cb, "k-b")).status).toBe(202);

      const foreign = await api(ctx, a, "GET", `/api/conversations/${cb}/messages`, undefined, PINNED);
      const missing = await api(
        ctx,
        a,
        "GET",
        "/api/conversations/00000000-0000-0000-0000-0000000000ff/messages",
        undefined,
        PINNED,
      );
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await errorOf(foreign)).toEqual(await errorOf(missing));

      // 对照:自己的空会话是 200 + 空数组
      const ca = await createConversation(ctx, a);
      const own = await api(ctx, a, "GET", `/api/conversations/${ca}/messages`);
      expect(own.status).toBe(200);
      expect(((await own.json()) as { data: unknown[] }).data).toEqual([]);
    });
  });

  it("OWN-MSG-02 跨用户发送:404 且对方 Message/Request、附件槽、Scheduler notify 零新增(§12)", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      const b = await newAnonymous(ctx);
      const cb = await createConversation(ctx, b);
      const before = {
        messages: await ctx.prisma.message.count(),
        requests: await ctx.prisma.modelRequest.count(),
      };
      const notify = vi.spyOn(ctx.scheduler!, "notify");

      const res = await send(ctx, a, cb, "k-intrude", { content: "into yours" });
      expect(res.status).toBe(404);
      expect((await errorOf(res)).code).toBe(ErrorCodes.CONVERSATION_NOT_FOUND);

      expect(await ctx.prisma.message.count()).toBe(before.messages);
      expect(await ctx.prisma.modelRequest.count()).toBe(before.requests);
      expect(ctx.attachmentStore.stats().slotCount).toBe(0);
      // 404 发生在门控,根本没走到 notify:对方的执行队列不会被陌生人唤醒
      expect(notify).not.toHaveBeenCalled();
    });
  });

  it("OWN-MSG-03 跨用户带图发送:404、无 Request、附件槽零残留", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      const b = await newAnonymous(ctx);
      const cb = await createConversation(ctx, b);
      const img = attachment("image/png", 4096);

      const res = await send(ctx, a, cb, "k-intrude-img", { content: "", attachments: [img] });
      expect(res.status).toBe(404);

      expect(await ctx.prisma.modelRequest.count()).toBe(0);
      expect(await ctx.prisma.message.count()).toBe(0);
      expect(ctx.attachmentStore.stats().slotCount).toBe(0);
      expect(ctx.attachmentStore.stats().liveBytes).toBe(0);
    });
  });

  it("OWN-MSG-04 本人发送到自己的会话照常 202 并落 Request(正向对照)", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      const ca = await createConversation(ctx, a);
      const notify = vi.spyOn(ctx.scheduler!, "notify");
      const res = await send(ctx, a, ca, "k-own");
      expect(res.status).toBe(202);
      const body = (await res.json()) as { data: { request: { conversationId: string } } };
      expect(body.data.request.conversationId).toBe(ca);
      expect(await ctx.prisma.modelRequest.count()).toBe(1);
      // 证明 OWN-MSG-02 的「未被 notify」不是 spy 接错对象造成的假阴性
      expect(notify).toHaveBeenCalledTimes(1);
    });
  });
});

describe("OWN-REQ / OWN-SSE Request 读取、取消与事件流(§16/§17/§18/§31/§32)", () => {
  /** B 建会话并发出一条 PENDING Request(Scheduler 未启动,状态稳定) */
  async function seedForeignRequest(
    ctx: TestContext,
    b: Actor,
  ): Promise<{ conversationId: string; requestId: string }> {
    const conversationId = await createConversation(ctx, b);
    const res = await send(ctx, b, conversationId, "k-seed");
    const body = (await res.json()) as { data: { request: { id: string } } };
    return { conversationId, requestId: body.data.request.id };
  }

  it("OWN-REQ-01 跨用户 GET /api/requests/:id 404,与不存在的 id 同形", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      const b = await newAnonymous(ctx);
      const { requestId } = await seedForeignRequest(ctx, b);

      const foreign = await api(ctx, a, "GET", `/api/requests/${requestId}`, undefined, PINNED);
      const missing = await api(
        ctx,
        a,
        "GET",
        "/api/requests/00000000-0000-0000-0000-0000000000ff",
        undefined,
        PINNED,
      );
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      const foreignErr = await errorOf(foreign);
      expect(foreignErr.code).toBe(ErrorCodes.REQUEST_NOT_FOUND);
      expect(foreignErr).toEqual(await errorOf(missing));

      // 本人仍读得到自己的
      expect((await api(ctx, b, "GET", `/api/requests/${requestId}`)).status).toBe(200);
    });
  });

  it("OWN-REQ-02 跨用户 cancel 404:状态不变、取消登记表未被动过", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      const b = await newAnonymous(ctx);
      const { requestId } = await seedForeignRequest(ctx, b);

      const res = await api(ctx, a, "POST", `/api/requests/${requestId}/cancel`);
      expect(res.status).toBe(404);
      expect((await errorOf(res)).code).toBe(ErrorCodes.REQUEST_NOT_FOUND);

      const row = await ctx.prisma.modelRequest.findUnique({ where: { id: requestId } });
      expect(row!.status).toBe("PENDING");
      expect(ctx.cancellation.size()).toBe(0);

      // 对照:本人取消同一条 PENDING 正常落 CANCELLED
      expect((await api(ctx, b, "POST", `/api/requests/${requestId}/cancel`)).status).toBe(200);
      expect(
        (await ctx.prisma.modelRequest.findUnique({ where: { id: requestId } }))!.status,
      ).toBe("CANCELLED");
    });
  });

  it("OWN-SSE-01 跨用户订阅:404 + JSON 错误信封,绝不以 text/event-stream 开头", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      const b = await newAnonymous(ctx);
      const { requestId } = await seedForeignRequest(ctx, b);

      const res = await api(ctx, a, "GET", `/api/requests/${requestId}/events`, undefined, {
        Accept: "text/event-stream",
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type") ?? "").not.toContain("text/event-stream");
      expect((await errorOf(res)).code).toBe(ErrorCodes.REQUEST_NOT_FOUND);

      const missing = await api(
        ctx,
        a,
        "GET",
        "/api/requests/00000000-0000-0000-0000-0000000000ff/events",
        undefined,
        { Accept: "text/event-stream", ...PINNED },
      );
      const foreign = await api(
        ctx,
        a,
        "GET",
        `/api/requests/${requestId}/events`,
        undefined,
        { Accept: "text/event-stream", ...PINNED },
      );
      expect(missing.status).toBe(404);
      expect(await errorOf(foreign)).toEqual(await errorOf(missing));
    });
  });

  it("OWN-SSE-02 本人订阅仍得到事件流(§18 未把正向路径挡死)", async () => {
    await withApp(async (ctx) => {
      const b = await newAnonymous(ctx);
      const { requestId } = await seedForeignRequest(ctx, b);

      const res = await api(ctx, b, "GET", `/api/requests/${requestId}/events`, undefined, {
        Accept: "text/event-stream",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
      await res.body?.cancel();
    });
  });
});

describe("OWN-IDEMP 跨用户幂等键(§14/§33)", () => {
  it("OWN-IDEMP-01 他人已用的 Key 撞出自己的 409,不返回对方任何数据", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      const b = await newAnonymous(ctx);
      const ca = await createConversation(ctx, a);
      const cb = await createConversation(ctx, b);

      const first = await send(ctx, a, ca, "shared-key", { content: "same text" });
      expect(first.status).toBe(202);
      const firstBody = (await first.json()) as {
        data: { request: { id: string }; userMessage: { id: string } };
      };

      const res = await send(ctx, b, cb, "shared-key", { content: "same text" });
      expect(res.status).toBe(409);
      const err = await errorOf(res);
      expect(err.code).toBe(ErrorCodes.IDEMPOTENCY_KEY_REUSED);
      const text = JSON.stringify(err);
      expect(text).not.toContain(firstBody.data.request.id);
      expect(text).not.toContain(firstBody.data.userMessage.id);
      expect(text).not.toContain(ca);

      // B 的会话没有多出 Request,RA 仍只有 A 那一条
      expect(await ctx.prisma.modelRequest.count({ where: { conversationId: cb } })).toBe(0);
      expect(await ctx.prisma.modelRequest.count()).toBe(1);
    });
  });

  it("OWN-IDEMP-02 同用户同会话同 Key 同 payload 仍正常去重(既有幂等语义未退化)", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      const ca = await createConversation(ctx, a);
      const first = await send(ctx, a, ca, "dup-key", { content: "same text" });
      expect(first.status).toBe(202);
      const requestId = ((await first.json()) as { data: { request: { id: string } } }).data.request
        .id;

      const replay = await send(ctx, a, ca, "dup-key", { content: "same text" });
      expect(replay.status).toBe(200);
      const replayBody = (await replay.json()) as {
        data: { deduplicated: boolean; request: { id: string } };
      };
      expect(replayBody.data.deduplicated).toBe(true);
      expect(replayBody.data.request.id).toBe(requestId);
      expect(await ctx.prisma.modelRequest.count()).toBe(1);
    });
  });
});

describe("OWN-ADMIN / OWN-COMPAT 身份不是所有权旁路(§4/§5/§35/§36)", () => {
  it("OWN-ADMIN-01 ADMIN 只看得到自己名下的会话,且读不到匿名会话", async () => {
    await withApp(async (ctx) => {
      const legacy = await ctx.prisma.conversation.create({
        data: { title: "legacy-admin", userId: ADMIN_USER_ID },
      });
      const a = await newAnonymous(ctx);
      const b = await newAnonymous(ctx);
      const ca = await createConversation(ctx, a);
      await createConversation(ctx, b);

      const admin = await newAdmin(ctx);
      const res = await api(ctx, admin, "GET", "/api/conversations?status=ACTIVE&limit=50");
      expect(res.status).toBe(200);
      const ids = ((await res.json()) as { data: { id: string }[] }).data.map((c) => c.id);
      expect(ids).toEqual([legacy.id]);
      expect(ids).not.toContain(ca);

      const peek = await api(ctx, admin, "GET", `/api/conversations/${ca}`);
      expect(peek.status).toBe(404);
      expect((await errorOf(peek)).code).toBe(ErrorCodes.CONVERSATION_NOT_FOUND);

      const intrude = await send(ctx, admin, ca, "k-admin-write");
      expect(intrude.status).toBe(404);
      expect(await ctx.prisma.modelRequest.count({ where: { conversationId: ca } })).toBe(0);
    });
  });

  it("OWN-COMPAT-01 COMPAT 创建的会话归 COMPAT 哨兵行,且看不到 ADMIN 历史数据", async () => {
    await withApp(
      async (ctx) => {
        const legacy = await ctx.prisma.conversation.create({
          data: { title: "legacy-admin", userId: ADMIN_USER_ID },
        });
        const mine = await createConversation(ctx, COMPAT_ACTOR, { title: "compat" });
        const row = await ctx.prisma.conversation.findUnique({ where: { id: mine } });
        expect(row!.userId).toBe(COMPAT_USER_ID);

        const res = await api(ctx, COMPAT_ACTOR, "GET", "/api/conversations?status=ACTIVE&limit=50");
        expect(res.status).toBe(200);
        const ids = ((await res.json()) as { data: { id: string }[] }).data.map((c) => c.id);
        expect(ids).toEqual([mine]);
        expect(ids).not.toContain(legacy.id);

        const peek = await api(ctx, COMPAT_ACTOR, "GET", `/api/conversations/${legacy.id}`);
        expect(peek.status).toBe(404);
      },
      null,
    );
  });

  it("OWN-COMPAT-02 COMPAT 与真实匿名用户是两个身份,互不可见", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      const ca = await createConversation(ctx, a);
      const compatConv = await ctx.prisma.conversation.create({
        data: { title: "compat-owned", userId: COMPAT_USER_ID },
      });

      expect((await api(ctx, a, "GET", `/api/conversations/${compatConv.id}`)).status).toBe(404);

      const list = await api(ctx, a, "GET", "/api/conversations?status=ACTIVE&limit=50");
      const ids = ((await list.json()) as { data: { id: string }[] }).data.map((c) => c.id);
      expect(ids).toEqual([ca]);
    });
  });
});

describe("OWN-ORPHAN / OWN-INVAR 不可达归属与既有业务不变量(§20/§38/§51)", () => {
  /**
   * §51 测试语义迁移:B4 起 `Conversation.userId` 是 NOT NULL,数据库里已不可能存在 NULL 归属行,
   * 「无主数据对任何身份都不可见」这条运行期安全事实改由**永远不会被任何 Session 解析出来的 owner** 承载
   * (建一条没有任何 Session 的 User)。
   * 原 NULL 事实并未消失:它前移成 migration 负例 —— migration-v13b4.test.ts 的 B4-05 证明
   * NULL 连库都进不来(raw SQL 撞 NOT NULL,Prisma client 直接拒)。绝不为保留旧写法而弱化 NOT NULL。
   */
  async function unreachableOwner(ctx: TestContext): Promise<string> {
    const user = await ctx.prisma.user.create({ data: { type: "ANONYMOUS" } });
    return user.id;
  }

  it("OWN-ORPHAN-01 归属不可达的会话对任何正常身份都不可读写,也不出现在列表", async () => {
    await withApp(async (ctx) => {
      const orphan = await ctx.prisma.conversation.create({
        data: { title: "orphan", userId: await unreachableOwner(ctx) },
      });
      const a = await newAnonymous(ctx);
      const admin = await newAdmin(ctx);

      for (const actor of [a, admin]) {
        expect((await api(ctx, actor, "GET", `/api/conversations/${orphan.id}`)).status).toBe(404);
        expect(
          (await api(ctx, actor, "PATCH", `/api/conversations/${orphan.id}`, { title: "x" })).status,
        ).toBe(404);
        expect((await api(ctx, actor, "DELETE", `/api/conversations/${orphan.id}`)).status).toBe(404);
        expect(
          (await api(ctx, actor, "GET", `/api/conversations/${orphan.id}/messages`)).status,
        ).toBe(404);
        expect(
          (await send(ctx, actor, orphan.id, `k-orphan-${actor.userId}`)).status,
        ).toBe(404);

        const list = await api(ctx, actor, "GET", "/api/conversations?status=ACTIVE&limit=50");
        const ids = ((await list.json()) as { data: { id: string }[] }).data.map((c) => c.id);
        expect(ids).not.toContain(orphan.id);
      }
      expect(await ctx.prisma.modelRequest.count()).toBe(0);
    });
  });

  it("OWN-ORPHAN-02 COMPAT 同样读不到归属不可达的会话", async () => {
    await withApp(
      async (ctx) => {
        const orphan = await ctx.prisma.conversation.create({
          data: { title: "orphan", userId: await unreachableOwner(ctx) },
        });
        expect((await api(ctx, COMPAT_ACTOR, "GET", `/api/conversations/${orphan.id}`)).status).toBe(
          404,
        );
      },
      null,
    );
  });

  it("OWN-INVAR-01 自己的会话有活动 Request 时归档仍 409;别人的同状态会话只得到 404(§20)", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      const b = await newAnonymous(ctx);
      const ca = await createConversation(ctx, a);
      const cb = await createConversation(ctx, b);
      expect((await send(ctx, a, ca, "k-a-active")).status).toBe(202);
      expect((await send(ctx, b, cb, "k-b-active")).status).toBe(202);

      const own = await api(ctx, a, "PATCH", `/api/conversations/${ca}`, { status: "ARCHIVED" });
      expect(own.status).toBe(409);
      expect((await errorOf(own)).code).toBe(ErrorCodes.CONVERSATION_REQUEST_IN_PROGRESS);

      const foreign = await api(ctx, a, "PATCH", `/api/conversations/${cb}`, { status: "ARCHIVED" });
      expect(foreign.status).toBe(404);
      expect((await errorOf(foreign)).code).toBe(ErrorCodes.CONVERSATION_NOT_FOUND);

      const foreignDelete = await api(ctx, a, "DELETE", `/api/conversations/${cb}`);
      expect(foreignDelete.status).toBe(404);
      const cbRow = await ctx.prisma.conversation.findUnique({ where: { id: cb } });
      expect(cbRow!.status).toBe("ACTIVE");
      expect(await ctx.prisma.modelRequest.count({ where: { conversationId: cb } })).toBe(1);
    });
  });
});
