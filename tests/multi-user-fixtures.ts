import type { AbuseProtectionConfig } from "../src/app.js";
import type { RateLimitClock } from "../src/common/rate-limit/rate-limiter.js";
import { ADMIN_USER_ID, AUTH_COOKIE_NAME, COMPAT_USER_ID } from "../src/config/constants.js";
import type { RawAttachment } from "../src/modules/message/attachment.js";
import type { AuthDeps } from "../src/modules/auth/auth.types.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { ADMIN_AUTH, setupTestContext, type TestContext } from "./helpers.js";

/**
 * V1.3 P6/P7 共用的多用户 HTTP 测试夹具。
 *
 * 这两轮的验收都要求「走真实 HTTP 端点」(任务书 §86),而不是直接调 Service;
 * 于是限额矩阵与公平矩阵需要同一套身份 / 会话 / 提交通道。放在一处,是为了让两份
 * 判据按同一条请求链路计数,而不是各留一份会漂移的副本。
 */

/** 可推进假时钟(§125:窗口边界必须钉在最后一毫秒上,不能靠真时间睡) */
export function fakeClock() {
  let now = 0;
  const clock: RateLimitClock = { now: () => now };
  return { clock, advance: (ms: number) => (now += ms) };
}

export function authDeps(overrides: Partial<AuthDeps> = {}): AuthDeps {
  return { ...ADMIN_AUTH, ...overrides };
}

export function cookieOf(res: Response): string {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
  if (raw === undefined) {
    throw new Error(`missing session cookie: ${res.status}`);
  }
  return raw.split(";")[0]!;
}

/** POST /api/auth/anonymous(不带 Cookie = 请求新身份;带 Cookie = 幂等复用) */
export function anonymous(baseUrl: string, cookie?: string, xff?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers.Cookie = cookie;
  if (xff !== undefined) headers["X-Forwarded-For"] = xff;
  return fetch(`${baseUrl}/api/auth/anonymous`, {
    method: "POST",
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  });
}

/** 建立 app(每用例独立:限额与公平队列都活在内存里) */
export function openApp(
  abuse: AbuseProtectionConfig,
  auth: AuthDeps | null = authDeps(),
): Promise<TestContext> {
  return setupTestContext({ auth, abuse });
}

/** cookie="" = 不鉴权模式下不需要 Cookie */
export async function newConversation(ctx: TestContext, cookie: string): Promise<string> {
  const res = await fetch(`${ctx.baseUrl}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie === "" ? {} : { Cookie: cookie }) },
    body: JSON.stringify({}),
  });
  if (res.status !== 201) {
    throw new Error(`createConversation failed: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { data: { id: string } }).data.id;
}

export interface TestUser {
  cookie: string;
  userId: string;
  conversationIds: string[];
}

/**
 * 新匿名身份 + 它的 N 个会话。
 * 多条 PENDING 必须来自多个会话:同一会话的活动态由部分唯一索引兜底,那是与限额无关的既有约束。
 */
export async function newUserWithConversations(
  ctx: TestContext,
  count: number,
): Promise<TestUser> {
  const cookie = cookieOf(await anonymous(ctx.baseUrl));
  const conversationIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    conversationIds.push(await newConversation(ctx, cookie));
  }
  const first = conversationIds[0];
  if (first === undefined) {
    throw new Error("need at least one conversation to resolve owner");
  }
  // Public DTO 里没有 owner,归属只能从测试库读:它同时是断言口径与被测事实
  const conversation = await ctx.prisma.conversation.findUniqueOrThrow({
    where: { id: first },
    select: { userId: true },
  });
  return { cookie, userId: conversation.userId, conversationIds };
}

export interface SendResult {
  status: number;
  body: unknown;
  retryAfter: string | null;
}

export async function send(
  ctx: TestContext,
  cookie: string,
  conversationId: string,
  idempotencyKey: string,
  content = "hello",
  attachments?: RawAttachment[],
): Promise<SendResult> {
  const body: Record<string, unknown> = { content };
  if (attachments !== undefined) body.attachments = attachments;
  const res = await fetch(`${ctx.baseUrl}/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      ...(cookie === "" ? {} : { Cookie: cookie }),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), retryAfter: res.headers.get("retry-after") };
}

/** POST /api/requests/:id/cancel(PENDING 会直接落到 CANCELLED) */
export function cancel(ctx: TestContext, cookie: string, requestId: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}/api/requests/${requestId}/cancel`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
}

export interface PublicErrorBody {
  code: string;
  message: string;
  requestId: string;
}

export function errorOf(body: unknown): PublicErrorBody {
  return (body as { error: PublicErrorBody }).error;
}

/** Public 错误信封的键集合:多一个键就是泄露内部细节 */
export const PUBLIC_ERROR_KEYS = ["code", "message", "requestId"];

export function requestIdOf(body: unknown): string {
  return (body as { data: { request: { id: string } } }).data.request.id;
}

export async function counts(prisma: PrismaClient) {
  return {
    // 哨兵 COMPAT User 本身就是 ANONYMOUS 类型:排掉两个哨兵,这个数才等于「本轮新建的身份数」
    createdAnonymousUsers: await prisma.user.count({
      where: { type: "ANONYMOUS", id: { notIn: [ADMIN_USER_ID, COMPAT_USER_ID] } },
    }),
    sessions: await prisma.session.count(),
    conversations: await prisma.conversation.count(),
    messages: await prisma.message.count(),
    requests: await prisma.modelRequest.count(),
    pending: await prisma.modelRequest.count({ where: { status: "PENDING" } }),
  };
}
