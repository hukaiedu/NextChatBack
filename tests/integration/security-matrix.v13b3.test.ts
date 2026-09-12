import { describe, expect, it } from "vitest";

import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { ADMIN_USER_ID, AUTH_COOKIE_NAME } from "../../src/config/constants.js";
import { hashSessionToken } from "../../src/modules/auth/auth.session-token.js";
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
 * V1.3-B3-2/B3-3 §53 + §68:四类身份的安全矩阵,集中在一个文件里逐行证明。
 *
 * COMPAT 行(AUTH_ENABLED=false)是另一套 app 配置,不在本文件的 authed ctx 里,
 * 其五格证据分别是:
 *   ownership → OWN-COMPAT-01/02 · admin → ADM-M04 · models/DTO → DTO-01..11
 *   errors → ER-PUB-01..05
 * 本文件负责另外三格:真实 ANONYMOUS Session A / B 与 ADMIN。
 */

/** §53:匿名可达接口绝不允许出现的内部字段 */
const FORBIDDEN_INTERNAL_KEYS = [
  "userId",
  "profileDir",
  "providerLoggedIn",
  "headless",
  "browserType",
  "providerConversationUrl",
  "requestFingerprint",
  "idempotencyKey",
  "attemptCount",
] as const;

const SECRET = "SECRET_PROVIDER_INTERNAL_DETAIL_123";

interface Actor {
  cookie: string;
  userId: string;
}

async function newAnonymous(ctx: TestContext): Promise<Actor> {
  const res = await fetch(`${ctx.baseUrl}/api/auth/anonymous`, { method: "POST" });
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
  if (res.status !== 200 || raw === undefined) {
    throw new Error(`anonymous bootstrap failed: ${res.status}`);
  }
  const cookie = raw.split(";")[0]!;
  const token = cookie.slice(AUTH_COOKIE_NAME.length + 1);
  const session = await ctx.prisma.session.findUnique({ where: { tokenHash: hashSessionToken(token) } });
  return { cookie, userId: session!.userId };
}

async function api(
  ctx: TestContext,
  actor: Actor,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { Cookie: actor.cookie, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/** 递归收集一份 JSON 里出现的全部对象键(含数组元素与嵌套对象) */
function collectKeys(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, acc);
    return acc;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      acc.add(key);
      collectKeys(nested, acc);
    }
  }
  return acc;
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** 断言「这个面确实成功访问到了」再取体:失败时把面名和原文一起报出来,便于定位 */
async function okBody(label: string, res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  expect([200, 201, 202].includes(res.status), `${label} -> ${res.status} ${text}`).toBe(true);
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * 给某个匿名 Actor 直接落一条完整链路:会话带上 provider / providerConversationUrl / userId,
 * 会话里一条 FAILED Request 带内部错误码与内部 message —— 用来证明映射与裁剪都真的发生了。
 */
async function seedOwnedChain(
  ctx: TestContext,
  owner: string,
  key: string,
  errorCode: string,
): Promise<{ conversationId: string; requestId: string }> {
  const conversation = await ctx.prisma.conversation.create({
    data: {
      title: `mtx-${key}`,
      userId: owner,
      provider: "gemini-web",
      providerConversationUrl: `https://gemini.google.com/app/secret-${key}`,
    },
  });
  const userMessage = await ctx.prisma.message.create({
    data: { conversationId: conversation.id, role: "USER", content: "你好", status: "COMPLETED", position: 1 },
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
      requestFingerprint: computeRequestFingerprint(conversation.id, "你好"),
      status: "FAILED",
      errorCode,
      errorMessage: `Chromium renderer crashed ${SECRET}`,
    },
  });
  return { conversationId: conversation.id, requestId: request.id };
}

async function withApp<T>(fn: (ctx: TestContext) => Promise<T>): Promise<T> {
  const ctx = await setupTestContext({
    browserManager: createFakeManager(new FakeDriver()),
    geminiAdapter: new FakeGeminiAdapter({ answer: "假回答" }),
    auth: ADMIN_AUTH,
  });
  try {
    await ctx.reset();
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

describe("V1.3-B3 §53/§68 安全矩阵:Anonymous A / Anonymous B / ADMIN", () => {
  it("MTX-01 Chat ownership:普通聊天数据三方互不可读", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      const b = await newAnonymous(ctx);
      const admin = { cookie: await loginAdmin(ctx.baseUrl), userId: ADMIN_USER_ID };

      const mine = (await jsonOf(await api(ctx, a, "POST", "/api/conversations", { title: "A 的会话" })))
        .data as { id: string };

      expect((await api(ctx, a, "GET", `/api/conversations/${mine.id}`)).status).toBe(200);
      for (const other of [b, admin]) {
        const res = await api(ctx, other, "GET", `/api/conversations/${mine.id}`);
        expect(res.status).toBe(404);
        expect(((await jsonOf(res)).error as { code: string }).code).toBe(
          ErrorCodes.CONVERSATION_NOT_FOUND,
        );
      }

      // 对方的会话也不会出现在自己的列表里
      const bList = (await jsonOf(await api(ctx, b, "GET", "/api/conversations"))).data as unknown[];
      expect(bList).toEqual([]);

      // 反向:ADMIN 名下的历史数据对匿名不可读
      const adminConv = await seedOwnedChain(ctx, ADMIN_USER_ID, "mtx-admin-owned", ErrorCodes.PROVIDER_PAGE_CLOSED);
      expect(
        (
          await api(
            ctx,
            a,
            "GET",
            `/api/conversations/${adminConv.conversationId}`,
          )
        ).status,
      ).toBe(404);
    });
  });

  it("MTX-02 Admin:只有 ADMIN 可访问运维 API,匿名得到的是不泄露信息的 403", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      const adminCookie = await loginAdmin(ctx.baseUrl);

      const path = "/api/admin/browser/status";
      const denied = await api(ctx, a, "GET", path);
      expect(denied.status).toBe(403);
      const deniedBody = await jsonOf(denied);
      expect((deniedBody.error as { code: string }).code).toBe(ErrorCodes.AUTH_FORBIDDEN);
      // §53:拒绝响应本身也不得带运维内部信息
      expect(collectKeys(deniedBody)).not.toContain("profileDir");
      expect(JSON.stringify(deniedBody)).not.toContain("profile");

      const granted = await fetch(
        `${ctx.baseUrl}${path}`,
        withAdminCookie(adminCookie, { method: "GET" }),
      );
      expect(granted.status).toBe(200);

      // §25(V1.3-C):旧 alias 已从路由表移除 —— ADMIN 也只会得到 404,不是 403
      const retired = await fetch(
        `${ctx.baseUrl}/api/browser/status`,
        withAdminCookie(adminCookie, { method: "GET" }),
      );
      expect(retired.status).toBe(404);
    });
  });

  it("MTX-03 Public models:模型目录是普通用户能力,不需要 ADMIN", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      // Fake Browser 初始为 STOPPED:先由 ADMIN 打开,再验匿名读取(§24 与权限无关的只有目录本身)
      const opened = await fetch(
        `${ctx.baseUrl}/api/admin/provider/open`,
        withAdminCookie(await loginAdmin(ctx.baseUrl), { method: "POST" }),
      );
      expect(opened.status).toBe(200);

      const res = await api(ctx, a, "GET", "/api/provider/models");
      expect(res.status).toBe(200);
      const body = await jsonOf(res);
      expect((body.data as { models: unknown[] }).models.length).toBeGreaterThan(0);
      for (const forbidden of FORBIDDEN_INTERNAL_KEYS) {
        expect(collectKeys(body)).not.toContain(forbidden);
      }
    });
  });

  it("MTX-04 DTO:匿名可达的每个 Public 面都没有内部字段(§53)", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      // /api/provider/models 的成功响应需要 Provider 就绪:先由 ADMIN 打开(运维动作),再扫匿名的可见面
      expect(
        (
          await fetch(
            `${ctx.baseUrl}/api/admin/provider/open`,
            withAdminCookie(await loginAdmin(ctx.baseUrl), { method: "POST" }),
          )
        ).status,
      ).toBe(200);
      const seeded = await seedOwnedChain(ctx, a.userId, "mtx-scan", ErrorCodes.PROVIDER_PAGE_CLOSED);

      // §53 的口径是「能成功访问的接口」:先钉住 2xx,再扫键 —— 否则一个 4xx 空壳也算「没泄露」
      const responses: Record<string, unknown>[] = [
        await okBody(
          "conversation create",
          await api(ctx, a, "POST", "/api/conversations", { title: "新建" }),
        ),
        await okBody("conversation list", await api(ctx, a, "GET", "/api/conversations")),
        await okBody(
          "conversation get",
          await api(ctx, a, "GET", `/api/conversations/${seeded.conversationId}`),
        ),
        await okBody(
          "conversation patch",
          await api(ctx, a, "PATCH", `/api/conversations/${seeded.conversationId}`, { title: "改名" }),
        ),
        await okBody(
          "message history",
          await api(ctx, a, "GET", `/api/conversations/${seeded.conversationId}/messages`),
        ),
        await okBody(
          "send message",
          await api(
            ctx,
            a,
            "POST",
            `/api/conversations/${seeded.conversationId}/messages`,
            { content: "你好" },
            { "Idempotency-Key": "mtx-send" },
          ),
        ),
        await okBody("request get", await api(ctx, a, "GET", `/api/requests/${seeded.requestId}`)),
        await okBody("provider models", await api(ctx, a, "GET", "/api/provider/models")),
        await okBody("auth session", await api(ctx, a, "GET", "/api/auth/session")),
      ];
      const created = await okBody(
        "cancellable conversation",
        await api(ctx, a, "POST", "/api/conversations", { title: "可取消" }),
      );
      const cancelTarget = (created.data as { id: string }).id;
      const sent = await okBody(
        "cancellable send",
        await api(
          ctx,
          a,
          "POST",
          `/api/conversations/${cancelTarget}/messages`,
          { content: "你好" },
          { "Idempotency-Key": "mtx-cancel" },
        ),
      );
      responses.push(
        await okBody(
          "request cancel",
          await api(
            ctx,
            a,
            "POST",
            `/api/requests/${(sent.data as { request: { id: string } }).request.id}/cancel`,
          ),
        ),
      );

      const keys = new Set<string>();
      for (const body of responses) {
        for (const key of collectKeys(body)) keys.add(key);
        // §52:即使 DB 里 userId / provider / providerConversationUrl 都有值,文本里也不该出现
        const text = JSON.stringify(body);
        expect(text).not.toContain("secret-mtx-scan");
        expect(text).not.toContain("gemini.google.com");
        expect(text).not.toContain(a.userId);
      }
      for (const forbidden of FORBIDDEN_INTERNAL_KEYS) {
        expect(keys).not.toContain(forbidden);
      }
    });
  });

  it("MTX-05 Errors:Provider/Browser 内部错误在三个 Public 面都只剩通用码(§54/§19)", async () => {
    await withApp(async (ctx) => {
      const a = await newAnonymous(ctx);
      const { conversationId, requestId } = await seedOwnedChain(
        ctx,
        a.userId,
        "mtx-error",
        ErrorCodes.PROVIDER_BROWSER_CRASHED,
      );

      const surfaces: { name: string; text: string; error: Record<string, unknown> }[] = [];

      const getRequest = await api(ctx, a, "GET", `/api/requests/${requestId}`);
      const getRequestText = await getRequest.text();
      surfaces.push({
        name: "GET request",
        text: getRequestText,
        error: (JSON.parse(getRequestText) as { data: Record<string, unknown> }).data,
      });

      const history = await api(ctx, a, "GET", `/api/conversations/${conversationId}/messages`);
      const historyText = await history.text();
      const items = (JSON.parse(historyText) as { data: Record<string, unknown>[] }).data;
      surfaces.push({
        name: "Message history",
        text: historyText,
        error: items.find((m) => m.role === "ASSISTANT")!.request as Record<string, unknown>,
      });

      const client = await SseTestClient.connect(
        ctx.baseUrl,
        requestId,
        withAdminCookie(a.cookie),
      );
      const frame = await client.waitFor((e) => e.event === "error", "error frame");
      surfaces.push({ name: "SSE error", text: JSON.stringify(frame.data), error: frame.data });
      client.close();

      for (const surface of surfaces) {
        expect(
          { code: surface.error.code ?? surface.error.errorCode },
          `surface ${surface.name}`,
        ).toMatchObject({ code: "CHAT_FAILED" });
        expect(surface.text, `surface ${surface.name}`).not.toContain(SECRET);
        expect(surface.text, `surface ${surface.name}`).not.toContain("PROVIDER_BROWSER_CRASHED");
        expect(surface.text, `surface ${surface.name}`).not.toMatch(/chromium|renderer/i);
      }

      // §18:原始码与原始 message 只留在数据库
      const row = await ctx.prisma.modelRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(row.errorCode).toBe(ErrorCodes.PROVIDER_BROWSER_CRASHED);
      expect(row.errorMessage).toContain(SECRET);
    });
  });
});
