import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../../src/common/logger/logger.js";
import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import {
  ADMIN_USER_ID,
  AUTH_COOKIE_NAME,
  COMPAT_USER_ID,
} from "../../src/config/constants.js";
import { parseEnv } from "../../src/config/env.js";
import { AuthSessionRepository } from "../../src/modules/auth/auth.session.repository.js";
import { AuthSessionService } from "../../src/modules/auth/auth.session.service.js";
import { hashSessionToken } from "../../src/modules/auth/auth.session-token.js";
import { AuthUserRepository } from "../../src/modules/auth/auth.user.repository.js";
import type { AuthDeps } from "../../src/modules/auth/auth.types.js";
import { setupTestContext, type TestContext } from "../helpers.js";

const PASSWORD = "test-password-123";
const TTL_ANON = 7200;
const TTL_ADMIN = 3600;
/** V1.4 U2:与 anon/admin 都不同,便于断言 TTL 选档 */
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

/** 每用例独立 app + 清库(本文件大量按行计数断言,必须干净起点) */
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

function cookieHeader(res: Response): string | null {
  const raw = res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
  return raw ? raw.split(";")[0] : null;
}

function rawTokenOf(cookie: string): string {
  return cookie.slice(AUTH_COOKIE_NAME.length + 1);
}

async function login(
  baseUrl: string,
  password: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ password }),
  });
}

async function bootstrapAnonymous(baseUrl: string, cookie?: string): Promise<Response> {
  return fetch(`${baseUrl}/api/auth/anonymous`, {
    method: "POST",
    ...(cookie === undefined ? {} : { headers: { Cookie: cookie } }),
  });
}

async function sessionRowOf(ctx: TestContext, rawToken: string) {
  return ctx.prisma.session.findUnique({ where: { tokenHash: hashSessionToken(rawToken) } });
}

async function nonSentinelUserCount(ctx: TestContext): Promise<number> {
  return ctx.prisma.user.count({
    where: { id: { notIn: [ADMIN_USER_ID, COMPAT_USER_ID] } },
  });
}

function expectWithinSeconds(actualMs: number, expectedMs: number, toleranceSeconds = 10): void {
  expect(Math.abs(actualMs - expectedMs)).toBeLessThanOrEqual(toleranceSeconds * 1000);
}

describe("SESS-01/02/03/05 DB Session 存储与校验(§5)", () => {
  it("SESS-01/02 登录:Cookie 为 opaque token;DB 只存 sha256 摘要,不存 raw", async () => {
    await withApp(async (ctx) => {
      const loginRes = await login(ctx.baseUrl, PASSWORD);
      const cookie = cookieHeader(loginRes)!;
      const raw = rawTokenOf(cookie);

      expect(raw).toHaveLength(43);
      expect(raw).not.toContain(".");
      expect(Buffer.from(raw, "base64url")).toHaveLength(32);

      const row = await sessionRowOf(ctx, raw);
      expect(row).not.toBeNull();
      expect(row!.userId).toBe(ADMIN_USER_ID);
      expect(row!.tokenHash).toBe(createHash("sha256").update(raw, "utf8").digest("hex"));
      expect(row!.tokenHash).not.toBe(raw);
      expect(JSON.stringify(row)).not.toContain(raw);
    });
  });

  it("SESS-03 有效 Cookie 通过业务 API;probe 不泄露 userId/sessionId/tokenHash", async () => {
    await withApp(async (ctx) => {
      const loginRes = await login(ctx.baseUrl, PASSWORD);
      const cookie = cookieHeader(loginRes)!;

      const business = await fetch(`${ctx.baseUrl}/api/conversations`, {
        headers: { Cookie: cookie },
      });
      expect(business.status).toBe(200);

      const probe = await fetch(`${ctx.baseUrl}/api/auth/session`, {
        headers: { Cookie: cookie },
      });
      expect(probe.status).toBe(200);
      const body = (await probe.json()) as { data: Record<string, unknown> };
      // V1.4 U2 §37/§70:auth DTO 的**有意契约扩展** —— authenticated 面从 3 键变 4 键,
      // 新增 `username: string | null`(ANONYMOUS / ADMIN / COMPAT 恒 null,REGISTERED 才是登录名)。
      // 这不是放宽断言:仍要求键集合逐字相等 ⇒ 凭据列 `passwordHash` / `usernameNormalized`
      // 与 userId / sessionId / tokenHash 一样,依然没有任何机会出现在 Public 面。
      expect(Object.keys(body.data).sort()).toEqual([
        "authenticated",
        "expiresAt",
        "userType",
        "username",
      ]);
    });
  });

  it("SESS-05 旧 V1.2 HMAC Cookie(含 '.')→ 401 / probe false,不 500", async () => {
    await withApp(async (ctx) => {
      const legacy = `${Buffer.from("legacy").toString("base64url")}.${"b".repeat(43)}`;
      const business = await fetch(`${ctx.baseUrl}/api/conversations`, {
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${legacy}` },
      });
      expect(business.status).toBe(401);

      const probe = await fetch(`${ctx.baseUrl}/api/auth/session`, {
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${legacy}` },
      });
      expect(probe.status).toBe(200);
      const body = (await probe.json()) as { data: { authenticated: boolean } };
      expect(body.data.authenticated).toBe(false);
    });
  });
});

describe("ANON-01..03 匿名 bootstrap(§8)", () => {
  it("ANON-01 首个 bootstrap:事务内建 User + Session 并 Set-Cookie", async () => {
    await withApp(async (ctx) => {
      const res = await bootstrapAnonymous(ctx.baseUrl);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { authenticated: boolean; expiresAt: string; userType: string };
      };
      expect(body.data).toMatchObject({ authenticated: true, userType: "ANONYMOUS" });

      const cookie = cookieHeader(res);
      expect(cookie).not.toBeNull();
      const raw = rawTokenOf(cookie!);
      const row = await sessionRowOf(ctx, raw);
      expect(row).not.toBeNull();
      expect(row!.userId).not.toBe(ADMIN_USER_ID);

      const user = await ctx.prisma.user.findUnique({ where: { id: row!.userId } });
      expect(user).toMatchObject({ type: "ANONYMOUS", status: "ACTIVE" });
      expect(await ctx.prisma.session.count()).toBe(1);

      // Cookie 在业务 API 上有效
      const business = await fetch(`${ctx.baseUrl}/api/conversations`, {
        headers: { Cookie: cookie! },
      });
      expect(business.status).toBe(200);

      expectWithinSeconds(row!.expiresAt.getTime(), Date.now() + TTL_ANON * 1000);
    });
  });

  it("ANON-02 已有有效 ANONYMOUS Session:幂等(不建 User/Session,不覆盖 Cookie)", async () => {
    await withApp(async (ctx) => {
      const first = await bootstrapAnonymous(ctx.baseUrl);
      const cookie = cookieHeader(first)!;
      const before = await sessionRowOf(ctx, rawTokenOf(cookie));

      const second = await bootstrapAnonymous(ctx.baseUrl, cookie);
      expect(second.status).toBe(200);
      expect(second.headers.getSetCookie()).toHaveLength(0);

      expect(await ctx.prisma.session.count()).toBe(1);
      expect(await nonSentinelUserCount(ctx)).toBe(1);
      const after = await sessionRowOf(ctx, rawTokenOf(cookie));
      expect(after!.id).toBe(before!.id);
      expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
    });
  });

  it("ANON-03 已有有效 ADMIN Session:幂等返回 ADMIN,不降级不建匿名行", async () => {
    await withApp(async (ctx) => {
      const loginRes = await login(ctx.baseUrl, PASSWORD);
      const cookie = cookieHeader(loginRes)!;

      const res = await bootstrapAnonymous(ctx.baseUrl, cookie);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { userType: string } };
      expect(body.data.userType).toBe("ADMIN");
      expect(res.headers.getSetCookie()).toHaveLength(0);

      expect(await ctx.prisma.session.count()).toBe(1);
      expect(await nonSentinelUserCount(ctx)).toBe(0);
    });
  });

  it("ANON-04 事务失败 → User 不残留(真实事务回滚)", async () => {
    await withApp(async (ctx) => {
      const repo = new AuthSessionRepository();
      const createSpy = vi.spyOn(repo, "create").mockRejectedValueOnce(new Error("forced failure"));
      const service = new AuthSessionService({
        prisma: ctx.prisma,
        sessions: repo,
        users: new AuthUserRepository(),
        logger: createLogger("silent"),
        options: {
          ttlAnonymousSeconds: TTL_ANON,
          ttlRegisteredSeconds: TTL_REGISTERED,
          ttlAdminSeconds: TTL_ADMIN,
          touchIntervalSeconds: TOUCH_INTERVAL,
        },
      });

      await expect(service.bootstrapAnonymous(undefined)).rejects.toThrow("forced failure");
      createSpy.mockRestore();
      expect(await nonSentinelUserCount(ctx)).toBe(0);
      expect(await ctx.prisma.session.count()).toBe(0);
    });
  });
});

describe("DISABLED-01/02 User.status=DISABLED 边界(§8)", () => {
  it("DISABLED-01 业务请求 401;probe 返回 authenticated:false", async () => {
    await withApp(async (ctx) => {
      const boot = await bootstrapAnonymous(ctx.baseUrl);
      const cookie = cookieHeader(boot)!;
      const row = await sessionRowOf(ctx, rawTokenOf(cookie));
      await ctx.prisma.user.update({
        where: { id: row!.userId },
        data: { status: "DISABLED" },
      });

      const business = await fetch(`${ctx.baseUrl}/api/conversations`, {
        headers: { Cookie: cookie },
      });
      expect(business.status).toBe(401);

      const probe = await fetch(`${ctx.baseUrl}/api/auth/session`, {
        headers: { Cookie: cookie },
      });
      const body = (await probe.json()) as { data: { authenticated: boolean } };
      expect(body.data.authenticated).toBe(false);
    });
  });

  it("DISABLED-02 anonymous 拒绝:401,不新建 User/Session、不覆盖 Cookie", async () => {
    await withApp(async (ctx) => {
      const boot = await bootstrapAnonymous(ctx.baseUrl);
      const cookie = cookieHeader(boot)!;
      const row = await sessionRowOf(ctx, rawTokenOf(cookie));
      await ctx.prisma.user.update({
        where: { id: row!.userId },
        data: { status: "DISABLED" },
      });

      const res = await bootstrapAnonymous(ctx.baseUrl, cookie);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe(ErrorCodes.AUTH_REQUIRED);
      expect(res.headers.getSetCookie()).toHaveLength(0);

      expect(await nonSentinelUserCount(ctx)).toBe(1);
      expect(await ctx.prisma.session.count()).toBe(1);
    });
  });
});

describe("LOGIN-01..03 ADMIN 登录与身份切换(§10/§11)", () => {
  it("LOGIN-01 Anonymous → ADMIN:旧 Cookie 失效,新 Cookie 为 ADMIN,旧 Session 已删", async () => {
    await withApp(async (ctx) => {
      const boot = await bootstrapAnonymous(ctx.baseUrl);
      const anonCookie = cookieHeader(boot)!;
      const anonUserId = (await sessionRowOf(ctx, rawTokenOf(anonCookie)))!.userId;

      // 真实浏览器登录时会自动带上现有 Cookie:服务端据此删旧 Session
      const loginRes = await login(ctx.baseUrl, PASSWORD, { Cookie: anonCookie });
      expect(loginRes.status).toBe(200);
      const adminCookie = cookieHeader(loginRes)!;
      expect(adminCookie).not.toBe(anonCookie);

      // 旧匿名 Cookie 立即失效
      const oldUse = await fetch(`${ctx.baseUrl}/api/conversations`, {
        headers: { Cookie: anonCookie },
      });
      expect(oldUse.status).toBe(401);
      expect(await sessionRowOf(ctx, rawTokenOf(anonCookie))).toBeNull();

      // 新 Cookie 是 ADMIN
      const probe = await fetch(`${ctx.baseUrl}/api/auth/session`, {
        headers: { Cookie: adminCookie },
      });
      const body = (await probe.json()) as { data: { userType: string } };
      expect(body.data.userType).toBe("ADMIN");
      const adminRow = await sessionRowOf(ctx, rawTokenOf(adminCookie));
      expect(adminRow!.userId).toBe(ADMIN_USER_ID);
      expect(await ctx.prisma.session.count()).toBe(1);

      // 匿名 User 本身仍在(只是不再有 Session);Conversation 归属不变见 LOGIN-02
      expect(await ctx.prisma.user.findUnique({ where: { id: anonUserId } })).not.toBeNull();
    });
  });

  it("LOGIN-02 登录 ADMIN 不改写匿名 User 的 Conversation.userId(数据不转移)", async () => {
    await withApp(async (ctx) => {
      const boot = await bootstrapAnonymous(ctx.baseUrl);
      const cookie = cookieHeader(boot)!;
      const row = await sessionRowOf(ctx, rawTokenOf(cookie));
      const anonUserId = row!.userId;

      // B2 不做 ownership runtime:直接构造带 userId 的 Conversation 作为迁移期数据
      const conversation = await ctx.prisma.conversation.create({
        data: { title: "anon-data", userId: anonUserId },
      });

      const loginRes = await login(ctx.baseUrl, PASSWORD);
      expect(loginRes.status).toBe(200);

      const after = await ctx.prisma.conversation.findUnique({
        where: { id: conversation.id },
      });
      expect(after!.userId).toBe(anonUserId);
      expect(await ctx.prisma.user.findUnique({ where: { id: anonUserId } })).not.toBeNull();
    });
  });

  it("LOGIN-03 ADMIN 二次登录:旧 ADMIN Cookie 失效(轮换),仅保留最新 Session", async () => {
    await withApp(async (ctx) => {
      const first = cookieHeader(await login(ctx.baseUrl, PASSWORD))!;
      // 二次登录携带第一次的 Cookie:旧 Session 必须被删除(轮换)
      const second = cookieHeader(await login(ctx.baseUrl, PASSWORD, { Cookie: first }))!;

      const oldUse = await fetch(`${ctx.baseUrl}/api/conversations`, {
        headers: { Cookie: first },
      });
      expect(oldUse.status).toBe(401);

      const newUse = await fetch(`${ctx.baseUrl}/api/conversations`, {
        headers: { Cookie: second },
      });
      expect(newUse.status).toBe(200);
      expect(await ctx.prisma.session.count()).toBe(1);
    });
  });
});

describe("LOGIN-04..06 登录失败不破坏当前身份(Review FIX-01 原子性)", () => {
  /**
   * 让下一次 Session 写入失败:spy 挂在 Repository 原型上 ——
   * app 内部的服务实例方法查找走原型,因此无需任何生产代码接缝就能在 HTTP 层注入故障。
   */
  function failNextSessionCreate(): void {
    vi.spyOn(AuthSessionRepository.prototype, "create").mockRejectedValueOnce(
      new Error("forced session insert failure"),
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("LOGIN-04 匿名 → ADMIN 创建失败:原匿名 Session 真实存活、仍可认证、无 Set-Cookie、数据不变", async () => {
    await withApp(async (ctx) => {
      const boot = await bootstrapAnonymous(ctx.baseUrl);
      const anonCookie = cookieHeader(boot)!;
      const anonRow = await sessionRowOf(ctx, rawTokenOf(anonCookie));
      const conversation = await ctx.prisma.conversation.create({
        data: { title: "anon-rollback", userId: anonRow!.userId },
      });

      failNextSessionCreate();
      const res = await login(ctx.baseUrl, PASSWORD, { Cookie: anonCookie });

      expect(res.status).toBe(500);
      expect(
        res.headers
          .getSetCookie()
          .filter((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`)),
      ).toHaveLength(0);

      // 事务回滚的真实 DB 证据:旧 Session 行仍在且 id 未变(不是 mock 断言)
      const survivor = await sessionRowOf(ctx, rawTokenOf(anonCookie));
      expect(survivor).not.toBeNull();
      expect(survivor!.id).toBe(anonRow!.id);

      // 原 Cookie 仍可认证业务 API
      const business = await fetch(`${ctx.baseUrl}/api/conversations`, {
        headers: { Cookie: anonCookie },
      });
      expect(business.status).toBe(200);

      // 没有新增 ADMIN Session,总数不变
      expect(await ctx.prisma.session.count({ where: { userId: ADMIN_USER_ID } })).toBe(0);
      expect(await ctx.prisma.session.count()).toBe(1);

      // Conversation 归属不变
      const after = await ctx.prisma.conversation.findUnique({
        where: { id: conversation.id },
      });
      expect(after!.userId).toBe(anonRow!.userId);
    });
  });

  it("LOGIN-05 ADMIN rotation 创建失败:S1 仍有效,Session 数量无破坏性变化,无新 Cookie", async () => {
    await withApp(async (ctx) => {
      const first = cookieHeader(await login(ctx.baseUrl, PASSWORD))!;

      failNextSessionCreate();
      const res = await login(ctx.baseUrl, PASSWORD, { Cookie: first });

      expect(res.status).toBe(500);
      expect(
        res.headers
          .getSetCookie()
          .filter((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`)),
      ).toHaveLength(0);

      // S1 回滚存活且仍可认证
      const survivor = await sessionRowOf(ctx, rawTokenOf(first));
      expect(survivor).not.toBeNull();
      const business = await fetch(`${ctx.baseUrl}/api/conversations`, {
        headers: { Cookie: first },
      });
      expect(business.status).toBe(200);

      expect(await ctx.prisma.session.count()).toBe(1);
      expect(await ctx.prisma.session.count({ where: { userId: ADMIN_USER_ID } })).toBe(1);
    });
  });

  it("LOGIN-06 固定 ADMIN User 被 DISABLED:登录失败,匿名身份完好,不 Set-Cookie", async () => {
    await withApp(async (ctx) => {
      const boot = await bootstrapAnonymous(ctx.baseUrl);
      const anonCookie = cookieHeader(boot)!;

      await ctx.prisma.user.update({
        where: { id: ADMIN_USER_ID },
        data: { status: "DISABLED" },
      });
      let res: Response;
      try {
        res = await login(ctx.baseUrl, PASSWORD, { Cookie: anonCookie });
      } finally {
        // reset() 不恢复哨兵行状态:必须在本用例内还原,避免污染后续用例
        await ctx.prisma.user.update({
          where: { id: ADMIN_USER_ID },
          data: { status: "ACTIVE" },
        });
      }

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      // §17(B3-2):ADMIN 哨兵行缺失/被禁用是服务端内部异常,对外只剩 CHAT_FAILED(仍 500)——
      // 匿名调用者不能据此推断「管理员被禁用了」
      expect(body.error.code).toBe("CHAT_FAILED");
      expect(
        res.headers
          .getSetCookie()
          .filter((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`)),
      ).toHaveLength(0);

      // 匿名 Session 未被触碰,仍可认证
      expect(await sessionRowOf(ctx, rawTokenOf(anonCookie))).not.toBeNull();
      const business = await fetch(`${ctx.baseUrl}/api/conversations`, {
        headers: { Cookie: anonCookie },
      });
      expect(business.status).toBe(200);
      expect(await ctx.prisma.session.count({ where: { userId: ADMIN_USER_ID } })).toBe(0);
    });
  });
});

describe("TTL-01/02 匿名与 ADMIN TTL 分离(§15)", () => {
  it("TTL-01 匿名 Session:DB expiresAt 与 Cookie Max-Age 均为 ANONYMOUS TTL", async () => {
    await withApp(async (ctx) => {
      const res = await bootstrapAnonymous(ctx.baseUrl);
      const setCookie = res.headers
        .getSetCookie()
        .find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`))!;
      expect(setCookie).toContain(`Max-Age=${TTL_ANON}`);
      expect(setCookie).not.toContain(`Max-Age=${TTL_ADMIN}`);

      const row = await sessionRowOf(ctx, rawTokenOf(cookieHeader(res)!));
      expectWithinSeconds(row!.expiresAt.getTime(), Date.now() + TTL_ANON * 1000);
    });
  });

  it("TTL-02 ADMIN Session:DB expiresAt 与 Cookie Max-Age 均为 ADMIN TTL", async () => {
    await withApp(async (ctx) => {
      const res = await login(ctx.baseUrl, PASSWORD);
      const setCookie = res.headers
        .getSetCookie()
        .find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`))!;
      expect(setCookie).toContain(`Max-Age=${TTL_ADMIN}`);
      expect(setCookie).not.toContain(`Max-Age=${TTL_ANON}`);

      const row = await sessionRowOf(ctx, rawTokenOf(cookieHeader(res)!));
      expectWithinSeconds(row!.expiresAt.getTime(), Date.now() + TTL_ADMIN * 1000);
    });
  });
});

describe("TOUCH-01..03 滑动续期(§13)", () => {
  async function bootstrapWithStaleLastSeen(ctx: TestContext): Promise<string> {
    const boot = await bootstrapAnonymous(ctx.baseUrl);
    const cookie = cookieHeader(boot)!;
    const row = await sessionRowOf(ctx, rawTokenOf(cookie));
    await ctx.prisma.session.update({
      where: { id: row!.id },
      data: { lastSeenAt: new Date(Date.now() - (TOUCH_INTERVAL + 60) * 1000) },
    });
    return cookie;
  }

  it("TOUCH-01 未达阈值:lastSeenAt/expiresAt 不变,无 Set-Cookie", async () => {
    await withApp(async (ctx) => {
      const boot = await bootstrapAnonymous(ctx.baseUrl);
      const cookie = cookieHeader(boot)!;
      const before = await sessionRowOf(ctx, rawTokenOf(cookie));

      const res = await fetch(`${ctx.baseUrl}/api/conversations`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie()).toHaveLength(0);

      const after = await sessionRowOf(ctx, rawTokenOf(cookie));
      expect(after!.lastSeenAt.getTime()).toBe(before!.lastSeenAt.getTime());
      expect(after!.expiresAt.getTime()).toBe(before!.expiresAt.getTime());
    });
  });

  it("TOUCH-02 达阈值:CAS 胜者续期 DB 并重发同 raw token 的 Set-Cookie", async () => {
    await withApp(async (ctx) => {
      const cookie = await bootstrapWithStaleLastSeen(ctx);
      const raw = rawTokenOf(cookie);
      const before = await sessionRowOf(ctx, raw);

      const res = await fetch(`${ctx.baseUrl}/api/conversations`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
      const setCookie = res.headers
        .getSetCookie()
        .find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
      expect(setCookie).toBeDefined();
      // raw token 不换,只刷新生命周期
      expect(setCookie).toContain(`${AUTH_COOKIE_NAME}=${raw}`);
      expect(setCookie).toContain(`Max-Age=${TTL_ANON}`);

      const after = await sessionRowOf(ctx, raw);
      expect(after!.lastSeenAt.getTime()).toBeGreaterThan(before!.lastSeenAt.getTime());
      expect(after!.expiresAt.getTime()).toBeGreaterThan(before!.expiresAt.getTime());
    });
  });

  it("TOUCH-03 并发业务请求:同一 window 至多一个胜者重发 Cookie", async () => {
    await withApp(async (ctx) => {
      const cookie = await bootstrapWithStaleLastSeen(ctx);

      const [a, b] = await Promise.all([
        fetch(`${ctx.baseUrl}/api/conversations`, { headers: { Cookie: cookie } }),
        fetch(`${ctx.baseUrl}/api/conversations`, { headers: { Cookie: cookie } }),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);

      const renewed = [a, b].filter((res) =>
        res.headers
          .getSetCookie()
          .some((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`)),
      );
      expect(renewed).toHaveLength(1);
    });
  });
});

describe("SWEEP-01 过期 Session 清理(§19)", () => {
  it("只删已过期 Session,不删未过期 Session,并清理失效匿名 User", async () => {
    await withApp(async (ctx) => {
      const boot = await bootstrapAnonymous(ctx.baseUrl);
      const anonCookie = cookieHeader(boot)!;
      const expired = await sessionRowOf(ctx, rawTokenOf(anonCookie));
      await ctx.prisma.session.update({
        where: { id: expired!.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const loginRes = await login(ctx.baseUrl, PASSWORD);
      const adminRow = await sessionRowOf(ctx, rawTokenOf(cookieHeader(loginRes)!));

      expect(await ctx.authSessions!.sweepExpired()).toBe(1);
      expect(await sessionRowOf(ctx, rawTokenOf(anonCookie))).toBeNull();
      expect(await ctx.prisma.session.findUnique({ where: { id: adminRow!.id } })).not.toBeNull();
      expect(await ctx.prisma.user.findUnique({ where: { id: expired!.userId } })).toBeNull();
      // 幂等:再清一次为 0
      expect(await ctx.authSessions!.sweepExpired()).toBe(0);
    });
  });
});

describe("COMPAT-01 AUTH_ENABLED=false + loopback(§18)", () => {
  it("业务 API 免 Cookie;身份恒为 ANONYMOUS/COMPAT,绝不 ADMIN,且不写 DB", async () => {
    await withApp(async (ctx) => {
      const createRes = await fetch(`${ctx.baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "compat" }),
      });
      expect(createRes.status).toBe(201);

      const session = await fetch(`${ctx.baseUrl}/api/auth/session`);
      expect(session.status).toBe(200);
      const sessionBody = (await session.json()) as {
        data: { authenticated: boolean; expiresAt: null; userType: string };
      };
      expect(sessionBody.data).toMatchObject({
        authenticated: true,
        expiresAt: null,
        userType: "ANONYMOUS",
      });

      const anon = await bootstrapAnonymous(ctx.baseUrl);
      expect(anon.status).toBe(200);
      expect(anon.headers.getSetCookie()).toHaveLength(0);

      const loginRes = await login(ctx.baseUrl, PASSWORD);
      expect(loginRes.status).toBe(200);
      expect(loginRes.headers.getSetCookie()).toHaveLength(0);
      const loginBody = (await loginRes.json()) as { data: { userType: string } };
      expect(loginBody.data.userType).not.toBe("ADMIN");

      const logoutRes = await fetch(`${ctx.baseUrl}/api/auth/logout`, { method: "POST" });
      expect(logoutRes.status).toBe(204);

      // COMPAT 不创建任何 User/Session
      expect(await ctx.prisma.session.count()).toBe(0);
      expect(await nonSentinelUserCount(ctx)).toBe(0);
    }, null);
  });
});

describe("ENV-01..03 §17 AUTH_ENABLED=false fail-closed / §16 secret 退役", () => {
  const base = { DATABASE_URL: "file:./data/database/test.db" };

  it("ENV-01 非 loopback HOST + AUTH_ENABLED=false → 启动校验失败", () => {
    for (const host of ["0.0.0.0", "192.168.1.10", "example.com", "::"]) {
      expect(() => parseEnv({ ...base, HOST: host, AUTH_ENABLED: "false" }), host).toThrow(
        /HOST/,
      );
    }
  });

  it("ENV-02 127.0.0.1 / ::1 / localhost 通过;AUTH_ENABLED=true 时任意 HOST 通过", () => {
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      expect(parseEnv({ ...base, HOST: host, AUTH_ENABLED: "false" }).HOST).toBe(host);
    }
    const enabled = parseEnv({
      ...base,
      HOST: "0.0.0.0",
      AUTH_ENABLED: "true",
      AUTH_PASSWORD: PASSWORD,
    });
    expect(enabled.AUTH_ENABLED).toBe(true);
  });

  it("ENV-03 遗留 AUTH_SESSION_SECRET 不影响启动;新 TTL 默认值生效", () => {
    const env = parseEnv({
      ...base,
      AUTH_SESSION_SECRET: "legacy-secret-value-32-chars-abcdef",
    });
    expect(env.AUTH_SESSION_TTL_ANONYMOUS_SECONDS).toBe(2_592_000);
    expect(env.AUTH_SESSION_TTL_SECONDS).toBe(604_800);
    expect(env.AUTH_SESSION_TOUCH_INTERVAL_SECONDS).toBe(3_600);
  });
});
