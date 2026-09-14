import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";

export interface Argon2CapacityLease {
  release(): void;
}

/**
 * 进程内 Argon2 并发闸门:只做 fail-fast admission,不排队、不持有请求等待者。
 * 状态属于一个 createApp/runtime,由装配层创建,避免多个测试 app 共享可变单例。
 */
export class Argon2CapacityGate {
  private readonly maxConcurrent: number;
  private active = 0;

  constructor(maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16) {
      throw new RangeError("Argon2 max concurrency must be an integer from 1 to 16");
    }
    this.maxConcurrent = maxConcurrent;
  }

  tryAcquire(): Argon2CapacityLease | null {
    if (this.active >= this.maxConcurrent) {
      return null;
    }
    this.active += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
      },
    };
  }

  acquire(): Argon2CapacityLease {
    const lease = this.tryAcquire();
    if (lease === null) {
      throw new AppError(
        ErrorCodes.AUTH_CRYPTO_CAPACITY_EXCEEDED,
        "Argon2 capacity exceeded",
      );
    }
    return lease;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const lease = this.acquire();
    try {
      return await operation();
    } finally {
      lease.release();
    }
  }

  activeCount(): number {
    return this.active;
  }

  maxConcurrency(): number {
    return this.maxConcurrent;
  }
}
