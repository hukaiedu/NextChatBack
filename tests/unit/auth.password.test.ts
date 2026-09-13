import { parseOptions } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";

import {
  ARGON2_MEMORY_COST,
  ARGON2_OUTPUT_LEN,
  ARGON2_PARALLELISM,
  ARGON2_TIME_COST,
  DUMMY_PASSWORD_HASH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  hashPassword,
  verifyPassword,
} from "../../src/modules/auth/auth.password.js";

/**
 * V1.4 U2 §93:口令散列契约。
 *
 * 刻意不断言「同一口令两次 hash 相等」—— salt 是随机的,那种断言只会把实现逼成不安全的
 * 固定 salt。要证的是:摘要不含明文、正确口令 verify 通过、错误口令不通过、参数就是冻结的那组。
 */
describe("auth.password(V1.4 U2)", () => {
  const PASSWORD = "Password123!";

  it("HASH-01 摘要不等于明文,且不含明文子串", async () => {
    const hashed = await hashPassword(PASSWORD);
    expect(hashed).not.toBe(PASSWORD);
    expect(hashed).not.toContain(PASSWORD);
    expect(hashed.startsWith("$argon2id$")).toBe(true);
  });

  it("HASH-02/03 正确口令 verify 为 true,错误口令为 false", async () => {
    const hashed = await hashPassword(PASSWORD);
    await expect(verifyPassword(hashed, PASSWORD)).resolves.toBe(true);
    await expect(verifyPassword(hashed, "Password123?")).resolves.toBe(false);
    await expect(verifyPassword(hashed, "")).resolves.toBe(false);
  });

  it("HASH-04 PHC 串自描述算法与参数(日后提参无需数据迁移)", async () => {
    const hashed = await hashPassword(PASSWORD);
    const parsed = parseOptions(hashed);
    expect(parsed.algorithm).toBe(2); // Argon2id
    expect(hashed.split("$")[1]).toBe("argon2id");
  });

  it("HASH-05 落库参数就是 design §6 冻结的那一组,不随依赖默认值漂移", async () => {
    const parsed = parseOptions(await hashPassword(PASSWORD));
    expect({
      memoryCost: parsed.memoryCost,
      timeCost: parsed.timeCost,
      parallelism: parsed.parallelism,
      outputLen: parsed.outputLen,
    }).toEqual({
      memoryCost: ARGON2_MEMORY_COST,
      timeCost: ARGON2_TIME_COST,
      parallelism: ARGON2_PARALLELISM,
      outputLen: ARGON2_OUTPUT_LEN,
    });
    expect(ARGON2_MEMORY_COST).toBe(19_456);
    expect(ARGON2_TIME_COST).toBe(2);
    expect(ARGON2_PARALLELISM).toBe(1);
    expect(ARGON2_OUTPUT_LEN).toBe(32);
  });

  it("HASH-06 请求路径只用 async API:hashPassword 返回 Promise 且结论一致", async () => {
    const pending = hashPassword(PASSWORD);
    expect(typeof pending.then).toBe("function");
    const hashed = await pending;
    await expect(verifyPassword(hashed, PASSWORD)).resolves.toBe(true);
  });

  it("HASH-07 DUMMY 摘要是合法 Argon2id PHC 串、参数与正式一致,且永不被任何口令配对", async () => {
    const parsed = parseOptions(DUMMY_PASSWORD_HASH);
    expect(parsed.algorithm).toBe(2);
    expect(parsed.memoryCost).toBe(ARGON2_MEMORY_COST);
    expect(parsed.timeCost).toBe(ARGON2_TIME_COST);
    expect(parsed.parallelism).toBe(ARGON2_PARALLELISM);
    await expect(verifyPassword(DUMMY_PASSWORD_HASH, "Password123!")).resolves.toBe(false);
    await expect(verifyPassword(DUMMY_PASSWORD_HASH, "")).resolves.toBe(false);
  });

  it("畸形摘要串一律收敛成 false(不给 Public 面多一个可区分的出口)", async () => {
    for (const bad of ["", "not-a-phc-string", "$argon2id$v=19$m=1,t=1,p=1$x$y"]) {
      await expect(verifyPassword(bad, "anything")).resolves.toBe(false);
    }
  });

  it("政策常量边界:8~128(design §6 不做字符类别要求)", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
  });

  it("边界长度口令可正常散列与校验", async () => {
    const min = "a".repeat(PASSWORD_MIN_LENGTH);
    const max = "b".repeat(PASSWORD_MAX_LENGTH);
    for (const value of [min, max]) {
      await expect(verifyPassword(await hashPassword(value), value)).resolves.toBe(true);
    }
  });
});
