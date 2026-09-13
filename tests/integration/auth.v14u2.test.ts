import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { AUTH_COOKIE_NAME } from "../../src/config/constants.js";
import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { PublicErrorCodes } from "../../src/common/errors/public-error.js";
import { AuthSessionRepository } from "../../src/modules/auth/auth.session.repository.js";
import { AuthUserRepository } from "../../src/modules/auth/auth.user.repository.js";
import { ConversationRepository } from "../../src/modules/conversation/conversation.repository.js";
import type { AbuseProtectionConfig } from "../../src/app.js";
import type { AuthDeps } from "../../src/modules/auth/auth.types.js";
import { ADMIN_USER_ID, COMPAT_USER_ID } from "../../src/config/constants.js";
import { LoginRateLimiter } from "../../src/modules/auth/auth.rate-limit.js";
import { hashSessionToken } from "../../src/modules/auth/auth.session-token.js";
import { ADMIN_AUTH, setupTestContext, type TestContext } from "../helpers.js";

/**
 * V1.4 U2:后端注册用户认证(REGISTER / USER LOGIN / PASSWORD CHANGE / REVOKE-ALL)。
 *
 * 三组判据是本文件的骨架:
 * 1. **注册 = 原地升级**:User.id 与全部业务行的 userId 逐字节不变,注册路径零业务表写入;
 * 2. **登录已有账号 = 身份切换**:匿名数据一行都不迁,也不被删;
 * 3. **任何身份转换都以「精准删除 presented Session 且命中 1」为事务第一步**(design §31)。
 *
 * 并发用例按本仓既有事实构造:driver adapter 下交互式事务不重叠,所以只能
 * 「让事务外的预检说谎」(mock 一次 resolve 让它看到仍然存在的 Session,
 * 再把真实行删掉),而不是用 Promise.all 假装并发。
 */

const PASSWORD = "Password123!";
const OTHER_PASSWORD = "Another123!";
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
    loginRateLimiter?: LoginRateLimiter;
  },
): Promise<T> {
  const ctx = await setupTestContext({
    // 刻意不用 ??:COMPAT 用例传的是 null(= AUTH_ENABLED=false),那也是一个值
    auth: options && "auth" in options ? options.auth! : authDeps(),
    abuse: options?.abuse,
    loginRateLimiter: options?.loginRateLimiter,
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
  if (raw === undefined) throw new Error(`no Set-Cookie: ${res.status} ${raw}`);
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

function errorMessageOf(body: unknown): string {
  return ((body as { error: { message: string } }).error ?? { message: "" }).message;
}

function dataOf<T = Record<string, unknown>>(body: unknown): T {
  return (body as { data: T }).data;
}

async function post(
  ctx: TestContext,
  path: string,
  body: unknown,
  cookie?: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie === undefined ? {} : { Cookie: cookie }),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const register = (ctx: TestContext, username: string, password: string, cookie?: string) =>
  post(ctx, "/api/auth/register", { username, password }, cookie);
const userLogin = (
  ctx: TestContext,
  username: string,
  password: string,
  cookie?: string,
  headers: Record<string, string> = {},
) => post(ctx, "/api/auth/user/login", { username, password }, cookie, headers);
const changePassword = (
  ctx: TestContext,
  currentPassword: string,
  newPassword: string,
  cookie: string,
) => post(ctx, "/api/auth/password/change", { currentPassword, newPassword }, cookie);
const revokeAll = (ctx: TestContext, cookie: string) =>
  post(ctx, "/api/auth/sessions/revoke-all", {}, cookie);

/** 新建匿名身份并返回 Cookie + 该匿名 User.id(注册前后必须逐字节相同) */
async function anonymous(ctx: TestContext): Promise<{ cookie: string; userId: string }> {
  const res = await fetch(`${ctx.baseUrl}/api/auth/anonymous`, { method: "POST" });
  expect(res.status).toBe(200);
  const cookie = cookieOf(res);
  return { cookie, userId: (await ownerOf(ctx, cookie))! };
}

async function ownerOf(ctx: TestContext, cookie: string): Promise<string | null> {
  const row = await ctx.prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(tokenOf(cookie)) },
  });
  return row?.userId ?? null;
}

async function userById(ctx: TestContext, userId: string) {
  return ctx.prisma.user.findUnique({ where: { id: userId } });
}

async function sessionCountOfUser(ctx: TestContext, userId: string): Promise<number> {
  return ctx.prisma.session.count({ where: { userId } });
}

async function sessionOfCookie(ctx: TestContext, cookie: string) {
  return ctx.prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(tokenOf(cookie)) },
  });
}

async function newConversation(ctx: TestContext, cookie: string, title: string): Promise<string> {
  const res = await fetch(`${ctx.baseUrl}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ title }),
  });
  expect(res.status).toBe(201);
  return dataOf<{ id: string }>(await res.json()).id;
}

async function listConversationIds(ctx: TestContext, cookie: string): Promise<string[]> {
  const res = await fetch(`${ctx.baseUrl}/api/conversations`, { headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  return dataOf<{ id: string }[]>(await res.json()).map((c) => c.id);
}

/** 注册出一个 REGISTERED 身份(绝大多数下游用例的起点) */
async function registered(
  ctx: TestContext,
  username = "alice",
  password = PASSWORD,
): Promise<{ cookie: string; userId: string }> {
  const anon = await anonymous(ctx);
  const res = await register(ctx, username, password, anon.cookie);
  if (res.status !== 200) {
    throw new Error(`register failed: ${res.status} ${await res.text()}`);
  }
  return { cookie: cookieOf(res), userId: anon.userId };
}

describe("REG 注册(V1.4 U2 §80)", () => {
  it("REG-01/16 成功:DTO 恰四键,库里落归一化用户名与 argon2id 摘要", async () => {
    await withApp(async (ctx) => {
      const anon = await anonymous(ctx);
      const res = await register(ctx, "Alice", PASSWORD, anon.cookie);
      expect(res.status).toBe(200);

      const body = dataOf<Record<string, unknown>>(await res.json());
      expect(Object.keys(body).sort()).toEqual([
        "authenticated",
        "expiresAt",
        "userType",
        "username",
      ]);
      expect(body.authenticated).toBe(true);
      expect(body.userType).toBe("REGISTERED");
      // 展示值原样回显,归一化列不外发
      expect(body.username).toBe("Alice");
      expect(typeof body.expiresAt).toBe("string");

      const user = await userById(ctx, anon.userId);
      expect(user!.type).toBe("REGISTERED");
      expect(user!.username).toBe("Alice");
      expect(user!.usernameNormalized).toBe("alice");
      expect(user!.passwordHash).not.toBeNull();
      expect(user!.passwordHash!.startsWith("$argon2id$")).toBe(true);
      expect(user!.passwordHash).not.toContain(PASSWORD);
    });
  });

  it("REG-02/03 原地升级:User.id 不变,会话列表与 owner 逐行不变(零数据搬迁)", async () => {
    await withApp(async (ctx) => {
      const anon = await anonymous(ctx);
      const ids = [
        await newConversation(ctx, anon.cookie, "甲"),
        await newConversation(ctx, anon.cookie, "乙"),
      ];
      const before = await ctx.prisma.conversation.findMany({
        where: { userId: anon.userId },
        orderBy: { id: "asc" },
        select: { id: true, userId: true, title: true, updatedAt: true },
      });

      const res = await register(ctx, "alice", PASSWORD, anon.cookie);
      const cookie = cookieOf(res);

      expect(await ownerOf(ctx, cookie)).toBe(anon.userId);
      expect((await listConversationIds(ctx, cookie)).sort()).toEqual([...ids].sort());
      const after = await ctx.prisma.conversation.findMany({
        where: { userId: anon.userId },
        orderBy: { id: "asc" },
        select: { id: true, userId: true, title: true, updatedAt: true },
      });
      expect(after).toEqual(before);
      // 全库不存在任何一条被迁走的会话(owner 集合仍是注册前那一人)
      expect(
        await ctx.prisma.conversation.count({ where: { userId: { not: anon.userId } } }),
      ).toBe(0);
    });
  });

  it("REG-14 注册路径从不调用任何 Conversation 写方法(结构性零搬迁)", async () => {
    const update = vi.spyOn(ConversationRepository.prototype, "update");
    const updateOwned = vi.spyOn(ConversationRepository.prototype, "updateOwned");
    const bind = vi.spyOn(ConversationRepository.prototype, "bindProviderConversationUrl");
    try {
      await withApp(async (ctx) => {
        const anon = await anonymous(ctx);
        await newConversation(ctx, anon.cookie, "甲");
        expect((await register(ctx, "alice", PASSWORD, anon.cookie)).status).toBe(200);
        expect(update).not.toHaveBeenCalled();
        expect(updateOwned).not.toHaveBeenCalled();
        expect(bind).not.toHaveBeenCalled();
      });
    } finally {
      update.mockRestore();
      updateOwned.mockRestore();
      bind.mockRestore();
    }
  });

  it("REG-04/17 旧匿名 Session 被撤销且旧 token 立即失效(抗 fixation)", async () => {
    await withApp(async (ctx) => {
      const anon = await anonymous(ctx);
      const oldToken = tokenOf(anon.cookie);
      const res = await register(ctx, "alice", PASSWORD, anon.cookie);
      const newCookie = cookieOf(res);

      expect(tokenOf(newCookie)).not.toBe(oldToken);
      expect(await sessionOfCookie(ctx, anon.cookie)).toBeNull();
      // 旧 token 走业务 API 与 probe 两条路都不再代表任何身份
      const business = await fetch(`${ctx.baseUrl}/api/conversations`, {
        headers: { Cookie: anon.cookie },
      });
      expect(business.status).toBe(401);
      expect(errorCodeOf(await business.json())).toBe(ErrorCodes.AUTH_REQUIRED);
      const probe = await fetch(`${ctx.baseUrl}/api/auth/session`, {
        headers: { Cookie: anon.cookie },
      });
      expect(dataOf<{ authenticated: boolean }>(await probe.json()).authenticated).toBe(false);
      // 新 token 有效且库里恰一条
      expect(
        (await sessionOfCookie(ctx, newCookie))!.tokenHash,
      ).toBe(createHash("sha256").update(tokenOf(newCookie), "utf8").digest("hex"));
      expect(await sessionCountOfUser(ctx, anon.userId)).toBe(1);
    });
  });

  it("REG-05 新 Session 用 REGISTERED 档 TTL,不落入匿名档", async () => {
    await withApp(async (ctx) => {
      const anon = await anonymous(ctx);
      const res = await register(ctx, "alice", PASSWORD, anon.cookie);
      const row = (await sessionOfCookie(ctx, cookieOf(res)))!;
      const ttlSeconds = (new Date(row.expiresAt).getTime() - Date.now()) / 1000;
      // 与三档默认值都能区分:容差取 60s,而 TTL_ANON 与 TTL_REGISTERED 相差 79200s
      expect(Math.abs(ttlSeconds - TTL_REGISTERED)).toBeLessThanOrEqual(60);
      expect(Math.abs(ttlSeconds - TTL_ANON)).toBeGreaterThan(3600);
    });
  });

  it("REG-06/07 同名与大小写同名都撞唯一约束;展示值与归一值分列存储", async () => {
    await withApp(async (ctx) => {
      const a = await anonymous(ctx);
      expect((await register(ctx, "Sky", PASSWORD, a.cookie)).status).toBe(200);

      const b = await anonymous(ctx);
      const dupCase = await register(ctx, "SKY", PASSWORD, b.cookie);
      expect(dupCase.status).toBe(409);
      expect(errorCodeOf(await dupCase.json())).toBe(ErrorCodes.AUTH_USERNAME_ALREADY_TAKEN);
      // 冲突请求不消耗身份:匿名 B 仍然是匿名,也没有留下半升级的 User
      expect((await userById(ctx, b.userId))!.type).toBe("ANONYMOUS");
      expect((await userById(ctx, b.userId))!.passwordHash).toBeNull();

      const c = await anonymous(ctx);
      expect((await register(ctx, "sky", PASSWORD, c.cookie)).status).toBe(409);

      // 归一化列才是唯一键:两条展示值相同的不同账号(归一值不同)必须允许
      const d = await anonymous(ctx);
      expect((await register(ctx, "Sky-o", PASSWORD, d.cookie)).status).toBe(200);
    });
  });

  it("REG-08 竞态:预检说谎时首写删除命中 0 ⇒ AUTH_REQUIRED,不建新 Session", async () => {
    await withApp(async (ctx) => {
      const anon = await anonymous(ctx);
      const sessions = (await ctx.prisma.session.findMany({ where: { userId: anon.userId } }))[0]!;
      // 模拟「controller 已解析到 active Session,随后被并发改写」:直接带一个已消失的 sessionId
      const hashSpy = vi.spyOn(AuthUserRepository.prototype, "upgradeAnonymousToRegistered");
      try {
        await expect(
          ctx.authSessions!.registerAnonymous({
            userId: anon.userId,
            sessionId: `${sessions.id}-gone`,
            username: "alice",
            passwordHash: "x",
          }),
        ).rejects.toMatchObject({ code: ErrorCodes.AUTH_REQUIRED });
        expect(hashSpy).not.toHaveBeenCalled();
      } finally {
        hashSpy.mockRestore();
      }
      // 失败即回滚:身份没被升级,库里也没有第二条 Session
      expect((await userById(ctx, anon.userId))!.type).toBe("ANONYMOUS");
      expect(await sessionCountOfUser(ctx, anon.userId)).toBe(1);
    });
  });

  it("REG-08b 竞态:CAS 命中 0 ⇒ AUTH_IDENTITY_NOT_ANONYMOUS 且删除一并回滚", async () => {
    await withApp(async (ctx) => {
      const anon = await anonymous(ctx);
      const session = (await ctx.prisma.session.findMany({ where: { userId: anon.userId } }))[0]!;
      await ctx.prisma.user.update({
        where: { id: anon.userId },
        data: { type: "REGISTERED", username: "pre", usernameNormalized: "pre", passwordHash: "h" },
      });
      await expect(
        ctx.authSessions!.registerAnonymous({
          userId: anon.userId,
          sessionId: session.id,
          username: "alice",
          passwordHash: "x",
        }),
      ).rejects.toMatchObject({ code: ErrorCodes.AUTH_IDENTITY_NOT_ANONYMOUS });
      // 事务内第一步的删除被回滚 ⇒ 原 Session 仍在,原展示名未被覆盖
      expect(await sessionCountOfUser(ctx, anon.userId)).toBe(1);
      const user = await userById(ctx, anon.userId);
      expect(user!.username).toBe("pre");
      expect(user!.usernameNormalized).toBe("pre");
    });
  });

  it("REG-09/10 REGISTERED 与 ADMIN 都不能注册 → 409,零 hash 零写库", async () => {
    await withApp(async (ctx) => {
      const reg = await registered(ctx);
      const upgradeSpy = vi.spyOn(AuthUserRepository.prototype, "upgradeAnonymousToRegistered");
      try {
        const again = await register(ctx, "bob", OTHER_PASSWORD, reg.cookie);
        expect(again.status).toBe(409);
        expect(errorCodeOf(await again.json())).toBe(ErrorCodes.AUTH_IDENTITY_NOT_ANONYMOUS);

        const adminLogin = await post(ctx, "/api/auth/login", { password: ADMIN_AUTH.password });
        expect(adminLogin.status).toBe(200);
        const asAdmin = await register(ctx, "carol", OTHER_PASSWORD, cookieOf(adminLogin));
        expect(asAdmin.status).toBe(409);
        expect(errorCodeOf(await asAdmin.json())).toBe(ErrorCodes.AUTH_IDENTITY_NOT_ANONYMOUS);

        expect(upgradeSpy).not.toHaveBeenCalled();
        // ADMIN 哨兵行未被写入任何凭据
        expect((await userById(ctx, ADMIN_USER_ID))!.username).toBeNull();
        expect((await userById(ctx, ADMIN_USER_ID))!.passwordHash).toBeNull();
      } finally {
        upgradeSpy.mockRestore();
      }
    });
  });

  it("REG-11 没有匿名身份 → 401 AUTH_REQUIRED,且不自动建匿名身份(§100)", async () => {
    await withApp(async (ctx) => {
      const res = await register(ctx, "alice", PASSWORD);
      expect(res.status).toBe(401);
      expect(errorCodeOf(await res.json())).toBe(ErrorCodes.AUTH_REQUIRED);
      expect(setCookieCount(res)).toBe(0);
      expect(
        await ctx.prisma.user.count({ where: { id: { notIn: [ADMIN_USER_ID, COMPAT_USER_ID] } } }),
      ).toBe(0);
    });
  });

  it("REG-12 DISABLED 身份 → 401 AUTH_USER_DISABLED,不建 Session 不改 Cookie", async () => {
    await withApp(async (ctx) => {
      const anon = await anonymous(ctx);
      await ctx.prisma.user.update({ where: { id: anon.userId }, data: { status: "DISABLED" } });
      const res = await register(ctx, "alice", PASSWORD, anon.cookie);
      expect(res.status).toBe(401);
      expect(errorCodeOf(await res.json())).toBe(ErrorCodes.AUTH_USER_DISABLED);
      expect(setCookieCount(res)).toBe(0);
      expect((await userById(ctx, anon.userId))!.type).toBe("ANONYMOUS");
      // 也不能借道 /anonymous 重建身份(V1.3 既有语义保持)
      const rebootstrap = await fetch(`${ctx.baseUrl}/api/auth/anonymous`, {
        method: "POST",
        headers: { Cookie: anon.cookie },
      });
      expect(rebootstrap.status).toBe(401);
      expect(errorCodeOf(await rebootstrap.json())).toBe(ErrorCodes.AUTH_REQUIRED);
    });
  });

  it("REG-13 COMPAT(AUTH_ENABLED=false)→ 403 且零 hash / 零写库 / 零 Cookie", async () => {
    await withApp(
      async (ctx) => {
        const upgradeSpy = vi.spyOn(AuthUserRepository.prototype, "upgradeAnonymousToRegistered");
        try {
          const res = await register(ctx, "alice", PASSWORD, `${AUTH_COOKIE_NAME}=anything`);
          expect(res.status).toBe(403);
          expect(errorCodeOf(await res.json())).toBe(ErrorCodes.AUTH_FORBIDDEN);
          expect(setCookieCount(res)).toBe(0);
          expect(upgradeSpy).not.toHaveBeenCalled();
          expect(await ctx.prisma.user.count()).toBe(2); // 只剩两个哨兵
          expect(await ctx.prisma.session.count()).toBe(0);
        } finally {
          upgradeSpy.mockRestore();
        }
      },
      { auth: null },
    );
  });

  it("REG-15 注册限流排在散列与事务之前:第 2 次尝试 429 且零身份写入", async () => {
    await withApp(
      async (ctx) => {
        const upgradeSpy = vi.spyOn(AuthUserRepository.prototype, "upgradeAnonymousToRegistered");
        const a = await anonymous(ctx);
        expect((await register(ctx, "alice", PASSWORD, a.cookie)).status).toBe(200);
        const b = await anonymous(ctx);
        const limited = await register(ctx, "bob", PASSWORD, b.cookie);
        expect(limited.status).toBe(429);
        expect(errorCodeOf(await limited.json())).toBe(ErrorCodes.AUTH_RATE_LIMITED);
        expect(await limited.headers.get("Retry-After")).not.toBeNull();
        expect(setCookieCount(limited)).toBe(0);
        expect(upgradeSpy).toHaveBeenCalledTimes(1);
        expect((await userById(ctx, b.userId))!.type).toBe("ANONYMOUS");
        expect((await userById(ctx, b.userId))!.passwordHash).toBeNull();
        upgradeSpy.mockRestore();
      },
      { abuse: { registerIpMaxAttempts: 1 } },
    );
  });

  it("REG-VAL 非法 username / 口令长度:400 且不消耗注册额度、不写库", async () => {
    await withApp(
      async (ctx) => {
        const anon = await anonymous(ctx);
        for (const bad of [
          { username: "ab", password: PASSWORD },
          { username: "ke 中文", password: PASSWORD },
          { username: "alice", password: "short" },
          { username: "alice", password: "a".repeat(129) },
        ]) {
          const res = await register(ctx, bad.username, bad.password, anon.cookie);
          expect(res.status, JSON.stringify(bad)).toBe(400);
          expect(errorCodeOf(await res.json())).toBe(ErrorCodes.VALIDATION_ERROR);
        }
        // 400 一次都不消耗额度 ⇒ 同 IP 随后仍可完成一次真注册
        expect((await register(ctx, "alice", PASSWORD, anon.cookie)).status).toBe(200);
      },
      { abuse: { registerIpMaxAttempts: 1 } },
    );
  });

  it("REG-DTO 注册成功后 /auth/session 返回 REGISTERED + username,且不外发凭据列", async () => {
    await withApp(async (ctx) => {
      const anon = await anonymous(ctx);
      const cookie = cookieOf(await register(ctx, "Alice", PASSWORD, anon.cookie));
      const probe = await fetch(`${ctx.baseUrl}/api/auth/session`, { headers: { Cookie: cookie } });
      const body = dataOf<Record<string, unknown>>(await probe.json());
      expect(body).toMatchObject({ authenticated: true, userType: "REGISTERED", username: "Alice" });
      const text = JSON.stringify(body);
      for (const leak of ["passwordHash", "usernameNormalized", "userId", "sessionId", "tokenHash"]) {
        expect(text, leak).not.toContain(leak);
      }
    });
  });
});

describe("LOGIN 普通账号登录(V1.4 U2 §82)", () => {
  it("LOGIN-01/10 凭据正确 → 200 并换发新 token,旧 token 失效", async () => {
    await withApp(async (ctx) => {
      const alice = await registered(ctx, "alice", PASSWORD);
      // 无 Cookie 的访客可直接登录(§101),不需要先 bootstrap 匿名
      const res = await userLogin(ctx, "alice", PASSWORD);
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

      const fresh = cookieOf(res);
      expect(fresh).not.toBe(alice.cookie);
      expect((await sessionOfCookie(ctx, fresh))!.userId).toBe(alice.userId);
      // 原注册 Session 仍在:两次登录互不撤销(§18 多设备)
      expect(await sessionCountOfUser(ctx, alice.userId)).toBe(2);
    });
  });

  it("LOGIN-02/03/04 用户名不存在与密码错:同码、同文案、同形状(不泄漏枚举信息)", async () => {
    await withApp(async (ctx) => {
      await registered(ctx, "alice", PASSWORD);
      const unknown = await userLogin(ctx, "nobody", PASSWORD);
      const wrong = await userLogin(ctx, "alice", "WrongPass1");
      expect(unknown.status).toBe(401);
      expect(wrong.status).toBe(401);
      const unknownBody = await unknown.json();
      const wrongBody = await wrong.json();
      expect(errorCodeOf(unknownBody)).toBe(ErrorCodes.AUTH_INVALID_CREDENTIALS);
      // 同形比较刻意排除 requestId(逐请求唯一,不是身份信息):码、文案、键集合都必须一致,
      // 不给「这个用户名存在吗」留任何信号
      expect(errorCodeOf(wrongBody)).toBe(errorCodeOf(unknownBody));
      expect(errorMessageOf(wrongBody)).toBe(errorMessageOf(unknownBody));
      expect("data" in (unknownBody as object)).toBe(false); // 错误响应没有 data 载荷
      expect("data" in (wrongBody as object)).toBe(false);
      expect(setCookieCount(unknown)).toBe(0);
      // 刻意只查请求侧的用户名(响应统一文案本身含 "password" 一词,那是设计选择)
      const text = JSON.stringify(unknownBody) + JSON.stringify(wrongBody);
      expect(text).not.toMatch(/alice|nobody/i);
      expect(text.toLowerCase()).not.toContain("passwordhash");
      expect(text.toLowerCase()).not.toContain("usernamenormalized");
    });
  });

  it("LOGIN-02b 匿名/管理员行不能成为 Registered 登录目标", async () => {
    await withApp(async (ctx) => {
      const anon = await anonymous(ctx);
      // 匿名行 usernameNormalized 为 NULL ⇒ 归一化查询根本命中不到它
      expect((await userLogin(ctx, "alice", PASSWORD)).status).toBe(401);
      expect((await userById(ctx, anon.userId))!.usernameNormalized).toBeNull();
      const asAdmin = await userLogin(ctx, "root", ADMIN_AUTH.password);
      expect(asAdmin.status).toBe(401);
      expect(errorCodeOf(await asAdmin.json())).toBe(ErrorCodes.AUTH_INVALID_CREDENTIALS);
      expect((await userById(ctx, ADMIN_USER_ID))!.passwordHash).toBeNull();
    });
  });

  it("LOGIN-05 目标账号被禁用:与密码错同码,绝不返回 AUTH_USER_DISABLED", async () => {
    await withApp(async (ctx) => {
      const alice = await registered(ctx, "alice", PASSWORD);
      await ctx.prisma.user.update({ where: { id: alice.userId }, data: { status: "DISABLED" } });
      const res = await userLogin(ctx, "alice", PASSWORD);
      expect(res.status).toBe(401);
      expect(errorCodeOf(await res.json())).toBe(ErrorCodes.AUTH_INVALID_CREDENTIALS);
      expect(await sessionCountOfUser(ctx, alice.userId)).toBe(1); // 不新建
    });
  });

  it("LOGIN-06/07 匿名 X 登录 alice:不合并数据、X 的旧 Session 被撤、X1/X2 原样保留", async () => {
    await withApp(async (ctx) => {
      const x = await anonymous(ctx);
      const xConversations = [
        await newConversation(ctx, x.cookie, "X1"),
        await newConversation(ctx, x.cookie, "X2"),
      ];
      const alice = await registered(ctx, "alice", PASSWORD);
      const aConversations = [await newConversation(ctx, alice.cookie, "A1")];

      const res = await userLogin(ctx, "alice", PASSWORD, x.cookie);
      expect(res.status).toBe(200);
      const cookie = cookieOf(res);

      expect((await listConversationIds(ctx, cookie)).sort()).toEqual([...aConversations].sort());
      for (const id of xConversations) {
        expect(
          (await listConversationIds(ctx, cookie)).includes(id),
          `匿名 X 的会话 ${id} 不应该出现在 alice 的列表里`,
        ).toBe(false);
      }
      // X 的数据既没被迁移也没被删除,owner 仍是 X
      const stillX = await ctx.prisma.conversation.findMany({
        where: { id: { in: xConversations } },
        select: { userId: true },
      });
      expect(stillX).toHaveLength(2);
      for (const row of stillX) expect(row.userId).toBe(x.userId);
      expect(await ctx.prisma.conversation.count({ where: { userId: alice.userId } })).toBe(1);
      // X 呈现的那条 Session 被撤销
      expect(await sessionOfCookie(ctx, x.cookie)).toBeNull();
    });
  });

  it("LOGIN-08/13 A 已登录再登录 B:只撤销当前这一条,A 的其它设备不掉线", async () => {
    await withApp(async (ctx) => {
      const alice = await registered(ctx, "alice", PASSWORD);
      // 同一账号的第二台设备(无 Cookie 登录)
      const phone = cookieOf(await userLogin(ctx, "alice", PASSWORD));
      expect(await sessionCountOfUser(ctx, alice.userId)).toBe(2);

      const bob = await registered(ctx, "bob", OTHER_PASSWORD);
      // PC 用 alice 的第一条 Session(bob 注册前拿的 cookie)去登录 bob
      const switchRes = await userLogin(ctx, "bob", OTHER_PASSWORD, alice.cookie);
      expect(switchRes.status).toBe(200);
      expect(dataOf<{ username: string }>(await switchRes.json()).username).toBe("bob");

      // A 的当前条失效,另一台设备仍有效,且 A 的数据一行没动
      expect(await sessionOfCookie(ctx, alice.cookie)).toBeNull();
      const phoneRow = await sessionOfCookie(ctx, phone);
      expect(phoneRow!.userId).toBe(alice.userId);
      expect(await sessionCountOfUser(ctx, bob.userId)).toBe(2);
      // 没有把 bob 的数据塞给 alice 的设备
      expect((await listConversationIds(ctx, phone)).length).toBe(0);
    });
  });

  it("LOGIN-09/15 只按 IP 计失败:换用户名不能绕过同一个桶", async () => {
    await withApp(
      async (ctx) => {
        await registered(ctx, "alice", PASSWORD);
        await registered(ctx, "bob", OTHER_PASSWORD);
        expect((await userLogin(ctx, "alice", "WrongPass1")).status).toBe(401);
        expect((await userLogin(ctx, "bob", "WrongPass2")).status).toBe(401);
        const blocked = await userLogin(ctx, "alice", PASSWORD);
        expect(blocked.status).toBe(429);
        expect(errorCodeOf(await blocked.json())).toBe(ErrorCodes.AUTH_RATE_LIMITED);
        // 桶键必然是 IP:两个不同 username 各失败一次就把这条 IP 的额度耗尽,
        // 若按 username 分桶,这次**正确密码**的登录会成功(§77 的绕过通道)。
        // 也证明 ADMIN 与 Registered 是两个独立实例:Registered 已满,ADMIN 仍可登录。
        expect((await post(ctx, "/api/auth/login", { password: ADMIN_AUTH.password })).status).toBe(
          200,
        );
      },
      { abuse: { userLoginIpMaxFailures: 2 } },
    );
  });

  it("LOGIN-09b 成功登录清零本 IP 的失败账(与 ADMIN 同一语义)", async () => {
    await withApp(
      async (ctx) => {
        await registered(ctx, "alice", PASSWORD);
        expect((await userLogin(ctx, "alice", "WrongPass1")).status).toBe(401);
        expect((await userLogin(ctx, "alice", PASSWORD)).status).toBe(200);
        // 额度已被成功登录清空:max=2 ⇒ 再累计两次 401 之后,下一次请求才被拦
        expect((await userLogin(ctx, "alice", "WrongPass2")).status).toBe(401);
        expect((await userLogin(ctx, "alice", "WrongPass3")).status).toBe(401);
        expect((await userLogin(ctx, "alice", PASSWORD)).status).toBe(429);
      },
      { abuse: { userLoginIpMaxFailures: 2 } },
    );
  });

  it("LOGIN-11 ADMIN 的 /auth/login 契约不变;{username,password} 不会变成 Registered 入口", async () => {
    await withApp(async (ctx) => {
      const ok = await post(ctx, "/api/auth/login", { password: ADMIN_AUTH.password });
      expect(ok.status).toBe(200);
      expect(dataOf<{ userType: string }>(await ok.json()).userType).toBe("ADMIN");

      const both = await post(ctx, "/api/auth/login", {
        username: "alice",
        password: ADMIN_AUTH.password,
      });
      expect(both.status).toBe(200); // 多出来的 username 被忽略,绝不改判成 Registered
      expect(dataOf<{ userType: string; username: unknown }>(await both.json()).userType).toBe(
        "ADMIN",
      );

      const wrong = await post(ctx, "/api/auth/login", { password: "not-the-admin-password" });
      expect(wrong.status).toBe(401);
      expect(errorCodeOf(await wrong.json())).toBe(ErrorCodes.AUTH_INVALID_CREDENTIALS);
    });
  });

  it("LOGIN-12 同一账号多设备:无 Cookie 的登录不踢任何旧设备;带 Session 的登录只替换那一条", async () => {
    await withApp(async (ctx) => {
      const alice = await registered(ctx, "alice", PASSWORD); // Session A
      const phone = cookieOf(await userLogin(ctx, "alice", PASSWORD)); // 无 Cookie → Session B
      expect(await sessionCountOfUser(ctx, alice.userId)).toBe(2);
      for (const cookie of [alice.cookie, phone]) {
        const probe = await fetch(`${ctx.baseUrl}/api/auth/session`, { headers: { Cookie: cookie } });
        expect(dataOf<{ authenticated: boolean }>(await probe.json()).authenticated).toBe(true);
      }

      // 带着 A 再登录一次:只轮换 A 自己,B(另一台设备)必须不受影响
      const rotated = cookieOf(await userLogin(ctx, "alice", PASSWORD, alice.cookie));
      expect(await sessionCountOfUser(ctx, alice.userId)).toBe(2);
      expect(await sessionOfCookie(ctx, alice.cookie)).toBeNull();
      expect(dataOf<{ authenticated: boolean }>(
        await (await fetch(`${ctx.baseUrl}/api/auth/session`, { headers: { Cookie: rotated } })).json(),
      ).authenticated).toBe(true);
      expect(dataOf<{ authenticated: boolean }>(
        await (await fetch(`${ctx.baseUrl}/api/auth/session`, { headers: { Cookie: phone } })).json(),
      ).authenticated).toBe(true);
    });
  });

  it("LOGIN-14 COMPAT → 403 且零 Session 零 Cookie", async () => {
    await withApp(
      async (ctx) => {
        const res = await userLogin(ctx, "alice", PASSWORD);
        expect(res.status).toBe(403);
        expect(errorCodeOf(await res.json())).toBe(ErrorCodes.AUTH_FORBIDDEN);
        expect(setCookieCount(res)).toBe(0);
        expect(await ctx.prisma.session.count()).toBe(0);
      },
      { auth: null },
    );
  });

  it("LOGIN-16 竞态:预检说谎 ⇒ 败方 401,不留下第二条 Session", async () => {
    await withApp(async (ctx) => {
      const alice = await registered(ctx, "alice", PASSWORD);
      const presented = (await ctx.prisma.session.findMany({ where: { userId: alice.userId } }))[0]!;
      const lookup = vi.spyOn(AuthSessionRepository.prototype, "findByTokenHash");
      try {
        // resolve 命中一条「仍然有效」的行(返回假数据),而真实行在事务前已被并发者删掉
        lookup.mockImplementationOnce(async (db, tokenHash) => {
          await ctx.prisma.session.delete({ where: { id: presented.id } });
          return {
            id: presented.id,
            userId: presented.userId,
            tokenHash,
            expiresAt: new Date(Date.now() + 60_000),
            lastSeenAt: new Date(),
            createdAt: new Date(),
            user: { id: presented.userId, type: "ANONYMOUS", status: "ACTIVE", username: null },
          };
        });
        await expect(
          ctx.authSessions!.loginRegistered({
            username: "alice",
            password: PASSWORD,
            presentedToken: tokenOf(alice.cookie),
          }),
        ).rejects.toMatchObject({ code: ErrorCodes.AUTH_REQUIRED });
      } finally {
        lookup.mockRestore();
      }
      // 只可能有一个转换成功:alice 名下仍是 1 条(被并发者删掉的那条也算已消失)
      expect(await sessionCountOfUser(ctx, alice.userId)).toBe(0);
    });
  });

  it("LOGIN-CAP-01 Registered limiter 满容量:新 IP 503 SERVICE_BUSY,零凭据查询零校验", async () => {
    await withApp(
      async (ctx) => {
        await registered(ctx, "alice", PASSWORD);
        const lookup = vi.spyOn(AuthUserRepository.prototype, "findByNormalizedUsername");
        try {
          // 用 XFF 仿真两个来源 IP 把键表(maxKeys=2)填满,第三个 IP 撞容量
          const from = (ip: string) => ({ "X-Forwarded-For": ip });
          expect((await userLogin(ctx, "alice", "WrongPass1", undefined, from("203.0.113.1"))).status)
            .toBe(401);
          expect((await userLogin(ctx, "alice", "WrongPass2", undefined, from("203.0.113.2"))).status)
            .toBe(401);
          lookup.mockClear();

          const blocked = await userLogin(ctx, "alice", PASSWORD, undefined, from("203.0.113.3"));
          expect(blocked.status).toBe(503);
          expect(errorCodeOf(await blocked.json())).toBe(PublicErrorCodes.SERVICE_BUSY);
          // 口令校验排在 limiter 之后:连凭据都没查 ⇒ verify 更不可能发生
          expect(lookup).not.toHaveBeenCalled();
          // 已存在的 IP 不受容量影响,仍按自己的窗口判定(§52)
          expect(
            (await userLogin(ctx, "alice", PASSWORD, undefined, from("203.0.113.1"))).status,
          ).toBe(429);
        } finally {
          lookup.mockRestore();
        }
      },
      {
        auth: authDeps({ trustProxy: true }),
        // maxKeys=2 + 每 IP 1 次即触顶:前两个 IP 各建一桶填满容量,第三个 IP 撞 fail-closed
        abuse: { maxKeys: 2, userLoginIpMaxFailures: 1 },
      },
    );
  });

  it("ADMIN-LOGIN-CAP-01 ADMIN limiter 满容量同样 fail-closed:503 而不是绕过口令校验", async () => {
    await withApp(
      async (ctx) => {
        expect((await post(ctx, "/api/auth/login", { password: "bad-password-xxxx" })).status)
          .toBe(401);
        expect(
          (await post(ctx, "/api/auth/login", { password: "bad-password-yyyy" }, undefined, {
            "X-Forwarded-For": "203.0.113.2",
          })).status,
        ).toBe(401);

        const third = await post(ctx, "/api/auth/login", { password: ADMIN_AUTH.password }, undefined, {
          "X-Forwarded-For": "203.0.113.3",
        });
        expect(third.status).toBe(503);
        expect(errorCodeOf(await third.json())).toBe(PublicErrorCodes.SERVICE_BUSY);
        // 关键:容量耗尽时连正确密码也不能换来一条新 ADMIN Session
        expect(await ctx.prisma.session.count({ where: { userId: ADMIN_USER_ID } })).toBe(0);
      },
      // ADMIN 那份 limiter 至今仍在控制器内默认创建(§75 本轮不搬装配),
      // 所以容量只能经既有的 loginRateLimiter 测试接缝注入
      {
        auth: authDeps({ trustProxy: true }),
        loginRateLimiter: new LoginRateLimiter({ maxKeys: 2 }),
      },
    );
  });
});
