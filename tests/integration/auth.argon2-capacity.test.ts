import { describe, expect, it } from "vitest";

import { PublicErrorCodes } from "../../src/common/errors/public-error.js";
import { FixedWindowRateLimiter } from "../../src/common/rate-limit/rate-limiter.js";
import { Argon2CapacityGate } from "../../src/modules/auth/auth.argon2-capacity.js";
import {
  createPasswordCrypto,
  type PasswordCrypto,
  type RawPasswordCrypto,
} from "../../src/modules/auth/auth.password.js";
import { ADMIN_AUTH, setupTestContext, type TestContext } from "../helpers.js";

const PASSWORD = "Password123!";
const OTHER_PASSWORD = "AnotherPass123!";

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fakeCrypto(gate: Argon2CapacityGate) {
  const nextHash: Deferred<string>[] = [];
  const nextVerify: Deferred<boolean>[] = [];
  const hashStarted: Deferred<void>[] = [];
  const verifyStarted: Deferred<void>[] = [];
  const stats = { hashCalls: 0, verifyCalls: 0 };
  const raw: RawPasswordCrypto = {
    async hash(password) {
      stats.hashCalls += 1;
      const held = nextHash.shift();
      if (held !== undefined) {
        hashStarted.shift()?.resolve(undefined);
        return held.promise;
      }
      return `fake:${password}`;
    },
    async verify(hashed, password) {
      stats.verifyCalls += 1;
      const held = nextVerify.shift();
      if (held !== undefined) {
        verifyStarted.shift()?.resolve(undefined);
        return held.promise;
      }
      return hashed === `fake:${password}`;
    },
  };
  return {
    crypto: createPasswordCrypto(gate, raw),
    nextHash,
    nextVerify,
    hashStarted,
    verifyStarted,
    stats,
    reset(): void {
      stats.hashCalls = 0;
      stats.verifyCalls = 0;
    },
  };
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

function cookieOf(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (value === null) throw new Error("missing session cookie");
  return value.split(";", 1)[0];
}

async function anonymous(ctx: TestContext): Promise<string> {
  return cookieOf(await post(ctx, "/api/auth/anonymous", {}));
}

async function registered(
  ctx: TestContext,
  username: string,
  password = PASSWORD,
): Promise<string> {
  const anon = await anonymous(ctx);
  const response = await post(ctx, "/api/auth/register", { username, password }, anon);
  expect(response.status).toBe(200);
  return cookieOf(response);
}

async function withApp<T>(
  gate: Argon2CapacityGate,
  crypto: PasswordCrypto,
  fn: (ctx: TestContext) => Promise<T>,
  options: { passwordChangeRateLimiter?: FixedWindowRateLimiter } = {},
): Promise<T> {
  const ctx = await setupTestContext({
    auth: ADMIN_AUTH,
    argon2CapacityGate: gate,
    passwordCrypto: crypto,
    passwordChangeRateLimiter: options.passwordChangeRateLimiter,
    abuse: {
      userLoginIpMaxFailures: 1_000,
      registerIpMaxAttempts: 1_000,
    },
  });
  try {
    await ctx.reset();
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

describe("D1C Global Argon2 Capacity", () => {
  it("AGC-05 register capacity 满时 503,不调用 hash、不升级 User", async () => {
    const gate = new Argon2CapacityGate(1);
    const fake = fakeCrypto(gate);
    await withApp(gate, fake.crypto, async (ctx) => {
      const anon = await anonymous(ctx);
      fake.reset();
      const lease = gate.tryAcquire()!;
      const response = await post(ctx, "/api/auth/register", { username: "alice", password: PASSWORD }, anon);
      lease.release();
      expect(response.status).toBe(503);
      expect(errorCode(await response.json())).toBe(PublicErrorCodes.SERVICE_BUSY);
      expect(fake.stats.hashCalls).toBe(0);
      expect(await ctx.prisma.user.count({ where: { username: "alice" } })).toBe(0);
    });
  });

  it("AGC-06 existing/unknown login capacity 满同为 503 且 zero verify;有容量时 unknown 仍 verify DUMMY", async () => {
    const gate = new Argon2CapacityGate(1);
    const fake = fakeCrypto(gate);
    await withApp(gate, fake.crypto, async (ctx) => {
      await registered(ctx, "alice");
      fake.reset();
      const lease = gate.tryAcquire()!;
      const existing = await post(ctx, "/api/auth/user/login", { username: "alice", password: PASSWORD });
      const unknown = await post(ctx, "/api/auth/user/login", { username: "missing", password: PASSWORD });
      lease.release();
      expect(existing.status).toBe(503);
      expect(unknown.status).toBe(503);
      expect(errorCode(await existing.json())).toBe(PublicErrorCodes.SERVICE_BUSY);
      expect(errorCode(await unknown.json())).toBe(PublicErrorCodes.SERVICE_BUSY);
      expect(fake.stats.verifyCalls).toBe(0);

      const available = await post(ctx, "/api/auth/user/login", { username: "missing", password: PASSWORD });
      expect(available.status).toBe(401);
      expect(fake.stats.verifyCalls).toBe(1);
    });
  });

  it("AGC-07 password-change 先消费 D1B User budget,再做 global admission", async () => {
    const gate = new Argon2CapacityGate(1);
    const fake = fakeCrypto(gate);
    const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, max: 5 });
    await withApp(gate, fake.crypto, async (ctx) => {
      const cookie = await registered(ctx, "alice");
      const user = await ctx.prisma.user.findUnique({ where: { usernameNormalized: "alice" } });
      const beforeHash = user!.passwordHash;
      const beforeSessions = await ctx.prisma.session.count({ where: { userId: user!.id } });
      fake.reset();
      const lease = gate.tryAcquire()!;
      const response = await post(
        ctx,
        "/api/auth/password/change",
        { currentPassword: PASSWORD, newPassword: "Changed123!" },
        cookie,
      );
      lease.release();
      expect(response.status).toBe(503);
      expect(errorCode(await response.json())).toBe(PublicErrorCodes.SERVICE_BUSY);
      expect(fake.stats.verifyCalls).toBe(0);
      expect(fake.stats.hashCalls).toBe(0);
      expect(limiter.keyCount()).toBe(1);
      expect((await ctx.prisma.user.findUnique({ where: { id: user!.id } }))!.passwordHash).toBe(beforeHash);
      expect(await ctx.prisma.session.count({ where: { userId: user!.id } })).toBe(beforeSessions);
    }, { passwordChangeRateLimiter: limiter });
  });

  it("AGC-08 hash-stage capacity reject 不写 password/session,且 public 只见 SERVICE_BUSY", async () => {
    const gate = new Argon2CapacityGate(1);
    const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, max: 5 });
    const stats = { hashCalls: 0, verifyCalls: 0 };
    const raw: RawPasswordCrypto = {
      async hash(password) {
        stats.hashCalls += 1;
        return `fake:${password}`;
      },
      async verify() {
        stats.verifyCalls += 1;
        return true;
      },
    };
    const gated = createPasswordCrypto(gate, raw);
    let blocker: ReturnType<Argon2CapacityGate["tryAcquire"]> = null;
    let holdAfterVerify = false;
    const crypto: PasswordCrypto = {
      verifyPassword: async (hashed, password) => {
        const verified = await gated.verifyPassword(hashed, password);
        if (verified && holdAfterVerify) {
          blocker = gate.tryAcquire();
          if (blocker === null) {
            throw new Error("test blocker failed to acquire Argon2 permit");
          }
        }
        return verified;
      },
      hashPassword: (password) => gated.hashPassword(password),
    };
    await withApp(gate, crypto, async (ctx) => {
      const cookie = await registered(ctx, "alice");
      const secondCookieResponse = await post(
        ctx,
        "/api/auth/user/login",
        { username: "alice", password: PASSWORD },
      );
      expect(secondCookieResponse.status).toBe(200);
      const secondCookie = cookieOf(secondCookieResponse);
      const user = await ctx.prisma.user.findUnique({ where: { usernameNormalized: "alice" } });
      const beforeHash = user!.passwordHash;
      const beforeSessions = await ctx.prisma.session.findMany({
        where: { userId: user!.id },
        orderBy: { id: "asc" },
      });
      stats.hashCalls = 0;
      stats.verifyCalls = 0;
      holdAfterVerify = true;
      try {
        const response = await post(
          ctx,
          "/api/auth/password/change",
          { currentPassword: PASSWORD, newPassword: "Changed123!" },
          cookie,
        );
        expect(response.status).toBe(503);
        expect(errorCode(await response.json())).toBe(PublicErrorCodes.SERVICE_BUSY);
        expect(stats.verifyCalls).toBe(1);
        expect(stats.hashCalls).toBe(0);
        expect(limiter.keyCount()).toBe(1);
        expect(gate.activeCount()).toBe(1);
        expect((await ctx.prisma.user.findUnique({ where: { id: user!.id } }))!.passwordHash).toBe(
          beforeHash,
        );
        expect(
          await ctx.prisma.session.findMany({
            where: { userId: user!.id },
            orderBy: { id: "asc" },
          }),
        ).toEqual(beforeSessions);
        expect(secondCookie).not.toBe(cookie);
      } finally {
        holdAfterVerify = false;
        blocker?.release();
      }
      expect(gate.activeCount()).toBe(0);
    }, { passwordChangeRateLimiter: limiter });
  });

  it("AGC-09/10 register + login 占满同一个 gate 时,password-change fail-fast", async () => {
    const gate = new Argon2CapacityGate(2);
    const fake = fakeCrypto(gate);
    await withApp(gate, fake.crypto, async (ctx) => {
      const alice = await registered(ctx, "alice");
      const anon = await anonymous(ctx);
      fake.reset();
      const heldHash = deferred<string>();
      const heldVerify = deferred<boolean>();
      fake.nextHash.push(heldHash);
      fake.nextVerify.push(heldVerify);
      const hashStarted = deferred<void>();
      const verifyStarted = deferred<void>();
      fake.hashStarted.push(hashStarted);
      fake.verifyStarted.push(verifyStarted);
      const registerRequest = post(ctx, "/api/auth/register", { username: "bob", password: OTHER_PASSWORD }, anon);
      const loginRequest = post(ctx, "/api/auth/user/login", { username: "alice", password: PASSWORD });
      await Promise.all([hashStarted.promise, verifyStarted.promise]);
      const passwordChange = await post(ctx, "/api/auth/password/change", { currentPassword: PASSWORD, newPassword: "Changed123!" }, alice);
      expect(passwordChange.status).toBe(503);
      expect(errorCode(await passwordChange.json())).toBe(PublicErrorCodes.SERVICE_BUSY);
      expect(fake.stats.hashCalls).toBe(1);
      expect(fake.stats.verifyCalls).toBe(1);
      heldHash.resolve("fake:AnotherPass123!");
      heldVerify.resolve(true);
      expect((await registerRequest).status).toBe(200);
      expect((await loginRequest).status).toBe(200);
    });
  });

  it("AGC-11 ADMIN SHA-256 login 不受 Argon2 gate 满容量影响", async () => {
    const gate = new Argon2CapacityGate(1);
    const fake = fakeCrypto(gate);
    await withApp(gate, fake.crypto, async (ctx) => {
      const lease = gate.tryAcquire()!;
      const response = await post(ctx, "/api/auth/login", { password: ADMIN_AUTH.password });
      lease.release();
      expect(response.status).toBe(200);
    });
  });
});
