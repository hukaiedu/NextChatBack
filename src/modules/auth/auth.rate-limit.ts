import {
  AUTH_LOGIN_MAX_ATTEMPTS,
  AUTH_LOGIN_WINDOW_MS,
} from "../../config/constants.js";

export interface RateLimitClock {
  /** unix 毫秒;测试注入固定时钟 */
  now(): number;
}

export interface LoginRateLimiterOptions {
  clock?: RateLimitClock;
  sweepIntervalMs?: number;
  maxKeys?: number;
}

export type LoginRateLimitStatus =
  | { blocked: false }
  | { blocked: true; retryAfterSeconds: number };

interface Bucket {
  count: number;
  /** 窗口起点 = 该窗口内第一次失败时刻(fixed window) */
  windowStart: number;
}

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_MAX_KEYS = 10_000;

/**
 * 登录限流:仅 login;进程内 fixed window,无 Redis(§十)。
 * 键 = req.ip(trust proxy=false 时即 socket remoteAddress)。
 * 只计失败(400 不计数),成功清零;窗口过期后下一次失败重新起算。
 */
export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly clock: RateLimitClock;
  private readonly sweepIntervalMs: number;
  private readonly maxKeys: number;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(options: LoginRateLimiterOptions = {}) {
    this.clock = options.clock ?? { now: () => Date.now() };
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    this.sweepTimer = setInterval(() => {
      this.sweep();
    }, this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  check(key: string): LoginRateLimitStatus {
    const bucket = this.buckets.get(key);
    if (!bucket) return { blocked: false };
    const elapsed = this.clock.now() - bucket.windowStart;
    if (elapsed >= AUTH_LOGIN_WINDOW_MS) return { blocked: false };
    if (bucket.count < AUTH_LOGIN_MAX_ATTEMPTS) return { blocked: false };
    return {
      blocked: true,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((AUTH_LOGIN_WINDOW_MS - elapsed) / 1000),
      ),
    };
  }

  registerFailure(key: string): void {
    const now = this.clock.now();
    const existing = this.buckets.get(key);
    if (existing && now - existing.windowStart < AUTH_LOGIN_WINDOW_MS) {
      existing.count += 1;
      return;
    }
    this.evictOldestForInsert();
    this.buckets.set(key, { count: 1, windowStart: now });
  }

  /** 登录成功后清零 */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  sweep(): void {
    const now = this.clock.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= AUTH_LOGIN_WINDOW_MS) {
        this.buckets.delete(key);
      }
    }
  }

  dispose(): void {
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /** 超过键上限时按插入序淘汰最旧键,保证新键可插入 */
  private evictOldestForInsert(): void {
    while (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) break;
      this.buckets.delete(oldest.value);
    }
  }
}
