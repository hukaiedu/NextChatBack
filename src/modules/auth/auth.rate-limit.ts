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
  /**
   * V1.4 U2 §11:Registered 登录要求「同一个 class 的独立实例」而不是第二套限流实现,
   * 因此窗口与上限可覆盖。省略 = ADMIN 登录的既有常量,逐项不变。
   */
  windowMs?: number;
  max?: number;
}

export type LoginRateLimitStatus =
  | { blocked: false }
  | { blocked: true; retryAfterSeconds: number }
  /**
   * 限流器自身已满容量(maxKeys 耗尽且 sweep 过期键后仍满)且这是**新** IP 的第一次尝试。
   * 刻意与「本 IP 失败次数超限」分开:前者是服务容量 → 503 SERVICE_BUSY,
   * 后者才是该键自己的限速 → 429 AUTH_RATE_LIMITED(design §33)。
   */
  | { blocked: true; capacityExceeded: true };

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
      windowMs: options.windowMs ?? AUTH_LOGIN_WINDOW_MS,
      max: options.max ?? AUTH_LOGIN_MAX_ATTEMPTS,
      clock: options.clock,
      sweepIntervalMs: options.sweepIntervalMs,
      maxKeys: options.maxKeys,
    });
  }

  /**
   * V1.4 U2 §33 fail-closed 修复。
   *
   * 改前只问 `peek()`:而 peek 对**未知键恒返回 `{limited:false}`**(容量分支只在
   * `register()` 的新键路径产生)⇒ 键表被灌满之后,每个新 IP 都能直接放行到口令校验,
   * 限流被整体绕过,而且每次请求还白付一次 Argon2id 成本。
   * 现在补一次 `hasCapacity()`:已存在的键恒 true(不影响正在计数的 IP),
   * 新键在满容量时 capacityExceeded ⇒ 503,且**在任何 verify 之前**(§79 CPU 保护)。
   */
  check(key: string): LoginRateLimitStatus {
    const decision = this.limiter.peek(key);
    if (decision.limited) {
      // peek 不产生容量分支;这一 in-check 只是类型收窄,与 AnonymousIpRateLimiter 同一写法
      if ("capacityExceeded" in decision) {
        return { blocked: true, retryAfterSeconds: 1 };
      }
      return { blocked: true, retryAfterSeconds: decision.retryAfterSeconds };
    }
    if (!this.limiter.hasCapacity(key)) {
      return { blocked: true, capacityExceeded: true };
    }
    return { blocked: false };
  }

  /**
   * 记一次失败。刻意不看返回值:满容量时新键根本不会被建立,而这一点已经由
   * `check()` 的 capacityExceeded 分支在**请求入口**拦住(不会走到 verify),
   * 这里再判一次只是把同一个容量事实重复表达成 429 之外的第二种码。
   */
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
