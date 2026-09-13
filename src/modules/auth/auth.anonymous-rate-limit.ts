import { FixedWindowRateLimiter } from "../../common/rate-limit/rate-limiter.js";
import type {
  RateLimitClock,
  RateLimitDecision,
} from "../../common/rate-limit/rate-limiter.js";
import {
  ANONYMOUS_IP_DAY_WINDOW_MS,
  ANONYMOUS_IP_HOUR_WINDOW_MS,
} from "../../config/constants.js";

export interface AnonymousIpRateLimiterOptions {
  /** 小时窗口内允许的创建尝试数(§18) */
  perHour: number;
  /** 天窗口内允许的创建尝试数 */
  perDay: number;
  clock?: RateLimitClock;
  sweepIntervalMs?: number;
  maxKeys?: number;
}

/**
 * 匿名身份新建限流(P6 §14/§18):同一 IP 的「小时 + 天」双窗口。
 *
 * 保护的是 **真的会创建新 User + Session** 的那一次调用(Abuse-01:清 Cookie 反复刷匿名身份)。
 * 有效 Cookie 的幂等复用与 DISABLED 分支都不消耗额度,所以调用方必须先解析既有 Session
 * 再问额度(§21)。两个窗口共用同一份 fixed-window 实现,不复制第二套限流代码(§19)。
 *
 * 键 = req.ip:只由 Express 的 trust proxy 规则推导(§15),绝不自己读 X-Forwarded-For。
 * 键本身永不进日志(§17)。
 */
export class AnonymousIpRateLimiter {
  private readonly hour: FixedWindowRateLimiter;
  private readonly day: FixedWindowRateLimiter;

  constructor(options: AnonymousIpRateLimiterOptions) {
    const shared = {
      clock: options.clock,
      sweepIntervalMs: options.sweepIntervalMs,
      maxKeys: options.maxKeys,
    };
    this.hour = new FixedWindowRateLimiter({
      ...shared,
      windowMs: ANONYMOUS_IP_HOUR_WINDOW_MS,
      max: options.perHour,
    });
    this.day = new FixedWindowRateLimiter({
      ...shared,
      windowMs: ANONYMOUS_IP_DAY_WINDOW_MS,
      max: options.perDay,
    });
  }

  /**
   * 判定并记录一次创建尝试。两个窗口都还有余量才计数 —— 被拒的请求不该把另一个窗口也撑满。
   *
   * 原子性(§22):peek 与 register 之间没有任何 await,单线程事件循环下这一对就是原子的,
   * 所以 50 个并发 fresh 请求不可能全部越过同一时刻的计数。
   *
   * P10 §50:容量是双窗口共享的准入前提 —— 任一个窗口的 map 已满(先 sweep 过期键仍满)
   * 就返回 capacityExceeded 且**两个窗口都不计数**,绝不半边插入。这是 fail-closed:
   * 满容量时不得新建 Anonymous User(§50),也不为陌生 IP 建立/淘汰任何 bucket(§59)。
   */
  consume(ip: string): RateLimitDecision {
    const hourDecision = this.hour.peek(ip);
    const dayDecision = this.day.peek(ip);
    if (hourDecision.limited || dayDecision.limited) {
      // 两个窗口都在计时:等得久的那个才是真正可用的最早时刻
      // peek 不产生容量分支;in-check 只是让两种 limited 变体都能通过类型收窄
      const retryAfterSeconds = Math.max(
        hourDecision.limited && "retryAfterSeconds" in hourDecision
          ? hourDecision.retryAfterSeconds
          : 0,
        dayDecision.limited && "retryAfterSeconds" in dayDecision
          ? dayDecision.retryAfterSeconds
          : 0,
      );
      return { limited: true, retryAfterSeconds };
    }
    if (!this.hour.hasCapacity(ip) || !this.day.hasCapacity(ip)) {
      return { limited: true, capacityExceeded: true };
    }
    this.hour.register(ip);
    this.day.register(ip);
    return { limited: false };
  }

  sweep(): void {
    this.hour.sweep();
    this.day.sweep();
  }

  /** 断言用:两个窗口各自的当前键数量(§20 内存清理验收) */
  keyCount(): { hour: number; day: number } {
    return { hour: this.hour.keyCount(), day: this.day.keyCount() };
  }

  dispose(): void {
    this.hour.dispose();
    this.day.dispose();
  }
}
