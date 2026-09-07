import { afterEach, describe, expect, it } from "vitest";

import { LoginRateLimiter } from "../../src/modules/auth/auth.rate-limit.js";

const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function createLimiter(clock = fakeClock(), maxKeys = 10_000): LoginRateLimiter {
  return new LoginRateLimiter({
    clock,
    sweepIntervalMs: 3_600_000,
    maxKeys,
  });
}

const limiters: LoginRateLimiter[] = [];

function tracked(limiter: LoginRateLimiter): LoginRateLimiter {
  limiters.push(limiter);
  return limiter;
}

afterEach(() => {
  for (const limiter of limiters) limiter.dispose();
  limiters.length = 0;
});

describe("LoginRateLimiter(AUTH-24)", () => {
  it("窗口内累计 5 次失败后第 6 次被拦截", () => {
    const clock = fakeClock();
    const limiter = tracked(createLimiter(clock));

    for (let i = 0; i < 4; i += 1) limiter.registerFailure("ip-a");
    expect(limiter.check("ip-a").blocked).toBe(false);

    limiter.registerFailure("ip-a");
    expect(limiter.check("ip-a")).toEqual({
      blocked: true,
      retryAfterSeconds: Math.ceil(WINDOW_MS / 1000),
    });
  });

  it("窗口边界:窗口最后一毫秒仍拦截,窗口一过即放行", () => {
    const clock = fakeClock();
    const limiter = tracked(createLimiter(clock));

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) limiter.registerFailure("ip-a");
    clock.advance(WINDOW_MS - 1);
    expect(limiter.check("ip-a").blocked).toBe(true);

    clock.advance(1);
    expect(limiter.check("ip-a").blocked).toBe(false);
  });

  it("窗口过期后新失败重新起算,不继承旧计数", () => {
    const clock = fakeClock();
    const limiter = tracked(createLimiter(clock));

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) limiter.registerFailure("ip-a");
    clock.advance(WINDOW_MS + 1);
    limiter.registerFailure("ip-a");

    expect(limiter.check("ip-a").blocked).toBe(false);
    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) limiter.registerFailure("ip-a");
    expect(limiter.check("ip-a").blocked).toBe(true);
  });

  it("成功清零:reset 后再失败从 1 起算,不立即 429", () => {
    const clock = fakeClock();
    const limiter = tracked(createLimiter(clock));

    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) limiter.registerFailure("ip-a");
    limiter.reset("ip-a");
    limiter.registerFailure("ip-a");

    expect(limiter.check("ip-a").blocked).toBe(false);
  });

  it("键隔离:不同 ip 互不影响", () => {
    const clock = fakeClock();
    const limiter = tracked(createLimiter(clock));

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) limiter.registerFailure("ip-a");

    expect(limiter.check("ip-a").blocked).toBe(true);
    expect(limiter.check("ip-b").blocked).toBe(false);
  });

  it("Retry-After 按窗口剩余毫秒向上取整为秒", () => {
    const clock = fakeClock();
    const limiter = tracked(createLimiter(clock));

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) limiter.registerFailure("ip-a");
    clock.advance(1000);

    const status = limiter.check("ip-a");
    expect(status).toEqual({
      blocked: true,
      retryAfterSeconds: Math.ceil((WINDOW_MS - 1000) / 1000),
    });
  });

  it("键上限淘汰:超限时按插入序淘汰最旧键,新键可插入", () => {
    const clock = fakeClock();
    const limiter = tracked(createLimiter(clock, 2));

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) limiter.registerFailure("ip-1");
    clock.advance(1);
    limiter.registerFailure("ip-2");
    clock.advance(1);
    limiter.registerFailure("ip-3");

    // ip-1 最旧被淘汰,桶被删除
    expect(limiter.check("ip-1").blocked).toBe(false);
    expect(limiter.check("ip-2").blocked).toBe(false);
    expect(limiter.check("ip-3").blocked).toBe(false);

    // 淘汰后的键可重新插入并按新窗口计数
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) limiter.registerFailure("ip-1");
    expect(limiter.check("ip-1").blocked).toBe(true);
  });

  it("sweep 清理过期窗口,保留活跃窗口", () => {
    const clock = fakeClock();
    const limiter = tracked(createLimiter(clock));

    limiter.registerFailure("ip-old");
    clock.advance(WINDOW_MS + 1);
    limiter.registerFailure("ip-new");
    limiter.sweep();

    expect(limiter.check("ip-new").blocked).toBe(false);
    // 过期键被删除后重新失败按新窗口计数,而非叠加旧计数
    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) limiter.registerFailure("ip-old");
    expect(limiter.check("ip-old").blocked).toBe(false);
  });
});
