import { describe, expect, it, vi } from "vitest";

import { ADMIN_USER_ID, AUTH_COOKIE_NAME, COMPAT_USER_ID } from "../../src/config/constants.js";
import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { PublicErrorCodes } from "../../src/common/errors/public-error.js";
import { FixedWindowRateLimiter } from "../../src/common/rate-limit/rate-limiter.js";
import { AuthSessionRepository } from "../../src/modules/auth/auth.session.repository.js";
import { AuthUserRepository } from "../../src/modules/auth/auth.user.repository.js";
import { ConversationRepository } from "../../src/modules/conversation/conversation.repository.js";
import { hashSessionToken } from "../../src/modules/auth/auth.session-token.js";
import { Argon2CapacityGate } from "../../src/modules/auth/auth.argon2-capacity.js";
import * as authPassword from "../../src/modules/auth/auth.password.js";
import { createPasswordCrypto } from "../../src/modules/auth/auth.password.js";
import { verifyPassword } from "../../src/modules/auth/auth.password.js";
import type { AbuseProtectionConfig } from "../../src/app.js";
import type { AuthDeps } from "../../src/modules/auth/auth.types.js";
import type { FixedWindowRateLimiter as FixedWindowRateLimiterType } from "../../src/common/rate-limit/rate-limiter.js";
import { ADMIN_AUTH, setupTestContext, type TestContext } from "../helpers.js";

/**
 * V1.4 U2 §85/§86:改密与「退出所有设备」。
 *
 * 两条主判据:
 * - 改密 = 当前设备换发新 token + 该 User 的**其它** Session 全部撤销,业务数据一行不动;
 * - revoke-all 只作用于调用者自己(USER 维度), ADMIN 那条专用端点与鉴权链完全没被碰。
 */

const PASSWORD = "Password123!";
const NEW_PASSWORD = "Rotated123!";
const D1B_PASSWORD_SENTINEL = "PERSONCHAT_D1B_PASSWORD_SENTINEL_xxxxx";
/** 第二个注册账号(bob)的口令,与 alice 全程不同 */
const OTHER = "AnotherPass123!";
const TTL_ANON = 7200;
const TTL_ADMIN = 3600;
const TTL_REGISTERED = 86_400;
const TOUCH_INTERVAL = 60;

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
    passwordChangeRateLimiter?: FixedWindowRateLimiterType;
    argon2MaxConcurrency?: number;
  },
): Promise<T> {
  const argon2CapacityGate = new Argon2CapacityGate(options?.argon2MaxConcurrency ?? 2);
  const passwordCrypto = createPasswordCrypto(argon2CapacityGate, {
    hash: (password) => authPassword.hashPassword(password),
    verify: (hashed, password) => authPassword.verifyPassword(hashed, password),
  });
  const ctx = await setupTestContext({
    auth: options && "auth" in options ? options.auth! : authDeps(),
    abuse: options?.abuse,
    passwordChangeRateLimiter: options?.passwordChangeRateLimiter,
    argon2CapacityGate,
    passwordCrypto,
  });
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

function setCookieCount(res: Response): number {
  return res.headers.getSetCookie().length;
}

function tokenOf(cookie: string): string {
  return cookie.slice(AUTH_COOKIE_NAME.length + 1);
}

function errorCodeOf(body: unknown): string {
  return ((body as { error: { code: string } }).error ?? { code: "" }).code;
}

function dataOf<T = Record<string, unknown>>(body: unknown): T {
  return (body as { data: T }).data;
}

async function post(
  ctx: TestContext,
  path: string,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    },
    body: JSON.stringify(body),
  });
}

async function anonymous(ctx: TestContext): Promise<{ cookie: string; userId: string }> {
  const res = await fetch(`${ctx.baseUrl}/api/auth/anonymous`, { method: "POST" });
  const cookie = cookieOf(res);
  const row = await ctx.prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(tokenOf(cookie)) },
  });
  return { cookie, userId: row!.userId };
}

async function registered(
  ctx: TestContext,
  username = "alice",
  password = PASSWORD,
): Promise<{ cookie: string; userId: string }> {
  const anon = await anonymous(ctx);
  const res = await post(ctx, "/api/auth/register", { username, password }, anon.cookie);
  if (res.status !== 200) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  return { cookie: cookieOf(res), userId: anon.userId };
}

/** 再开一台设备:无 Cookie 登录 ⇒ 新增一条 Session,不撤旧的 */
async function extraDevice(ctx: TestContext, username: string, password: string): Promise<string> {
  const res = await post(ctx, "/api/auth/user/login", { username, password });
  expect(res.status).toBe(200);
  return cookieOf(res);
}

async function sessionsOf(ctx: TestContext, userId: string): Promise<number> {
  return ctx.prisma.session.count({ where: { userId } });
}

async function hashOf(ctx: TestContext, userId: string): Promise<string | null> {
  return (await ctx.prisma.user.findUnique({ where: { id: userId } }))!.passwordHash;
}

async function conversationSnapshot(ctx: TestContext, userId: string) {
  return ctx.prisma.conversation.findMany({
    where: { userId },
    orderBy: { id: "asc" },
    select: { id: true, userId: true, title: true, status: true, updatedAt: true },
  });
}

describe("PWD 改密(V1.4 U2 §85)", () => {
  it("PWD-01/05 成功:旧 token 失效、新 token 生效,新摘要真能登录", async () => {
    await withApp(async (ctx) => {
      const alice = await registered(ctx);
      const oldHash = await hashOf(ctx, alice.userId);
      const res = await post(
        ctx,
        "/api/auth/password/change",
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        alice.cookie,
      );
      expect(res.status).toBe(200);
      const body = dataOf<Record<string, unknown>>(await res.json());
      expect(Object.keys(body).sort()).toEqual([
        "authenticated",
        "expiresAt",
        "userType",
        "username",
      ]);
      expect(body.userType).toBe("REGISTERED");
      expect(body.username).toBe("alice");

      const rotated = cookieOf(res);
      expect(rotated).not.toBe(alice.cookie);
      expect(await sessionsOf(ctx, alice.userId)).toBe(1);
      const nextHash = await hashOf(ctx, alice.userId);
      expect(nextHash).not.toBe(oldHash);
      expect(nextHash).not.toContain(NEW_PASSWORD);
      await expect(verifyPassword(nextHash!, NEW_PASSWORD)).resolves.toBe(true);
      await expect(verifyPassword(nextHash!, PASSWORD)).resolves.toBe(false);
      // 旧 token 走业务 API 与 probe 都不再有效
      const business = await fetch(`${ctx.baseUrl}/api/conversations`, {
        headers: { Cookie: alice.cookie },
      });
      expect(business.status).toBe(401);
    });
  });

  it("PWD-02 当前口令错:401 同码,摘要与 Session 一字不动、零 Cookie", async () => {
    await withApp(async (ctx) => {
      const alice = await registered(ctx);
      const phone = await extraDevice(ctx, "alice", PASSWORD);
      const before = await hashOf(ctx, alice.userId);
      const res = await post(
        ctx,
        "/api/auth/password/change",
        { currentPassword: "WrongPass1!", newPassword: NEW_PASSWORD },
        alice.cookie,
      );
      expect(res.status).toBe(401);
      expect(errorCodeOf(await res.json())).toBe(ErrorCodes.AUTH_INVALID_CREDENTIALS);
      expect(setCookieCount(res)).toBe(0);
      expect(await hashOf(ctx, alice.userId)).toBe(before);
      expect(await sessionsOf(ctx, alice.userId)).toBe(2);
      // 别人的会话没有被顺手撤销
      expect(
        dataOf<{ authenticated: boolean }>(
          await (
            await fetch(`${ctx.baseUrl}/api/auth/session`, { headers: { Cookie: phone } })
          ).json(),
        ).authenticated,
      ).toBe(true);
    });
  });

  it("PWD-03 newPassword 与当前口令相同 → 400,不写库也不换 Session", async () => {
    await withApp(async (ctx) => {
      const alice = await registered(ctx);
      const before = await hashOf(ctx, alice.userId);
      const res = await post(
        ctx,
        "/api/auth/password/change",
        { currentPassword: PASSWORD, newPassword: PASSWORD },
        alice.cookie,
      );
      expect(res.status).toBe(400);
      expect(errorCodeOf(await res.json())).toBe(ErrorCodes.VALIDATION_ERROR);
      expect(await hashOf(ctx, alice.userId)).toBe(before);
      expect(await sessionsOf(ctx, alice.userId)).toBe(1);
      expect(setCookieCount(res)).toBe(0);
    });
  });

  it("PWD-04 新口令不合政策 → 400(长度是唯一政策)", async () => {
    await withApp(async (ctx) => {
      const alice = await registered(ctx);
      for (const bad of ["short", "a".repeat(129), ""]) {
        const res = await post(
          ctx,
          "/api/auth/password/change",
          { currentPassword: PASSWORD, newPassword: bad },
          alice.cookie,
        );
        expect(res.status, bad.length === 0 ? "empty" : bad.slice(0, 6)).toBe(400);
        expect(errorCodeOf(await res.json())).toBe(ErrorCodes.VALIDATION_ERROR);
      }
      expect(await sessionsOf(ctx, alice.userId)).toBe(1);
    });
  });

  it("PWD-06 其它设备全部撤销,当前设备保持登录", async () => {
    await withApp(async (ctx) => {
      const alice = await registered(ctx);
      const phone = await extraDevice(ctx, "alice", PASSWORD);
      const tablet = await extraDevice(ctx, "alice", PASSWORD);
      expect(await sessionsOf(ctx, alice.userId)).toBe(3);

      const cookie = cookieOf(
        await post(
          ctx,
          "/api/auth/password/change",
          { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
          alice.cookie,
        ),
      );
      expect(await sessionsOf(ctx, alice.userId)).toBe(1);
      for (const stale of [phone, tablet]) {
        expect(await ctx.prisma.session.findUnique({
          where: { tokenHash: hashSessionToken(tokenOf(stale)) },
        })).toBeNull();
      }
      expect(
        dataOf<{ authenticated: boolean }>(
          await (await fetch(`${ctx.baseUrl}/api/auth/session`, { headers: { Cookie: cookie } })).json(),
        ).authenticated,
      ).toBe(true);
    });
  });

  it("PWD-07 业务数据不受改密牵连(Conversation 逐行不变 + 零写方法被调用)", async () => {
    const update = vi.spyOn(ConversationRepository.prototype, "update");
    const updateOwned = vi.spyOn(ConversationRepository.prototype, "updateOwned");
    try {
      await withApp(async (ctx) => {
        const anon = await anonymous(ctx);
        const conv = await post(
          ctx,
          "/api/conversations",
          { title: "甲" },
          anon.cookie,
        );
        expect(conv.status).toBe(201);
        const reg = cookieOf(
          await post(ctx, "/api/auth/register", { username: "alice", password: PASSWORD }, anon.cookie),
        );
        const before = await conversationSnapshot(ctx, anon.userId);
        expect(before).toHaveLength(1);

        expect(
          (
            await post(
              ctx,
              "/api/auth/password/change",
              { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
              reg,
            )
          ).status,
        ).toBe(200);
        expect(await conversationSnapshot(ctx, anon.userId)).toEqual(before);
        expect(update).not.toHaveBeenCalled();
        expect(updateOwned).not.toHaveBeenCalled();
      });
    } finally {
      update.mockRestore();
      updateOwned.mockRestore();
    }
  });

  it("PWD-08/09 ADMIN 与 ANONYMOUS 都不能改密 → 403,零写入", async () => {
    await withApp(async (ctx) => {
      const admin = cookieOf(await post(ctx, "/api/auth/login", { password: ADMIN_AUTH.password }));
      const asAdmin = await post(
        ctx,
        "/api/auth/password/change",
        { currentPassword: ADMIN_AUTH.password, newPassword: NEW_PASSWORD },
        admin,
      );
      expect(asAdmin.status).toBe(403);
      expect(errorCodeOf(await asAdmin.json())).toBe(ErrorCodes.AUTH_FORBIDDEN);
      expect((await ctx.prisma.user.findUnique({ where: { id: ADMIN_USER_ID } }))!.passwordHash)
        .toBeNull();

      const anon = await anonymous(ctx);
      const asAnon = await post(
        ctx,
        "/api/auth/password/change",
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        anon.cookie,
      );
      expect(asAnon.status).toBe(403);
      expect(errorCodeOf(await asAnon.json())).toBe(ErrorCodes.AUTH_FORBIDDEN);
      expect((await ctx.prisma.user.findUnique({ where: { id: anon.userId } }))!.passwordHash)
        .toBeNull();
    });
  });

  it("PWD-10 身份被禁用 → 401 AUTH_USER_DISABLED,零 Cookie 零写入", async () => {
    await withApp(async (ctx) => {
      const alice = await registered(ctx);
      await ctx.prisma.user.update({ where: { id: alice.userId }, data: { status: "DISABLED" } });
      const before = await hashOf(ctx, alice.userId);
      const res = await post(
        ctx,
        "/api/auth/password/change",
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        alice.cookie,
      );
      expect(res.status).toBe(401);
      expect(errorCodeOf(await res.json())).toBe(ErrorCodes.AUTH_USER_DISABLED);
      expect(setCookieCount(res)).toBe(0);
      expect(await hashOf(ctx, alice.userId)).toBe(before);
    });
  });

  it("PWD-11 COMPAT → 403 且零写库零 Cookie", async () => {
    await withApp(
      async (ctx) => {
        const res = await post(ctx, "/api/auth/password/change", {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
        });
        expect(res.status).toBe(403);
        expect(errorCodeOf(await res.json())).toBe(ErrorCodes.AUTH_FORBIDDEN);
        expect(setCookieCount(res)).toBe(0);
        expect(await ctx.prisma.session.count()).toBe(0);
      },
      { auth: null },
    );
  });

  it("PWD-12 事务首写命中 0(呈现的 Session 已被并发改写)→ 401,新摘要一行都不落", async () => {
    await withApp(async (ctx) => {
      const alice = await registered(ctx);
      const session = (await ctx.prisma.session.findMany({ where: { userId: alice.userId } }))[0]!;
      const before = await hashOf(ctx, alice.userId);
      // 并发者抢先撤了这条 Session(controller 预检时它还有效)
      await ctx.prisma.session.delete({ where: { id: session.id } });
      await expect(
        ctx.authSessions!.changeRegisteredPassword({
          userId: alice.userId,
          sessionId: session.id,
          passwordHash: "new-hash",
        }),
      ).rejects.toMatchObject({ code: ErrorCodes.AUTH_REQUIRED });
      // 整事务回滚:摘要没被改写,也没有任何新 Session 被建出来
      expect(await hashOf(ctx, alice.userId)).toBe(before);
      expect(await sessionsOf(ctx, alice.userId)).toBe(0);
    });
  });
});

describe("PWD 改密 Argon2 abuse protection(D1B)", () => {
  function limiter(options: { max?: number; maxKeys?: number; clock?: { now(): number } } = {}) {
    return new FixedWindowRateLimiter({
      windowMs: 60_000,
      max: options.max ?? 5,
      maxKeys: options.maxKeys,
      clock: options.clock,
    });
  }

  function fakeClock() {
    let now = 0;
    return {
      now: () => now,
      advance(ms: number): void {
        now += ms;
      },
    };
  }

  it("PWD-RL-01/03 同一 User 第 1-5 次 attempt 放行,第 6 次 429;错误口令消耗额度", async () => {
    const passwordLimiter = limiter();
    await withApp(
      async (ctx) => {
        const alice = await registered(ctx);
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          expect(
            (
              await post(
                ctx,
                "/api/auth/password/change",
                { currentPassword: `WrongPass${attempt}!`, newPassword: NEW_PASSWORD },
                alice.cookie,
              )
            ).status,
          ).toBe(401);
        }
        const blocked = await post(
          ctx,
          "/api/auth/password/change",
          { currentPassword: "WrongPass6!", newPassword: NEW_PASSWORD },
          alice.cookie,
        );
        expect(blocked.status).toBe(429);
        expect(errorCodeOf(await blocked.json())).toBe(ErrorCodes.AUTH_RATE_LIMITED);
        expect(blocked.headers.get("Retry-After")).not.toBeNull();
      },
      { passwordChangeRateLimiter: passwordLimiter },
    );
  });

  it("PWD-RL-02 429 严格排在 verify/hash 前", async () => {
    const passwordLimiter = limiter({ max: 1 });
    await withApp(
      async (ctx) => {
        const alice = await registered(ctx);
        const verifySpy = vi.spyOn(authPassword, "verifyPassword");
        const hashSpy = vi.spyOn(authPassword, "hashPassword");
        try {
          verifySpy.mockClear();
          hashSpy.mockClear();
          expect(
            (
              await post(
                ctx,
                "/api/auth/password/change",
                { currentPassword: "WrongPass1!", newPassword: NEW_PASSWORD },
                alice.cookie,
              )
            ).status,
          ).toBe(401);
          verifySpy.mockClear();
          hashSpy.mockClear();

          const blocked = await post(
            ctx,
            "/api/auth/password/change",
            { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
            alice.cookie,
          );
          expect(blocked.status).toBe(429);
          expect(verifySpy).toHaveBeenCalledTimes(0);
          expect(hashSpy).toHaveBeenCalledTimes(0);
        } finally {
          verifySpy.mockRestore();
          hashSpy.mockRestore();
        }
      },
      { passwordChangeRateLimiter: passwordLimiter },
    );
  });

  it("PWD-RL-02b password sentinel 不进入 HTTP error surface", async () => {
    const passwordLimiter = limiter();
    await withApp(
      async (ctx) => {
        const alice = await registered(ctx);
        const response = await post(
          ctx,
          "/api/auth/password/change",
          { currentPassword: D1B_PASSWORD_SENTINEL, newPassword: NEW_PASSWORD },
          alice.cookie,
        );
        const body = await response.text();
        expect(response.status).toBe(401);
        expect(body).not.toContain(D1B_PASSWORD_SENTINEL);
        expect(body).not.toContain("$argon2id$");
        expect(body).not.toContain("passwordHash");
      },
      { passwordChangeRateLimiter: passwordLimiter },
    );
  });

  it("PWD-RL-04 正确改密也消费 attempt,成功不 reset", async () => {
    const passwordLimiter = limiter();
    await withApp(
      async (ctx) => {
        const alice = await registered(ctx);
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          expect(
            (
              await post(
                ctx,
                "/api/auth/password/change",
                { currentPassword: `WrongPass${attempt}!`, newPassword: NEW_PASSWORD },
                alice.cookie,
              )
            ).status,
          ).toBe(401);
        }
        const rotated = await post(
          ctx,
          "/api/auth/password/change",
          { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
          alice.cookie,
        );
        expect(rotated.status).toBe(200);

        const blocked = await post(
          ctx,
          "/api/auth/password/change",
          { currentPassword: NEW_PASSWORD, newPassword: "Rotated456!" },
          cookieOf(rotated),
        );
        expect(blocked.status).toBe(429);
        expect(errorCodeOf(await blocked.json())).toBe(ErrorCodes.AUTH_RATE_LIMITED);
      },
      { passwordChangeRateLimiter: passwordLimiter },
    );
  });

  it("PWD-RL-05 同一 User 的多个 Session 共享 User.id bucket", async () => {
    const passwordLimiter = limiter();
    await withApp(
      async (ctx) => {
        const alice = await registered(ctx);
        const secondDevice = await extraDevice(ctx, "alice", PASSWORD);
        for (const [index, cookie] of [alice.cookie, secondDevice, alice.cookie, secondDevice, alice.cookie].entries()) {
          expect(
            (
              await post(
                ctx,
                "/api/auth/password/change",
                { currentPassword: `WrongPass${index + 1}!`, newPassword: NEW_PASSWORD },
                cookie,
              )
            ).status,
          ).toBe(401);
        }
        expect(
          (
            await post(
              ctx,
              "/api/auth/password/change",
              { currentPassword: "WrongPass6!", newPassword: NEW_PASSWORD },
              secondDevice,
            )
          ).status,
        ).toBe(429);
      },
      { passwordChangeRateLimiter: passwordLimiter },
    );
  });

  it("PWD-RL-06 Alice/Bob 使用相互独立的 User.id bucket", async () => {
    const passwordLimiter = limiter();
    await withApp(
      async (ctx) => {
        const alice = await registered(ctx, "alice", PASSWORD);
        const bob = await registered(ctx, "bob", OTHER);
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          expect(
            (
              await post(
                ctx,
                "/api/auth/password/change",
                { currentPassword: `WrongPass${attempt}!`, newPassword: NEW_PASSWORD },
                alice.cookie,
              )
            ).status,
          ).toBe(401);
        }
        expect(
          (
            await post(
              ctx,
              "/api/auth/password/change",
              { currentPassword: "WrongPass6!", newPassword: NEW_PASSWORD },
              alice.cookie,
            )
          ).status,
        ).toBe(429);
        expect(
          (
            await post(
              ctx,
              "/api/auth/password/change",
              { currentPassword: "WrongBob1!", newPassword: NEW_PASSWORD },
              bob.cookie,
            )
          ).status,
        ).toBe(401);
      },
      { passwordChangeRateLimiter: passwordLimiter },
    );
  });

  it("PWD-RL-07 invalid/expired/disabled/ANONYMOUS/ADMIN/COMPAT 不创建 Registered bucket", async () => {
    const passwordLimiter = limiter();
    await withApp(
      async (ctx) => {
        const anon = await anonymous(ctx);
        expect(
          (
            await post(
              ctx,
              "/api/auth/password/change",
              { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
              anon.cookie,
            )
          ).status,
        ).toBe(403);
        expect(passwordLimiter.keyCount()).toBe(0);

        const admin = cookieOf(await post(ctx, "/api/auth/login", { password: ADMIN_AUTH.password }));
        expect(
          (
            await post(
              ctx,
              "/api/auth/password/change",
              { currentPassword: ADMIN_AUTH.password, newPassword: NEW_PASSWORD },
              admin,
            )
          ).status,
        ).toBe(403);
        expect(passwordLimiter.keyCount()).toBe(0);

        expect(
          (
            await post(
              ctx,
              "/api/auth/password/change",
              { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
              `${AUTH_COOKIE_NAME}=invalid-token`,
            )
          ).status,
        ).toBe(401);
        expect(passwordLimiter.keyCount()).toBe(0);

        const expired = await registered(ctx, "expired", PASSWORD);
        await ctx.prisma.session.updateMany({
          where: { userId: expired.userId },
          data: { expiresAt: new Date(0) },
        });
        expect(
          (
            await post(
              ctx,
              "/api/auth/password/change",
              { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
              expired.cookie,
            )
          ).status,
        ).toBe(401);
        expect(passwordLimiter.keyCount()).toBe(0);

        const disabled = await registered(ctx, "disabled", PASSWORD);
        await ctx.prisma.user.update({ where: { id: disabled.userId }, data: { status: "DISABLED" } });
        expect(
          (
            await post(
              ctx,
              "/api/auth/password/change",
              { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
              disabled.cookie,
            )
          ).status,
        ).toBe(401);
        expect(passwordLimiter.keyCount()).toBe(0);
      },
      { passwordChangeRateLimiter: passwordLimiter },
    );

    await withApp(
      async (ctx) => {
        const res = await post(ctx, "/api/auth/password/change", {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
        });
        expect(res.status).toBe(403);
        expect(passwordLimiter.keyCount()).toBe(0);
      },
      { auth: null, passwordChangeRateLimiter: passwordLimiter },
    );
  });

  it("PWD-RL-08 maxKeys 满时新 User 为 503,且不进入 Argon2;既有 bucket 不被淘汰", async () => {
    const passwordLimiter = limiter({ maxKeys: 1 });
    await withApp(
      async (ctx) => {
        const alice = await registered(ctx, "alice", PASSWORD);
        const bob = await registered(ctx, "bob", OTHER);
        expect(
          (
            await post(
              ctx,
              "/api/auth/password/change",
              { currentPassword: "WrongAlice1!", newPassword: NEW_PASSWORD },
              alice.cookie,
            )
          ).status,
        ).toBe(401);

        const verifySpy = vi.spyOn(authPassword, "verifyPassword");
        const hashSpy = vi.spyOn(authPassword, "hashPassword");
        try {
          verifySpy.mockClear();
          hashSpy.mockClear();
          const blocked = await post(
            ctx,
            "/api/auth/password/change",
            { currentPassword: OTHER, newPassword: NEW_PASSWORD },
            bob.cookie,
          );
          expect(blocked.status).toBe(503);
          expect(errorCodeOf(await blocked.json())).toBe(PublicErrorCodes.SERVICE_BUSY);
          expect(verifySpy).toHaveBeenCalledTimes(0);
          expect(hashSpy).toHaveBeenCalledTimes(0);
          expect(
            (
              await post(
                ctx,
                "/api/auth/password/change",
                { currentPassword: "WrongAlice2!", newPassword: NEW_PASSWORD },
                alice.cookie,
              )
            ).status,
          ).toBe(401);
        } finally {
          verifySpy.mockRestore();
          hashSpy.mockRestore();
        }
      },
      { passwordChangeRateLimiter: passwordLimiter },
    );
  });

  it("PWD-RL-09 并发 burst 的 Argon2 verify 数量不超过窗口额度", async () => {
    const passwordLimiter = limiter();
    await withApp(
      async (ctx) => {
        const alice = await registered(ctx);
        const verifySpy = vi.spyOn(authPassword, "verifyPassword");
        const hashSpy = vi.spyOn(authPassword, "hashPassword");
        try {
          verifySpy.mockClear();
          hashSpy.mockClear();
          const responses = await Promise.all(
            Array.from({ length: 12 }, (_, index) =>
              post(
                ctx,
                "/api/auth/password/change",
                { currentPassword: `BurstWrong${index}!`, newPassword: NEW_PASSWORD },
                alice.cookie,
              ),
            ),
          );
          expect(responses.filter((res) => res.status === 401)).toHaveLength(5);
          expect(responses.filter((res) => res.status === 429)).toHaveLength(7);
          expect(verifySpy).toHaveBeenCalledTimes(5);
          expect(hashSpy).toHaveBeenCalledTimes(0);
        } finally {
          verifySpy.mockRestore();
          hashSpy.mockRestore();
        }
      },
      { passwordChangeRateLimiter: passwordLimiter, argon2MaxConcurrency: 16 },
    );
  });

  it("PWD-RL-12 正确旧口令并发 burst 的 verify/hash 均受 User budget 约束", async () => {
    const budget = 3;
    const burst = 10;
    const passwordLimiter = limiter({ max: budget });
    await withApp(
      async (ctx) => {
        const alice = await registered(ctx);
        const verifySpy = vi.spyOn(authPassword, "verifyPassword");
        const hashSpy = vi.spyOn(authPassword, "hashPassword");
        try {
          verifySpy.mockClear();
          hashSpy.mockClear();
          const responses = await Promise.all(
            Array.from({ length: burst }, (_, index) =>
              post(
                ctx,
                "/api/auth/password/change",
                { currentPassword: PASSWORD, newPassword: `CorrectBurst${index}!` },
                alice.cookie,
              ),
            ),
          );
          // 不断言成功数量:多个请求共享一个 presented Session,事务轮换可能产生既有 race 出口。
          expect(responses.filter((res) => res.status === 429).length).toBeGreaterThanOrEqual(
            burst - budget,
          );
          expect(verifySpy.mock.calls.length).toBeLessThanOrEqual(budget);
          expect(hashSpy.mock.calls.length).toBeLessThanOrEqual(budget);
        } finally {
          verifySpy.mockRestore();
          hashSpy.mockRestore();
        }
      },
      { passwordChangeRateLimiter: passwordLimiter },
    );
  });

  it("PWD-RL-10 fake clock 越过窗口后允许新一轮 attempt", async () => {
    const clock = fakeClock();
    const passwordLimiter = limiter({ clock });
    await withApp(
      async (ctx) => {
        const alice = await registered(ctx);
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          expect(
            (
              await post(
                ctx,
                "/api/auth/password/change",
                { currentPassword: `WrongPass${attempt}!`, newPassword: NEW_PASSWORD },
                alice.cookie,
              )
            ).status,
          ).toBe(401);
        }
        expect(
          (
            await post(
              ctx,
              "/api/auth/password/change",
              { currentPassword: "WrongPass6!", newPassword: NEW_PASSWORD },
              alice.cookie,
            )
          ).status,
        ).toBe(429);
        clock.advance(60_001);
        expect(
          (
            await post(
              ctx,
              "/api/auth/password/change",
              { currentPassword: "WrongPass7!", newPassword: NEW_PASSWORD },
              alice.cookie,
            )
          ).status,
        ).toBe(401);
        expect(passwordLimiter.keyCount()).toBe(1);
      },
      { passwordChangeRateLimiter: passwordLimiter },
    );
  });
});

describe("REV 退出所有设备(V1.4 U2 §86)", () => {
  it("REV-01/02/03 撤销自己的全部 Session 并回报条数", async () => {
    await withApp(async (ctx) => {
      const alice = await registered(ctx);
      await extraDevice(ctx, "alice", PASSWORD);
      await extraDevice(ctx, "alice", PASSWORD);
      expect(await sessionsOf(ctx, alice.userId)).toBe(3);

      const res = await post(ctx, "/api/auth/sessions/revoke-all", {}, alice.cookie);
      expect(res.status).toBe(200);
      expect(dataOf<{ revoked: number }>(await res.json())).toEqual({ revoked: 3 });
      expect(await sessionsOf(ctx, alice.userId)).toBe(0);
    });
  });

  it("REV-04 只作用于调用者:另一注册账号与 ADMIN 的 Session 不受影响", async () => {
    await withApp(async (ctx) => {
      const alice = await registered(ctx, "alice");
      const bob = await registered(ctx, "bob", OTHER);
      const bobSecond = await extraDevice(ctx, "bob", OTHER);
      const admin = cookieOf(await post(ctx, "/api/auth/login", { password: ADMIN_AUTH.password }));
      expect(await sessionsOf(ctx, bob.userId)).toBe(2);
      expect(await sessionsOf(ctx, ADMIN_USER_ID)).toBe(1);

      expect((await post(ctx, "/api/auth/sessions/revoke-all", {}, alice.cookie)).status).toBe(200);
      expect(await sessionsOf(ctx, alice.userId)).toBe(0);
      expect(await sessionsOf(ctx, bob.userId)).toBe(2);
      expect(await sessionsOf(ctx, ADMIN_USER_ID)).toBe(1);
      expect(
        dataOf<{ authenticated: boolean }>(
          await (await fetch(`${ctx.baseUrl}/api/auth/session`, { headers: { Cookie: bobSecond } })).json(),
        ).authenticated,
      ).toBe(true);
    });
  });

  it("REV-05 删库成功后才清 Cookie;后续请求即 401", async () => {
    await withApp(async (ctx) => {
      const alice = await registered(ctx);
      const res = await post(ctx, "/api/auth/sessions/revoke-all", {}, alice.cookie);
      expect(res.status).toBe(200);
      const cleared = res.headers.getSetCookie().find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`))!;
      expect(cleared).toMatch(/Max-Age=0/i);
      const probe = await fetch(`${ctx.baseUrl}/api/auth/session`, { headers: { Cookie: alice.cookie } });
      expect(dataOf<{ authenticated: boolean }>(await probe.json()).authenticated).toBe(false);
    });
  });

  it("REV-06/07 ANONYMOUS 与 ADMIN 走普通端点都 403,不撤销任何人", async () => {
    await withApp(async (ctx) => {
      const anon = await anonymous(ctx);
      const asAnon = await post(ctx, "/api/auth/sessions/revoke-all", {}, anon.cookie);
      expect(asAnon.status).toBe(403);
      expect(errorCodeOf(await asAnon.json())).toBe(ErrorCodes.AUTH_FORBIDDEN);
      expect(await sessionsOf(ctx, anon.userId)).toBe(1);

      const admin = cookieOf(await post(ctx, "/api/auth/login", { password: ADMIN_AUTH.password }));
      const asAdmin = await post(ctx, "/api/auth/sessions/revoke-all", {}, admin);
      expect(asAdmin.status).toBe(403);
      expect(errorCodeOf(await asAdmin.json())).toBe(ErrorCodes.AUTH_FORBIDDEN);
      expect(await sessionsOf(ctx, ADMIN_USER_ID)).toBe(1);
    });
  });

  it("REV-08 DISABLED → 401 AUTH_USER_DISABLED,Session 原样留在库里", async () => {
    await withApp(async (ctx) => {
      const alice = await registered(ctx);
      await ctx.prisma.user.update({ where: { id: alice.userId }, data: { status: "DISABLED" } });
      const res = await post(ctx, "/api/auth/sessions/revoke-all", {}, alice.cookie);
      expect(res.status).toBe(401);
      expect(errorCodeOf(await res.json())).toBe(ErrorCodes.AUTH_USER_DISABLED);
      expect(setCookieCount(res)).toBe(0);
      expect(await sessionsOf(ctx, alice.userId)).toBe(1);
    });
  });

  it("REV-09 COMPAT → 403 零 Session 零 Cookie", async () => {
    await withApp(
      async (ctx) => {
        const res = await post(ctx, "/api/auth/sessions/revoke-all", {});
        expect(res.status).toBe(403);
        expect(errorCodeOf(await res.json())).toBe(ErrorCodes.AUTH_FORBIDDEN);
        expect(setCookieCount(res)).toBe(0);
        expect(await ctx.prisma.session.count()).toBe(0);
      },
      { auth: null },
    );
  });

  it("REV-10 ADMIN 专用 revoke-all 契约不变(只撤 ADMIN 自己,匿名不受影响)", async () => {
    await withApp(async (ctx) => {
      const anon = await anonymous(ctx);
      const admin = cookieOf(await post(ctx, "/api/auth/login", { password: ADMIN_AUTH.password }));
      expect(await sessionsOf(ctx, ADMIN_USER_ID)).toBe(1);

      const res = await post(ctx, "/api/admin/sessions/revoke-all", {}, admin);
      expect(res.status).toBe(200);
      expect(dataOf<{ revoked: number }>(await res.json())).toEqual({ revoked: 1 });
      expect(await sessionsOf(ctx, ADMIN_USER_ID)).toBe(0);
      // 匿名与 COMPAT 完全没被牵连(V1.3-B3-3 §29 的既有语义)
      expect(await sessionsOf(ctx, anon.userId)).toBe(1);
      expect(await sessionsOf(ctx, COMPAT_USER_ID)).toBe(0);
    });
  });
});
