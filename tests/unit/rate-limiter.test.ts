import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FixedWindowRateLimiter,
  type RateLimitClock,
} from "../../src/common/rate-limit/rate-limiter.js";
import { AnonymousIpRateLimiter } from "../../src/modules/auth/auth.anonymous-rate-limit.js";
import { LoginRateLimiter } from "../../src/modules/auth/auth.rate-limit.js";
import {
  ANONYMOUS_IP_DAY_WINDOW_MS,
  ANONYMOUS_IP_HOUR_WINDOW_MS,
  AUTH_LOGIN_WINDOW_MS,
} from "../../src/config/constants.js";

/** 可推进假时钟(§125:窗口边界必须能钉在最后一毫秒上验,不能靠真时间) */
function fakeClock(start = 0) {
  let now = start;
  const clock: RateLimitClock = { now: () => now };
  return { clock, advance: (ms: number) => (now += ms) };
}

const HOUR = ANONYMOUS_IP_HOUR_WINDOW_MS;
const DAY = ANONYMOUS_IP_DAY_WINDOW_MS;

const disposables: { dispose(): void }[] = [];

afterEach(() => {
  for (const item of disposables.splice(0)) item.dispose();
  vi.restoreAllMocks();
});

describe("FixedWindowRateLimiter(P6 §19 通用限流原语)", () => {
  it("P6-LIM-01 上限内放行;达到上限后拒绝,且被拒的请求不再推进窗口", () => {
    const { clock, advance } = fakeClock();
    const limiter = new FixedWindowRateLimiter({ windowMs: 1_000, max: 3, clock });
    disposables.push(limiter);

    for (let i = 0; i < 3; i += 1) {
      expect(limiter.register("k").limited).toBe(false);
    }
    // 第 4 次被拒:窗口起点不因此后移(否则被拒请求可以无限续命)
    expect(limiter.register("k").limited).toBe(true);
    advance(999);
    expect(limiter.register("k").limited).toBe(true);
    advance(1);
    expect(limiter.register("k").limited).toBe(false);
  });

  it("P6-LIM-02 窗口边界:最后一毫秒仍拒,越过边界即放行", () => {
    const { clock, advance } = fakeClock();
    const limiter = new FixedWindowRateLimiter({ windowMs: 1_000, max: 1, clock });
    disposables.push(limiter);

    expect(limiter.register("k").limited).toBe(false);
    advance(999);
    expect(limiter.peek("k")).toEqual({ limited: true, retryAfterSeconds: 1 });
    advance(1);
    expect(limiter.peek("k")).toEqual({ limited: false });
  });

  it("P6-LIM-03 键隔离:一个键超限不影响别的键", () => {
    const { clock } = fakeClock();
    const limiter = new FixedWindowRateLimiter({ windowMs: 1_000, max: 1, clock });
    disposables.push(limiter);

    expect(limiter.register("a").limited).toBe(false);
    expect(limiter.register("b").limited).toBe(false);
    expect(limiter.peek("a").limited).toBe(true);
    expect(limiter.peek("b").limited).toBe(true);
    expect(limiter.register("c").limited).toBe(false);
  });

  it("P6-LIM-04 Retry-After 按窗口剩余毫秒向上取整,且至少 1 秒", () => {
    const { clock, advance } = fakeClock();
    const limiter = new FixedWindowRateLimiter({ windowMs: 2_000, max: 1, clock });
    disposables.push(limiter);

    limiter.register("k");
    advance(1);
    expect(limiter.peek("k")).toEqual({ limited: true, retryAfterSeconds: 2 });
    advance(1_999);
    // 已过窗口:放行,不给 Retry-After
    expect(limiter.peek("k")).toEqual({ limited: false });
    limiter.register("k");
    advance(1_999);
    expect(limiter.peek("k")).toEqual({ limited: true, retryAfterSeconds: 1 });
  });

  it("P6-LIM-05 sweep 只清过期窗口,活跃键保留(§20 内存可回收)", () => {
    const { clock, advance } = fakeClock();
    const limiter = new FixedWindowRateLimiter({ windowMs: 1_000, max: 1, clock });
    disposables.push(limiter);

    limiter.register("old");
    advance(500);
    limiter.register("new");
    expect(limiter.keyCount()).toBe(2);

    advance(600);
    limiter.sweep();
    expect(limiter.keyCount()).toBe(1);
    // 过期键被删后重新计数,而不是继承旧账
    expect(limiter.register("old").limited).toBe(false);
    expect(limiter.peek("new").limited).toBe(true);
  });

  it("P6-LIM-06 键数有上限:满容量时新键 fail-closed,绝不淘汰还在窗口内的 bucket(P10 §46/§47)", () => {
    const { clock } = fakeClock();
    const limiter = new FixedWindowRateLimiter({ windowMs: 1_000, max: 2, clock, maxKeys: 2 });
    disposables.push(limiter);

    limiter.register("k1"); // count 1
    limiter.register("k1"); // count 2 = k1 已到自己的窗口上限
    limiter.register("k2"); // map 满(2 keys)
    const blocked = limiter.register("k3");
    expect(blocked).toEqual({ limited: true, capacityExceeded: true });
    expect(limiter.keyCount()).toBe(2);
    // k1 仍在原窗口、仍带着 count=2(max=1 分不出这一条,必须 max=2):
    // 若被淘汰重插,它会变成新桶(count=1、窗口重启),而这里它读起来仍是「到顶」
    expect(limiter.peek("k1")).toEqual({ limited: true, retryAfterSeconds: 1 });
    expect(limiter.keyCount()).toBe(2);
  });

  it("P10-LIMIT-01/A LIMIT-CAP-01 maxKeys=3:A/B/C 活跃,D 到达 → capacityExceeded 且 A/B/C 不被删除(§54)", () => {
    const { clock } = fakeClock();
    const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, max: 100, clock, maxKeys: 3 });
    disposables.push(limiter);
    for (const k of ["A", "B", "C"]) {
      expect(limiter.register(k).limited).toBe(false);
    }
    expect(limiter.register("D")).toEqual({ limited: true, capacityExceeded: true });
    expect(limiter.keyCount()).toBe(3);
    for (const k of ["A", "B", "C"]) {
      expect(limiter.hasCapacity(k)).toBe(true);
    }
  });

  it("P10-LIMIT-02/A LIMIT-CAP-02 D 被拒后 A 保留原 count,未被淘汰重置(§55/§52)", () => {
    const { clock } = fakeClock();
    const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, max: 2, clock, maxKeys: 3 });
    disposables.push(limiter);
    limiter.register("A"); // count 1
    limiter.register("A"); // count 2 = A 已到顶
    limiter.register("B");
    limiter.register("C");
    expect(limiter.register("D").capacityExceeded).toBe(true);
    // A 仍是 count=2(在窗口内、在 map 里),不是被淘汰后清零
    expect(limiter.peek("A")).toEqual({ limited: true, retryAfterSeconds: 60 });
  });

  it("P10-LIMIT-01/B LIMIT-CAP-03 推进时钟让 A/B 过期:sweep 释放容量,D 重新可建(§53/§56)", () => {
    const { clock, advance } = fakeClock();
    const limiter = new FixedWindowRateLimiter({ windowMs: 1_000, max: 10, clock, maxKeys: 3 });
    disposables.push(limiter);
    limiter.register("A");
    limiter.register("B");
    advance(1_500); // A/B 全部过期
    limiter.register("C"); // C 在 1500ms 起新窗口
    expect(limiter.register("D").limited).toBe(false); // sweep 先清掉 A/B 再建 D
    expect(limiter.keyCount()).toBe(2); // C + D,map 未膨胀
  });

  it("P6-LIM-07 定时器 unref + dispose:测试环境不会因它挂住(§20/§106)", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const limiter = new FixedWindowRateLimiter({
      windowMs: 1_000,
      max: 1,
      clock: fakeClock().clock,
      sweepIntervalMs: 60_000,
    });

    const timer = setIntervalSpy.mock.results[0]?.value as NodeJS.Timeout;
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(timer.hasRef()).toBe(false);

    limiter.dispose();
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    // 重复 dispose 不允许把 clearInterval 打到别的定时器上
    clearIntervalSpy.mockClear();
    limiter.dispose();
    expect(clearIntervalSpy).not.toHaveBeenCalled();
  });
});

describe("AnonymousIpRateLimiter(P6 §18 小时 + 天双窗口)", () => {
  it("P6-LIM-08 小时窗口先到顶即拒;小时窗口滚动后天窗口继续累计", () => {
    const { clock, advance } = fakeClock();
    const limiter = new AnonymousIpRateLimiter({ perHour: 2, perDay: 3, clock });
    disposables.push(limiter);

    expect(limiter.consume("ip").limited).toBe(false);
    expect(limiter.consume("ip").limited).toBe(false);
    // 小时窗口内第 3 次:拒绝,并按小时窗口剩余给 Retry-After
    expect(limiter.consume("ip")).toEqual({ limited: true, retryAfterSeconds: HOUR / 1000 });

    advance(HOUR);
    expect(limiter.consume("ip").limited).toBe(false);
    // 天窗口已累计 3 次 → 第 4 次由天窗口拒绝(小时窗口此时有余量)
    expect(limiter.consume("ip").limited).toBe(true);
    advance(HOUR);
    expect(limiter.consume("ip").limited).toBe(true);
    advance(DAY - HOUR);
    expect(limiter.consume("ip").limited).toBe(false);
  });

  it("P6-LIM-09 两窗口同时超限取更久的;只有小时超限时取小时的", () => {
    const both = fakeClock();
    const tightBoth = new AnonymousIpRateLimiter({ perHour: 1, perDay: 1, clock: both.clock });
    disposables.push(tightBoth);
    expect(tightBoth.consume("ip").limited).toBe(false);
    // 小时剩 1 小时、天剩 24 小时:客户端按更久的那个来,才不会再撞墙
    expect(tightBoth.consume("ip")).toEqual({ limited: true, retryAfterSeconds: DAY / 1000 });

    const hourOnly = fakeClock();
    const looseDay = new AnonymousIpRateLimiter({
      perHour: 1,
      perDay: 100,
      clock: hourOnly.clock,
    });
    disposables.push(looseDay);
    looseDay.consume("ip");
    expect(looseDay.consume("ip")).toEqual({ limited: true, retryAfterSeconds: HOUR / 1000 });
  });

  it("P6-LIM-10 50 次同步 consume 在 limit=5 下恰好 5 次通过(§22 原子性)", () => {
    const { clock } = fakeClock();
    const limiter = new AnonymousIpRateLimiter({ perHour: 5, perDay: 5, clock });
    disposables.push(limiter);

    let passed = 0;
    for (let i = 0; i < 50; i += 1) {
      if (!limiter.consume("ip").limited) passed += 1;
    }
    expect(passed).toBe(5);
  });

  it("P6-LIM-11 键数量按窗口分别可清;sweep 后归零", () => {
    const { clock, advance } = fakeClock();
    const limiter = new AnonymousIpRateLimiter({ perHour: 10, perDay: 10, clock });
    disposables.push(limiter);

    limiter.consume("ip-a");
    limiter.consume("ip-b");
    expect(limiter.keyCount()).toEqual({ hour: 2, day: 2 });

    advance(HOUR + 1);
    limiter.sweep();
    expect(limiter.keyCount()).toEqual({ hour: 0, day: 2 });

    advance(DAY - HOUR);
    limiter.sweep();
    expect(limiter.keyCount()).toEqual({ hour: 0, day: 0 });
  });

  it("P6-LIM-12 dispose 撤掉两个窗口各自的定时器", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const limiter = new AnonymousIpRateLimiter({
      perHour: 1,
      perDay: 1,
      clock: fakeClock().clock,
    });
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    const timers = setIntervalSpy.mock.results.map((r) => r.value as NodeJS.Timeout);
    limiter.dispose();
    for (const timer of timers) {
      expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    }
  });

  it("P10-LIMIT-03 匿名双窗口满容量:consume 返回 capacityExceeded 且两边都不计数(§50)", () => {
    const { clock } = fakeClock();
    const limiter = new AnonymousIpRateLimiter({ perHour: 10, perDay: 100, maxKeys: 1, clock });
    disposables.push(limiter);
    expect(limiter.consume("ip1").limited).toBe(false); // 占满两个窗口各自的唯一键位
    const second = limiter.consume("ip2");
    expect(second).toEqual({ limited: true, capacityExceeded: true });
    // 拒绝发生在成对注册之前:任一个窗口都没插半边
    expect(limiter.keyCount()).toEqual({ hour: 1, day: 1 });
  });
});

describe("LoginRateLimiter 委托到通用原语(P6 §19:不留第二份实现)", () => {
  it("P6-LIM-13 语义与窗口仍与 SEC-1 一致:只计失败、成功清零", () => {
    const { clock, advance } = fakeClock();
    const limiter = new LoginRateLimiter({ clock, sweepIntervalMs: 3_600_000 });
    disposables.push(limiter);

    for (let i = 0; i < 4; i += 1) limiter.registerFailure("ip");
    expect(limiter.check("ip")).toEqual({ blocked: false });
    limiter.registerFailure("ip");
    expect(limiter.check("ip")).toEqual({
      blocked: true,
      retryAfterSeconds: AUTH_LOGIN_WINDOW_MS / 1000,
    });
    limiter.reset("ip");
    expect(limiter.check("ip")).toEqual({ blocked: false });
    advance(AUTH_LOGIN_WINDOW_MS);
    expect(limiter.check("ip")).toEqual({ blocked: false });
  });
});
