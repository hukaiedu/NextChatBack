import {
  AUTH_LOGIN_MAX_ATTEMPTS,
  AUTH_LOGIN_WINDOW_MS,
} from "../../config/constants.js";
import { FixedWindowRateLimiter } from "../../common/rate-limit/rate-limiter.js";
import type { RateLimitClock } from "../../common/rate-limit/rate-limiter.js";

export type { RateLimitClock };

export interface LoginRateLimiterOptions {
  clock?: RateLimitClock;
  sweepIntervalMs?: number;
  maxKeys?: number;
}

export type LoginRateLimitStatus =
  | { blocked: false }
  | { blocked: true; retryAfterSeconds: number };

/**
 * 登录限流:仅 login;进程内 fixed window,无 Redis(§十)。
 * 键 = req.ip(trust proxy=false 时即 socket remoteAddress)。
 * 只计失败(400 不计数),成功清零;窗口过期后下一次失败重新起算。
 *
 * V1.3 P6 §19:窗口/淘汰/sweep 的实现已收进 FixedWindowRateLimiter —— 匿名身份新建与
 * 消息提交频率要用同一套语义,这里只保留 login 特有的「只计失败 + 成功清零」。
 */
export class LoginRateLimiter {
  private readonly limiter: FixedWindowRateLimiter;

  constructor(options: LoginRateLimiterOptions = {}) {
    this.limiter = new FixedWindowRateLimiter({
      windowMs: AUTH_LOGIN_WINDOW_MS,
      max: AUTH_LOGIN_MAX_ATTEMPTS,
      clock: options.clock,
      sweepIntervalMs: options.sweepIntervalMs,
      maxKeys: options.maxKeys,
    });
  }

  check(key: string): LoginRateLimitStatus {
    const decision = this.limiter.peek(key);
    if (!decision.limited) {
      return { blocked: false };
    }
    // peek 不会返回容量分支(容量只在 register 的新键路径产生),这里只是类型收窄
    if ("capacityExceeded" in decision) {
      return { blocked: true, retryAfterSeconds: 1 };
    }
    return { blocked: true, retryAfterSeconds: decision.retryAfterSeconds };
  }

  registerFailure(key: string): void {
    this.limiter.register(key);
  }

  /** 登录成功后清零 */
  reset(key: string): void {
    this.limiter.reset(key);
  }

  sweep(): void {
    this.limiter.sweep();
  }

  dispose(): void {
    this.limiter.dispose();
  }
}
