import { describe, expect, it } from "vitest";

import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { AppError } from "../../src/common/errors/app-error.js";
import { Argon2CapacityGate } from "../../src/modules/auth/auth.argon2-capacity.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Argon2CapacityGate(D1C)", () => {
  it("AGC-01/04 max=2 立即拒绝第三个 operation,不排队", async () => {
    const gate = new Argon2CapacityGate(2);
    const first = deferred<void>();
    const second = deferred<void>();
    const firstRun = gate.run(() => first.promise);
    const secondRun = gate.run(() => second.promise);

    expect(gate.activeCount()).toBe(2);
    expect(gate.tryAcquire()).toBeNull();
    expect(gate.activeCount()).toBe(2);

    first.resolve();
    second.resolve();
    await Promise.all([firstRun, secondRun]);
    expect(gate.activeCount()).toBe(0);
  });

  it("AGC-02 resolve 后释放 permit,后续 operation 可进入", async () => {
    const gate = new Argon2CapacityGate(1);
    await gate.run(async () => undefined);
    expect(gate.activeCount()).toBe(0);
    const lease = gate.tryAcquire();
    expect(lease).not.toBeNull();
    lease!.release();
    expect(gate.activeCount()).toBe(0);
  });

  it("AGC-03 underlying crypto throw 仍释放 permit", async () => {
    const gate = new Argon2CapacityGate(1);
    await expect(gate.run(async () => { throw new Error("crypto failed"); })).rejects.toThrow(
      "crypto failed",
    );
    expect(gate.activeCount()).toBe(0);
    await expect(gate.run(async () => "next")).resolves.toBe("next");
  });

  it("capacity reject 是内部 AUTH_CRYPTO_CAPACITY_EXCEEDED,不泄漏 active count", () => {
    const gate = new Argon2CapacityGate(1);
    const lease = gate.tryAcquire();
    expect(() => gate.acquire()).toThrow(AppError);
    try {
      gate.acquire();
    } catch (err) {
      expect((err as AppError).code).toBe(ErrorCodes.AUTH_CRYPTO_CAPACITY_EXCEEDED);
    }
    expect(gate.activeCount()).toBe(1);
    lease!.release();
  });

  it("double release 幂等且 active 不会变负", () => {
    const gate = new Argon2CapacityGate(1);
    const lease = gate.tryAcquire()!;
    lease.release();
    lease.release();
    expect(gate.activeCount()).toBe(0);
  });

  it("非法 max concurrency fail-fast", () => {
    for (const value of [0, 17, 1.5, Number.NaN]) {
      expect(() => new Argon2CapacityGate(value)).toThrow(RangeError);
    }
  });
});
