/**
 * 进程内 fixed-window 限流原语(V1.3 P6 §19)。
 *
 * 登录失败、匿名身份新建、消息提交频率三个入口共用这一份实现:各自的差异只有
 * 「窗口长度 / 上限 / 键」,而计数、窗口过期重新起算、按插入序淘汰、周期 sweep
 * 这套语义必须逐字一致 —— 复制两份就会有两份漂移。
 *
 * 状态只在内存(§13:不进数据库),因此限额随进程重启清零(§77)。
 */
export interface RateLimitClock {
  /** unix 毫秒;测试注入可推进的假时钟 */
  now(): number;
}

export type RateLimitDecision =
  | { limited: false }
  | { limited: true; retryAfterSeconds: number };

export interface FixedWindowRateLimiterOptions {
  /** 窗口长度(ms)*/
  windowMs: number;
  /** 窗口内允许的计数上限 */
  max: number;
  /** 测试接缝:假时钟;生产不传 */
  clock?: RateLimitClock;
  sweepIntervalMs?: number;
  /** 键数量上限:超限按插入序淘汰最旧键,防止攻击者用海量键撑爆内存 */
  maxKeys?: number;
}

interface Bucket {
  count: number;
  /** 窗口起点 = 该窗口内第一次计数时刻(fixed window) */
  windowStart: number;
}

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_MAX_KEYS = 10_000;

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windowMs: number;
  private readonly max: number;
  private readonly clock: RateLimitClock;
  private readonly maxKeys: number;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(options: FixedWindowRateLimiterOptions) {
    this.windowMs = options.windowMs;
    this.max = options.max;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    this.sweepTimer = setInterval(
      () => this.sweep(),
      options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
    );
    // 只有定时器在跑就不阻止进程退出(§106)
    this.sweepTimer.unref();
  }

  /** 只读判定:本次请求会不会被拒(不计数) */
  peek(key: string): RateLimitDecision {
    const bucket = this.buckets.get(key);
    if (bucket === undefined) return { limited: false };
    const elapsed = this.clock.now() - bucket.windowStart;
    if (elapsed >= this.windowMs) return { limited: false };
    if (bucket.count < this.max) return { limited: false };
    return {
      limited: true,
      retryAfterSeconds: Math.max(1, Math.ceil((this.windowMs - elapsed) / 1000)),
    };
  }

  /**
   * 记录一次计数并给出判定:已达上限则**不计数**直接拒,
   * 否则计数 +1 放行 —— 被拒的请求不该把窗口继续往后推。
   */
  register(key: string): RateLimitDecision {
    const decision = this.peek(key);
    if (decision.limited) return decision;
    const now = this.clock.now();
    const existing = this.buckets.get(key);
    if (existing !== undefined && now - existing.windowStart < this.windowMs) {
      existing.count += 1;
      return { limited: false };
    }
    this.evictOldestForInsert();
    this.buckets.set(key, { count: 1, windowStart: now });
    return { limited: false };
  }

  /** 主动清零(登录成功后不再背失败账) */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** 删除窗口已过期的键(§20/§106);活跃窗口保留 */
  sweep(): void {
    const now = this.clock.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.windowMs) {
        this.buckets.delete(key);
      }
    }
  }

  /** 断言用:当前键数量(清理与上限测试唯一可观测面) */
  keyCount(): number {
    return this.buckets.size;
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
