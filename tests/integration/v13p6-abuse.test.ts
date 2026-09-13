import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AbuseProtectionConfig } from "../../src/app.js";
import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { PublicErrorCodes } from "../../src/common/errors/public-error.js";
import {
  ADMIN_USER_ID,
  ANONYMOUS_IP_DAY_WINDOW_MS,
  ANONYMOUS_IP_HOUR_WINDOW_MS,
  ATTACHMENT_MAX_BYTES,
  AUTH_COOKIE_NAME,
  CHAT_SUBMIT_RATE_WINDOW_MS,
  COMPAT_USER_ID,
  QUEUE_FULL_RETRY_AFTER_SECONDS,
} from "../../src/config/constants.js";
import {
  generateSessionToken,
  hashSessionToken,
} from "../../src/modules/auth/auth.session-token.js";
import { MessageService } from "../../src/modules/message/message.service.js";
import { RequestScheduler } from "../../src/modules/request/request.scheduler.js";
import { USER_MESSAGE_STATUS } from "../../src/modules/message/message.types.js";
import type { AuthDeps } from "../../src/modules/auth/auth.types.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { attachment } from "../attachment-fixtures.js";
import { loginAdmin, type TestContext } from "../helpers.js";
import {
  anonymous,
  authDeps,
  cookieOf,
  counts,
  errorOf,
  fakeClock,
  newConversation,
  newUserWithConversations,
  openApp,
  PUBLIC_ERROR_KEYS,
  requestIdOf,
  send,
} from "../multi-user-fixtures.js";

/**
 * FIX-01B §16 的取证通道:「被挡掉的请求没有付附件的账」必须是一个可断言的数字,
 * 而不是「读代码看不出会跑」这种结论。这里只给两个昂贵函数套一层计数壳,
 * 实现仍然逐字节走真实路径 —— 被计数的正是 base64 解码 / Buffer 分配 / magic byte 复核
 * (parseAttachments)与对解码后字节做 sha256(computeAttachmentsDigest)。
 */
const expensiveCalls = { parse: 0, digest: 0 };

vi.mock("../../src/modules/message/attachment.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/modules/message/attachment.js")>();
  return {
    ...actual,
    parseAttachments: (raw: Parameters<typeof actual.parseAttachments>[0]) => {
      expensiveCalls.parse += 1;
      return actual.parseAttachments(raw);
    },
    computeAttachmentsDigest: (files: Parameters<typeof actual.computeAttachmentsDigest>[0]) => {
      expensiveCalls.digest += 1;
      return actual.computeAttachmentsDigest(files);
    },
  };
});

function resetExpensiveCalls(): void {
  expensiveCalls.parse = 0;
  expensiveCalls.digest = 0;
}

/** 指纹侧的计数壳:sendMessage 里唯一调用它的位置,FIX-01B §16 允许的最小 seam */
function spyFingerprint(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(
    MessageService.prototype as unknown as {
      buildRequestFingerprint(): string;
    },
    "buildRequestFingerprint",
  );
}

/** 附件占位与 notify 的计数壳:两者都是实例/原型上的普通方法,直接 spy 即可 */
function spyReserve(ctx: TestContext): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(ctx.attachmentStore, "reserve");
}

function spyNotify(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(RequestScheduler.prototype, "notify");
}

const HOUR = ANONYMOUS_IP_HOUR_WINDOW_MS;
const DAY = ANONYMOUS_IP_DAY_WINDOW_MS;

const openContexts: TestContext[] = [];

/**
 * 每个用例独立 app:限流状态活在内存里,共用 app 会把上一用例的窗口带进下一断言。
 * scheduler 不启动(helper 默认),PENDING 就此停在队列里,才数得清「排队容量」。
 */
async function open(
  abuse: AbuseProtectionConfig,
  auth: AuthDeps | null = authDeps(),
): Promise<TestContext> {
  const ctx = await openApp(abuse, auth);
  openContexts.push(ctx);
  await ctx.reset();
  return ctx;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const ctx of openContexts.splice(0)) {
    await ctx.close();
  }
});

/** 绕过准入直接落 PENDING:模拟「限额上线之前库里就积压了超量行」的存量数据 */
async function seedPendingRequest(prisma: PrismaClient, userId: string): Promise<string> {
  const conversation = await prisma.conversation.create({ data: { userId, title: "seed" } });
  const userMessage = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "USER",
      content: "seed",
      status: USER_MESSAGE_STATUS,
      position: 1,
    },
  });
  const assistantMessage = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "ASSISTANT",
      content: "",
      status: "PENDING",
      position: 2,
    },
  });
  const request = await prisma.modelRequest.create({
    data: {
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      idempotencyKey: randomUUID(),
      requestFingerprint: "seed",
      status: "PENDING",
    },
  });
  return request.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// §14~§16 + §87:匿名身份新建的 IP 双窗口限额
// ─────────────────────────────────────────────────────────────────────────────

describe("P6-ANON 匿名身份新建限额(POST /api/auth/anonymous)", () => {
  it("P6-ANON-01 有效匿名身份的幂等调用不耗创建额度", async () => {
    // 最窄档:小时额度只有 1。第一次创建用掉它,之后「复用既有身份」必须照常 200
    const ctx = await open({ anonymousIpLimitPerHour: 1 });

    const first = await anonymous(ctx.baseUrl);
    expect(first.status).toBe(200);
    const cookie = cookieOf(first);
    expect(ctx.rateLimits.anonymousIp.keyCount()).toEqual({ hour: 1, day: 1 });

    const replay = await anonymous(ctx.baseUrl, cookie);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { data: { userType: string } }).data.userType).toBe(
      "ANONYMOUS",
    );
    expect(ctx.rateLimits.anonymousIp.keyCount()).toEqual({ hour: 1, day: 1 });
    expect((await counts(ctx.prisma)).createdAnonymousUsers).toBe(1);
  });

  it("P6-ANON-02 新身份撞到小时上限即 429,窗口过期后恢复", async () => {
    const { clock, advance } = fakeClock();
    const ctx = await open({ anonymousIpLimitPerHour: 3, clock });

    for (let i = 0; i < 3; i += 1) {
      expect((await anonymous(ctx.baseUrl)).status).toBe(200);
    }
    const blocked = await anonymous(ctx.baseUrl);
    expect(blocked.status).toBe(429);
    expect(errorOf(await blocked.json()).code).toBe(ErrorCodes.AUTH_RATE_LIMITED);
    expect((await counts(ctx.prisma)).createdAnonymousUsers).toBe(3);

    // 窗口最后一毫秒仍拒 —— 边界不能靠真时间碰运气
    advance(HOUR - 1);
    expect((await anonymous(ctx.baseUrl)).status).toBe(429);
    advance(1);
    expect((await anonymous(ctx.baseUrl)).status).toBe(200);
    expect((await counts(ctx.prisma)).createdAnonymousUsers).toBe(4);
  });

  it("P6-ANON-03 日上限独立生效(小时仍有余量也拦)", async () => {
    const { clock, advance } = fakeClock();
    const ctx = await open({ anonymousIpLimitPerHour: 100, anonymousIpLimitPerDay: 2, clock });

    expect((await anonymous(ctx.baseUrl)).status).toBe(200);
    expect((await anonymous(ctx.baseUrl)).status).toBe(200);
    const blocked = await anonymous(ctx.baseUrl);
    expect(blocked.status).toBe(429);
    // 两窗口共用时钟:被日窗口拦下时等的是日窗口剩余,不是小时的
    expect(blocked.headers.get("retry-after")).toBe(String(Math.ceil(DAY / 1000)));
    expect((await counts(ctx.prisma)).createdAnonymousUsers).toBe(2);

    // 小时窗口过期不够:日窗口未满额前一直拦
    advance(HOUR);
    expect((await anonymous(ctx.baseUrl)).status).toBe(429);
    advance(DAY - HOUR);
    expect((await anonymous(ctx.baseUrl)).status).toBe(200);
  });

  it("P6-ANON-04 429 必带 Retry-After,且按窗口剩余时间递减", async () => {
    const { clock, advance } = fakeClock();
    const ctx = await open({ anonymousIpLimitPerHour: 1, clock });

    expect((await anonymous(ctx.baseUrl)).status).toBe(200);
    const first = await anonymous(ctx.baseUrl);
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toBe(String(HOUR / 1000));

    advance(1_000);
    const second = await anonymous(ctx.baseUrl);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe(String((HOUR - 1_000) / 1000));
  });

  it("P6-ANON-05 / IP-01 trust proxy 关闭时伪造 X-Forwarded-For 绕不过同源限额", async () => {
    const ctx = await open({ anonymousIpLimitPerHour: 2 }, authDeps({ trustProxy: false }));

    // 每次换一个「假客户端 IP」:Express 不信任 proxy,req.ip 仍是 127.0.0.1
    const spoofs = ["1.2.3.4", "5.6.7.8", "9.9.9.9"];
    for (const [index, spoof] of spoofs.entries()) {
      const res = await anonymous(ctx.baseUrl, undefined, spoof);
      expect(res.status).toBe(index < 2 ? 200 : 429);
      await res.body?.cancel();
    }
    // 全部记在同一个键上
    expect(ctx.rateLimits.anonymousIp.keyCount()).toEqual({ hour: 1, day: 1 });
    expect((await counts(ctx.prisma)).createdAnonymousUsers).toBe(2);
  });

  it("P6-ANON-06 并发 10 个新身份、额度 3 → 最多创建 3 个", async () => {
    const ctx = await open({ anonymousIpLimitPerHour: 3 });

    const results = await Promise.all(Array.from({ length: 10 }, () => anonymous(ctx.baseUrl)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
    for (const res of results) {
      await res.body?.cancel();
    }
    // 数据库侧同步收口:创建数不超过额度,Session 也只多了 3 条
    const c = await counts(ctx.prisma);
    expect(c.createdAnonymousUsers).toBe(3);
    expect(c.sessions).toBe(3);
  });

  it("P6-ANON-07 ADMIN 身份的幂等调用同样不耗额度", async () => {
    const ctx = await open({ anonymousIpLimitPerHour: 1 });

    const admin = await loginAdmin(ctx.baseUrl);
    const replay = await anonymous(ctx.baseUrl, admin);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { data: { userType: string } }).data.userType).toBe("ADMIN");
    // 只有「真的会新建」的那一次才计数,而这里一次都没发生
    expect(ctx.rateLimits.anonymousIp.keyCount()).toEqual({ hour: 0, day: 0 });
  });

  it("IP-02 合法配置 trust proxy 时 req.ip 按 Express 既有规则分键", async () => {
    const ctx = await open({ anonymousIpLimitPerHour: 1 }, authDeps({ trustProxy: true }));

    // loopback 被信任 ⇒ 直连请求的 XFF 采纳为 req.ip:不同来源各自成桶
    expect((await anonymous(ctx.baseUrl, undefined, "10.0.0.1")).status).toBe(200);
    expect((await anonymous(ctx.baseUrl, undefined, "10.0.0.2")).status).toBe(200);
    expect(ctx.rateLimits.anonymousIp.keyCount()).toEqual({ hour: 2, day: 2 });
    // 同源的第二个请求才受同一桶约束
    expect((await anonymous(ctx.baseUrl, undefined, "10.0.0.1")).status).toBe(429);
    expect((await counts(ctx.prisma)).createdAnonymousUsers).toBe(2);
  });

  it("P6-ANON-08 小时与日额度组合:小时窗口滚动后天额度继续累计(§126)", async () => {
    const { clock, advance } = fakeClock();
    const ctx = await open({ anonymousIpLimitPerHour: 2, anonymousIpLimitPerDay: 3, clock });

    expect((await anonymous(ctx.baseUrl)).status).toBe(200);
    expect((await anonymous(ctx.baseUrl)).status).toBe(200);
    // 小时先到顶
    expect((await anonymous(ctx.baseUrl)).status).toBe(429);

    // 小时窗口滚动:当天还剩 1 次额度
    advance(HOUR);
    expect((await anonymous(ctx.baseUrl)).status).toBe(200);
    // 累计到日上限,此后小时窗口再滚动也没用
    expect((await anonymous(ctx.baseUrl)).status).toBe(429);
    advance(HOUR);
    expect((await anonymous(ctx.baseUrl)).status).toBe(429);
    advance(DAY - 2 * HOUR);
    expect((await anonymous(ctx.baseUrl)).status).toBe(200);

    // 四次放行 = 四个新身份(首小时 2 + 小时滚动 1 + 日窗口滚动 1)
    expect((await counts(ctx.prisma)).createdAnonymousUsers).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §23~§25 + §88:发消息提交频率(键 = req.auth.userId)
// ─────────────────────────────────────────────────────────────────────────────

describe("P6-RATE 消息提交频率限额", () => {
  it("P6-RATE-01/02 上限内成功,超限 429 且 Public 码为 SERVICE_BUSY", async () => {
    const { clock } = fakeClock();
    const ctx = await open({ chatSubmitRatePerMinute: 2, clock });
    const user = await newUserWithConversations(ctx, 3);

    // §124 边界:limit-1 / limit 都放行
    expect((await send(ctx, user.cookie, user.conversationIds[0]!, "r-01")).status).toBe(202);
    expect((await send(ctx, user.cookie, user.conversationIds[1]!, "r-02")).status).toBe(202);

    // limit+1 拦下:Public 面只说「服务忙」,不泄露是哪一档限额
    const blocked = await send(ctx, user.cookie, user.conversationIds[2]!, "r-03");
    expect(blocked.status).toBe(429);
    expect(errorOf(blocked.body).code).toBe(PublicErrorCodes.SERVICE_BUSY);
    expect(Object.keys(errorOf(blocked.body)).sort()).toEqual(PUBLIC_ERROR_KEYS);
    expect(Number(blocked.retryAfter)).toBeGreaterThan(0);

    const c = await counts(ctx.prisma);
    expect(c.requests).toBe(2);
    expect(c.pending).toBe(2);
    // 被拒的那条没留 Message(2 条请求 = 4 条消息)
    expect(c.messages).toBe(4);
  });

  it("P6-RATE-03 用户之间额度独立", async () => {
    const { clock } = fakeClock();
    const ctx = await open({ chatSubmitRatePerMinute: 1, clock });
    const a = await newUserWithConversations(ctx, 2);
    const b = await newUserWithConversations(ctx, 1);

    expect((await send(ctx, a.cookie, a.conversationIds[0]!, "a-1")).status).toBe(202);
    expect((await send(ctx, a.cookie, a.conversationIds[1]!, "a-2")).status).toBe(429);
    // B 自己的桶,与 A 的超限无关
    expect((await send(ctx, b.cookie, b.conversationIds[0]!, "b-1")).status).toBe(202);
    // 键是 userId,不是 IP、也不是全局一个桶
    expect(ctx.rateLimits.chatSubmit.keyCount()).toBe(2);
  });

  it("P6-RATE-04 ADMIN 的普通聊天同样受限", async () => {
    const { clock } = fakeClock();
    const ctx = await open({ chatSubmitRatePerMinute: 1, clock });
    const admin = await loginAdmin(ctx.baseUrl);
    const convOne = await newConversation(ctx, admin);
    const convTwo = await newConversation(ctx, admin);

    expect((await send(ctx, admin, convOne, "admin-1")).status).toBe(202);
    const blocked = await send(ctx, admin, convTwo, "admin-2");
    expect(blocked.status).toBe(429);
    expect(errorOf(blocked.body).code).toBe(PublicErrorCodes.SERVICE_BUSY);
    // 键确实是 ADMIN 本身,而不是某个匿名身份
    expect(ctx.rateLimits.chatSubmit.peek(ADMIN_USER_ID).limited).toBe(true);
  });

  it("P6-RATE-05 兼容模式(COMPAT)也受限,不因不鉴权而免单", async () => {
    const { clock } = fakeClock();
    const ctx = await open({ chatSubmitRatePerMinute: 1, clock }, null);
    const convOne = await newConversation(ctx, "");
    const convTwo = await newConversation(ctx, "");

    expect((await send(ctx, "", convOne, "compat-1")).status).toBe(202);
    const blocked = await send(ctx, "", convTwo, "compat-2");
    expect(blocked.status).toBe(429);
    expect(ctx.rateLimits.chatSubmit.peek(COMPAT_USER_ID).limited).toBe(true);
  });

  it("P6-RATE-06 窗口过期后恢复提交", async () => {
    const { clock, advance } = fakeClock();
    const ctx = await open({ chatSubmitRatePerMinute: 1, clock });
    const user = await newUserWithConversations(ctx, 3);

    expect((await send(ctx, user.cookie, user.conversationIds[0]!, "w-1")).status).toBe(202);
    expect((await send(ctx, user.cookie, user.conversationIds[1]!, "w-2")).status).toBe(429);

    advance(CHAT_SUBMIT_RATE_WINDOW_MS - 1);
    expect((await send(ctx, user.cookie, user.conversationIds[1]!, "w-3")).status).toBe(429);
    advance(1);
    expect((await send(ctx, user.cookie, user.conversationIds[2]!, "w-4")).status).toBe(202);
    expect((await counts(ctx.prisma)).pending).toBe(2);
  });

  it("P6-RATE-07 幂等重放同样算一次提交(它是真实的一次 HTTP 提交)", async () => {
    const { clock } = fakeClock();
    const ctx = await open({ chatSubmitRatePerMinute: 2, clock });
    const user = await newUserWithConversations(ctx, 1);
    const conv = user.conversationIds[0]!;

    expect((await send(ctx, user.cookie, conv, "replay-1")).status).toBe(202);
    const replay = await send(ctx, user.cookie, conv, "replay-1");
    expect(replay.status).toBe(200);
    expect((await send(ctx, user.cookie, conv, "replay-1")).status).toBe(429);
    expect((await counts(ctx.prisma)).requests).toBe(1);
  });

  it("P6-RATE-08 同一 User 的第二条 Session 共用同一个额度桶(§128)", async () => {
    const { clock } = fakeClock();
    const ctx = await open({ chatSubmitRatePerMinute: 1, clock });
    const user = await newUserWithConversations(ctx, 2);

    expect((await send(ctx, user.cookie, user.conversationIds[0]!, "sess-1")).status).toBe(202);
    expect((await send(ctx, user.cookie, user.conversationIds[1]!, "sess-2")).status).toBe(429);

    // 同一 User 再签一条 Session(库里第二行 token):身份没变,额度也不能重来
    const rawToken = generateSessionToken();
    const now = new Date();
    await ctx.prisma.session.create({
      data: {
        userId: user.userId,
        tokenHash: hashSessionToken(rawToken),
        expiresAt: new Date(now.getTime() + 60_000),
        lastSeenAt: now,
      },
    });
    expect((await send(ctx, `${AUTH_COOKIE_NAME}=${rawToken}`, user.conversationIds[1]!, "sess-3"))
      .status)
      .toBe(429);

    // 桶按 userId 计,换 Session 既没多出一个键,也没清零
    expect(ctx.rateLimits.chatSubmit.keyCount()).toBe(1);
    expect(ctx.rateLimits.chatSubmit.peek(user.userId).limited).toBe(true);
  });

  it("P6-RATE-09 ADMIN 重新登录换 Session 后额度不重置(§129)", async () => {
    const { clock } = fakeClock();
    const ctx = await open({ chatSubmitRatePerMinute: 1, clock });
    const first = await loginAdmin(ctx.baseUrl);
    const convOne = await newConversation(ctx, first);
    const convTwo = await newConversation(ctx, first);

    expect((await send(ctx, first, convOne, "admin-r1")).status).toBe(202);
    expect((await send(ctx, first, convTwo, "admin-r2")).status).toBe(429);

    // 二次登录拿到新 Session,身份仍是固定 ADMIN User ⇒ 同一个桶
    const second = await loginAdmin(ctx.baseUrl);
    expect(second).not.toBe(first);
    const convThree = await newConversation(ctx, second);
    expect((await send(ctx, second, convThree, "admin-r3")).status).toBe(429);
    expect(ctx.rateLimits.chatSubmit.keyCount()).toBe(1);
    expect(ctx.rateLimits.chatSubmit.peek(ADMIN_USER_ID).limited).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §27~§30 + §89:排队容量(单用户 / 全局两级)
// ─────────────────────────────────────────────────────────────────────────────

describe("P6-Q 排队容量准入", () => {
  it("P6-Q-01 单用户 PENDING 上限:第 3 条被拒,Public 码 SERVICE_BUSY + Retry-After", async () => {
    const ctx = await open({ userMaxPendingRequests: 2 });
    const user = await newUserWithConversations(ctx, 3);

    expect((await send(ctx, user.cookie, user.conversationIds[0]!, "q1-a")).status).toBe(202);
    expect((await send(ctx, user.cookie, user.conversationIds[1]!, "q1-b")).status).toBe(202);

    const blocked = await send(ctx, user.cookie, user.conversationIds[2]!, "q1-c");
    expect(blocked.status).toBe(429);
    expect(errorOf(blocked.body).code).toBe(PublicErrorCodes.SERVICE_BUSY);
    expect(blocked.retryAfter).toBe(String(QUEUE_FULL_RETRY_AFTER_SECONDS));

    const c = await counts(ctx.prisma);
    expect(c.pending).toBe(2);
    expect(c.requests).toBe(2);
    expect(c.messages).toBe(4);
  });

  it("P6-Q-02 全局 PENDING 上限:超容量按服务侧 503,与用户违规的 429 分档", async () => {
    const ctx = await open({ userMaxPendingRequests: 100, globalMaxPendingRequests: 3 });
    const a = await newUserWithConversations(ctx, 2);
    const b = await newUserWithConversations(ctx, 2);

    expect((await send(ctx, a.cookie, a.conversationIds[0]!, "q2-a1")).status).toBe(202);
    expect((await send(ctx, b.cookie, b.conversationIds[0]!, "q2-b1")).status).toBe(202);
    expect((await send(ctx, a.cookie, a.conversationIds[1]!, "q2-a2")).status).toBe(202);

    const blocked = await send(ctx, b.cookie, b.conversationIds[1]!, "q2-b2");
    expect(blocked.status).toBe(503);
    expect(errorOf(blocked.body).code).toBe(PublicErrorCodes.SERVICE_BUSY);
    expect(blocked.retryAfter).toBe(String(QUEUE_FULL_RETRY_AFTER_SECONDS));
    expect((await counts(ctx.prisma)).pending).toBe(3);
  });

  it("P6-Q-03 同一用户并发提交不会超发(配额复核与创建成对串行)", async () => {
    const ctx = await open({ userMaxPendingRequests: 2 });
    const user = await newUserWithConversations(ctx, 5);

    const results = await Promise.all(
      user.conversationIds.map((id, i) => send(ctx, user.cookie, id, `q3-${i}`)),
    );
    expect(results.filter((r) => r.status === 202)).toHaveLength(2);
    expect(results.filter((r) => r.status === 429)).toHaveLength(3);
    const c = await counts(ctx.prisma);
    // 恰好卡在 2 条:既没超发,也没因串行化而少发
    expect(c.pending).toBe(2);
    expect(c.requests).toBe(2);
    expect(c.messages).toBe(4);
  });

  it("P6-Q-04 多用户并发同样不能突破全局容量", async () => {
    const ctx = await open({ userMaxPendingRequests: 100, globalMaxPendingRequests: 3 });
    const a = await newUserWithConversations(ctx, 3);
    const b = await newUserWithConversations(ctx, 3);

    const results = await Promise.all([
      ...a.conversationIds.map((id, i) => send(ctx, a.cookie, id, `q4-a${i}`)),
      ...b.conversationIds.map((id, i) => send(ctx, b.cookie, id, `q4-b${i}`)),
    ]);
    expect(results.filter((r) => r.status === 202)).toHaveLength(3);
    expect(results.filter((r) => r.status === 503)).toHaveLength(3);
    expect((await counts(ctx.prisma)).pending).toBe(3);
  });

  it("P6-Q-05 拒绝路径零副作用:不落 Message/Request、不占附件 slot、不 notify", async () => {
    const ctx = await open({ userMaxPendingRequests: 1 });
    const user = await newUserWithConversations(ctx, 2);
    expect((await send(ctx, user.cookie, user.conversationIds[0]!, "q5-a")).status).toBe(202);
    expect(ctx.scheduler?.snapshotQueue().queuedRequestIds).toHaveLength(1);

    const before = await counts(ctx.prisma);
    const blocked = await send(
      ctx,
      user.cookie,
      user.conversationIds[1]!,
      "q5-b",
      "with image",
      [attachment("image/png")],
    );
    expect(blocked.status).toBe(429);

    expect(await counts(ctx.prisma)).toEqual(before);
    // 附件账本:一个 slot、一个字节都没有
    expect(ctx.attachmentStore.stats()).toEqual({ slotCount: 0, liveBytes: 0, slots: [] });
    // 队列里没有第二条:被拒的请求绝不进公平队列
    expect(ctx.scheduler?.snapshotQueue().queuedRequestIds).toHaveLength(1);
  });

  it("P6-Q-06 队列已满不影响同 Key 幂等重放", async () => {
    const ctx = await open({ userMaxPendingRequests: 1, globalMaxPendingRequests: 1 });
    const user = await newUserWithConversations(ctx, 2);

    const first = await send(ctx, user.cookie, user.conversationIds[0]!, "q6-key");
    expect(first.status).toBe(202);
    const requestId = requestIdOf(first.body);

    // 两级配额都已满,但合法重放必须原样返回既有 Request,不能变成 429/503
    const replay = await send(ctx, user.cookie, user.conversationIds[0]!, "q6-key");
    expect(replay.status).toBe(200);
    expect(requestIdOf(replay.body)).toBe(requestId);
    // 而真正的新建仍被拦(重放没有偷偷腾出额度)
    expect((await send(ctx, user.cookie, user.conversationIds[1]!, "q6-new")).status).toBe(429);
    expect((await counts(ctx.prisma)).requests).toBe(1);
  });

  it("P6-Q-07 存量超限数据只读保留,但新的准入仍被拒", async () => {
    const ctx = await open({ userMaxPendingRequests: 2 });
    const user = await newUserWithConversations(ctx, 1);

    const seeded: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      seeded.push(await seedPendingRequest(ctx.prisma, user.userId));
    }
    expect(await ctx.prisma.modelRequest.count({ where: { status: "PENDING" } })).toBe(4);

    const blocked = await send(ctx, user.cookie, user.conversationIds[0]!, "q7-new");
    expect(blocked.status).toBe(429);
    expect(errorOf(blocked.body).code).toBe(PublicErrorCodes.SERVICE_BUSY);

    // 拒绝不等于清理:存量行一条都没被动过
    const kept = await ctx.prisma.modelRequest.findMany({
      where: { id: { in: seeded } },
      select: { id: true, status: true },
    });
    expect(kept).toHaveLength(4);
    expect(kept.every((row) => row.status === "PENDING")).toBe(true);
    expect((await counts(ctx.prisma)).requests).toBe(4);
  });

  it("P6-Q-08 配额按 owner 计数,别的用户的积压不占自己的额度", async () => {
    const ctx = await open({ userMaxPendingRequests: 2 });
    const a = await newUserWithConversations(ctx, 2);
    const b = await newUserWithConversations(ctx, 2);

    // B 先把全局队列填到 2 条:helper 的默认全局上限远大于此,所以拦人的只可能是 owner 计数
    expect((await send(ctx, b.cookie, b.conversationIds[0]!, "q8-b1")).status).toBe(202);
    expect((await send(ctx, b.cookie, b.conversationIds[1]!, "q8-b2")).status).toBe(202);
    expect((await send(ctx, a.cookie, a.conversationIds[0]!, "q8-a1")).status).toBe(202);
    expect((await send(ctx, a.cookie, a.conversationIds[1]!, "q8-a2")).status).toBe(202);
    expect((await counts(ctx.prisma)).pending).toBe(4);
  });

  it("P6-Q-09 ADMIN 同样受排队容量约束,没有任何容量 bypass(§135)", async () => {
    const ctx = await open({ userMaxPendingRequests: 2 });
    const admin = await loginAdmin(ctx.baseUrl);
    const convs: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      convs.push(await newConversation(ctx, admin));
    }

    expect((await send(ctx, admin, convs[0]!, "q9-1")).status).toBe(202);
    expect((await send(ctx, admin, convs[1]!, "q9-2")).status).toBe(202);
    const blocked = await send(ctx, admin, convs[2]!, "q9-3");
    expect(blocked.status).toBe(429);
    expect(errorOf(blocked.body).code).toBe(PublicErrorCodes.SERVICE_BUSY);
    expect((await counts(ctx.prisma)).pending).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §130~§131:两层限额互补 —— 「换身份继续刷」的威胁链必须闭合
// ─────────────────────────────────────────────────────────────────────────────

describe("P6-CHAIN 换身份刷额度的威胁链闭合", () => {
  it("P6-CHAIN-01 刷满额度→丢 Cookie→新匿名→继续刷,最终撞 per-IP 建号上限(§131)", async () => {
    const { clock } = fakeClock();
    // 每身份只允许 1 条提交,同源最多建 3 个身份
    const ctx = await open({
      chatSubmitRatePerMinute: 1,
      anonymousIpLimitPerHour: 3,
      anonymousIpLimitPerDay: 100,
      clock,
    });

    let createdIdentities = 0;
    let blockedAttempt = 0;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      // 攻击者丢掉 Cookie ⇒ 新 userId ⇒ Chat 桶确实被重置(§130),这正是建号限额存在的理由
      const res = await anonymous(ctx.baseUrl);
      if (res.status === 429) {
        blockedAttempt = attempt;
        expect(errorOf(await res.json()).code).toBe(ErrorCodes.AUTH_RATE_LIMITED);
        break;
      }
      const cookie = cookieOf(res);
      createdIdentities += 1;
      const first = await newConversation(ctx, cookie);
      expect((await send(ctx, cookie, first, `chain-${attempt}-1`)).status).toBe(202);
      const second = await newConversation(ctx, cookie);
      expect((await send(ctx, cookie, second, `chain-${attempt}-2`)).status).toBe(429);
    }

    // 换身份的收益被封顶在「能建出多少个身份」,而不是无限
    expect(blockedAttempt).toBe(4);
    expect(createdIdentities).toBe(3);
    const c = await counts(ctx.prisma);
    expect(c.createdAnonymousUsers).toBe(3);
    // 单 worker 下真正的吞吐上限仍是一条一条执行;这里数的是准入放行的条数
    expect(c.requests).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX-01B §15~§18:昂贵附件工作必须排在 ownership + 频率准入之后
// ─────────────────────────────────────────────────────────────────────────────

/** 接近单张上限的合法 PNG:昂贵程度要真实,不然「没跑」与「跑了」看不出差别 */
const HUGE_PNG_BYTES = ATTACHMENT_MAX_BYTES - 1_024;

describe("P6-PRE 昂贵附件工作的准入优先级(FIX-01B §15~§18)", () => {
  it("ABUSE-PRE-01 已超频的用户带近 5MB 合法图片:429 且解码/摘要/指纹/占位/notify 全为 0(§16)", async () => {
    const ctx = await open({ chatSubmitRatePerMinute: 1 });
    const user = await newUserWithConversations(ctx, 2);

    // 第一条把该用户的提交窗口用掉;它不带附件,不影响后面的计数
    expect((await send(ctx, user.cookie, user.conversationIds[0]!, "pre-01-first")).status).toBe(
      202,
    );

    resetExpensiveCalls();
    const fingerprint = spyFingerprint();
    const reserve = spyReserve(ctx);
    const notify = spyNotify();

    const blocked = await send(
      ctx,
      user.cookie,
      user.conversationIds[1]!,
      "pre-01-blocked",
      "看图",
      [attachment("image/png", HUGE_PNG_BYTES)],
    );
    expect(blocked.status).toBe(429);
    expect(errorOf(blocked.body).code).toBe(PublicErrorCodes.SERVICE_BUSY);

    // 拒绝发生在解码之前:附件路径一次都没进
    expect(expensiveCalls).toEqual({ parse: 0, digest: 0 });
    expect(fingerprint).toHaveBeenCalledTimes(0);
    expect(reserve).toHaveBeenCalledTimes(0);
    expect(notify).toHaveBeenCalledTimes(0);
    expect(ctx.attachmentStore.stats()).toEqual({ slotCount: 0, liveBytes: 0, slots: [] });
  });

  it("ABUSE-PRE-02 越权会话 + 大附件:先 404,同样一次昂贵路径都不走(§15/§17)", async () => {
    const ctx = await open({});
    const attacker = await newUserWithConversations(ctx, 1);
    const victim = await newUserWithConversations(ctx, 1);
    const before = await counts(ctx.prisma);

    resetExpensiveCalls();
    const fingerprint = spyFingerprint();
    const reserve = spyReserve(ctx);
    const notify = spyNotify();

    const res = await send(
      ctx,
      attacker.cookie,
      victim.conversationIds[0]!,
      "pre-02",
      "看图",
      [attachment("image/png", HUGE_PNG_BYTES)],
    );
    // 归属判据在前:跨用户请求连「附件类型对不对」都不该回答,免得拿错误码探别人的会话
    expect(res.status).toBe(404);
    expect(errorOf(res.body).code).toBe(ErrorCodes.CONVERSATION_NOT_FOUND);
    expect(expensiveCalls).toEqual({ parse: 0, digest: 0 });
    expect(fingerprint).toHaveBeenCalledTimes(0);
    expect(reserve).toHaveBeenCalledTimes(0);
    expect(notify).toHaveBeenCalledTimes(0);
    expect(ctx.attachmentStore.stats()).toEqual({ slotCount: 0, liveBytes: 0, slots: [] });
    expect(await counts(ctx.prisma)).toEqual(before);
  });

  it("ABUSE-PRE-03 合法归属且未超频:复核 / 指纹 / 占位 / 落库 / notify 一条不少(§18)", async () => {
    const ctx = await open({ chatSubmitRatePerMinute: 10 });
    const user = await newUserWithConversations(ctx, 1);

    resetExpensiveCalls();
    const fingerprint = spyFingerprint();
    const reserve = spyReserve(ctx);
    const notify = spyNotify();

    const items = [attachment("image/png", 2_048)];
    const res = await send(ctx, user.cookie, user.conversationIds[0]!, "pre-03", "看图", items);
    expect(res.status).toBe(202);

    expect(expensiveCalls).toEqual({ parse: 1, digest: 1 });
    expect(fingerprint).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    // 字节真的交接给了执行链:slot 在、份数落库、响应里没有附件内容
    expect(ctx.attachmentStore.stats().slotCount).toBe(1);
    const row = await ctx.prisma.modelRequest.findFirstOrThrow({
      where: { idempotencyKey: "pre-03" },
    });
    expect(row.attachmentCount).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain(items[0]!.data);
  });

  it("ABUSE-PRE-04 带图请求同 Key 重放:仍去重、绝不占第二个 slot(§19/§20)", async () => {
    const ctx = await open({ chatSubmitRatePerMinute: 10 });
    const user = await newUserWithConversations(ctx, 1);
    const items = [attachment("image/png", 2_048)];

    const first = await send(ctx, user.cookie, user.conversationIds[0]!, "pre-04", "看图", items);
    expect(first.status).toBe(202);
    const requestId = requestIdOf(first.body);

    resetExpensiveCalls();
    const reserve = spyReserve(ctx);
    const replay = await send(ctx, user.cookie, user.conversationIds[0]!, "pre-04", "看图", items);
    expect(replay.status).toBe(200);
    expect(requestIdOf(replay.body)).toBe(requestId);

    // 重放算一次提交(§19 不变),但绝不新建 slot,也不留第二条 Request
    expect(reserve).toHaveBeenCalledTimes(0);
    expect(ctx.attachmentStore.stats().slotCount).toBe(1);
    expect((await counts(ctx.prisma)).requests).toBe(1);
    // 复核与指纹照旧要跑:没有指纹就判不出「同一条 payload」——重放者是过了准入的 owner,这笔账该付
    expect(expensiveCalls).toEqual({ parse: 1, digest: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P10 §45~§59:限流器键容量 fail-closed(不再淘汰 active bucket)
// ─────────────────────────────────────────────────────────────────────────────

describe("P6-CAP 限流器容量 fail-closed(P10 §50/§51/§52/§57/§58)", () => {
  it("LIMIT-CAP-04 匿名限流器满容量:新 IP 503 SERVICE_BUSY,0 User / 0 Session(§57)", async () => {
    // trust proxy=loopback 让「测试客户端 = 环形回源」成立:用 X-Forwarded-For 仿真三个来源 IP,
    // 每个 IP 恰好建 1 个身份就把两个窗口的 map(maxKeys=2)填满,第三个 IP 撞 fail-closed。
    const ctx = await open(
      { anonymousIpLimitPerHour: 1, anonymousIpLimitPerDay: 100, maxKeys: 2 },
      authDeps({ trustProxy: true }),
    );
    const create = async (xff: string): Promise<Response> =>
      fetch(`${ctx.baseUrl}/api/auth/anonymous`, {
        method: "POST",
        headers: { "X-Forwarded-For": xff },
      });

    expect((await create("203.0.113.1")).status).toBe(200);
    expect((await create("203.0.113.2")).status).toBe(200);

    const third = await create("203.0.113.3");
    expect(third.status).toBe(503);
    expect(errorOf(await third.json()).code).toBe(PublicErrorCodes.SERVICE_BUSY);
    // 零副作用:这次 503 没有创建任何 User / Session
    const c = await counts(ctx.prisma);
    expect(c.createdAnonymousUsers).toBe(2);
    expect(c.sessions).toBe(2);

    // 已存在的 IP 不受影响:满容量下它们照常按自己的窗口判定(§52)
    const replayed = await create("203.0.113.1");
    expect(replayed.status).toBe(429); // 它自己 1 次/小时的额度已用完
    expect(errorOf(await replayed.json()).code).toBe(ErrorCodes.AUTH_RATE_LIMITED);
  });

  it("LIMIT-CAP-05 消息限流器满容量:新用户 503 SERVICE_BUSY,零 Message/Request/reserve(§58)", async () => {
    const ctx = await open({ chatSubmitRatePerMinute: 10_000, maxKeys: 2 });
    const user1 = await newUserWithConversations(ctx, 2);
    const user2 = await newUserWithConversations(ctx, 1);
    const user3 = await newUserWithConversations(ctx, 1);

    expect((await send(ctx, user1.cookie, user1.conversationIds[0]!, "cap-5-a")).status).toBe(202);
    expect((await send(ctx, user2.cookie, user2.conversationIds[0]!, "cap-5-b")).status).toBe(202);

    // chatSubmitLimiter 已有 user1/user2 两个键 = 满容量(user3 是新键)
    resetExpensiveCalls();
    const blocked = await send(
      ctx,
      user3.cookie,
      user3.conversationIds[0]!,
      "cap-5-c",
      "hi",
      [attachment("image/png")],
    );
    expect(blocked.status).toBe(503);
    expect(errorOf(blocked.body).code).toBe(PublicErrorCodes.SERVICE_BUSY);
    // 昂贵附件路径与占位都发生在频率准入之后:一次都不许跑
    expect(expensiveCalls).toEqual({ parse: 0, digest: 0 });
    expect(ctx.attachmentStore.stats()).toEqual({ slotCount: 0, liveBytes: 0, slots: [] });
    // 零副作用:请求数仍只有前面两条,user3 的身份也没产生任何业务数据
    expect((await counts(ctx.prisma)).requests).toBe(2);
    expect(await ctx.prisma.modelRequest.count({ where: { userMessage: { conversation: { userId: user3.userId } } } })).toBe(0);

    // §52:已存在的键在满容量下照常工作(user1 自己还有额度,换个会话继续发)
    expect(
      (await send(ctx, user1.cookie, user1.conversationIds[1]!, "cap-5-a2")).status,
    ).toBe(202);
    expect((await counts(ctx.prisma)).requests).toBe(3);
  });
});
