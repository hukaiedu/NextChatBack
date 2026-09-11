import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AuthService } from "../../src/modules/auth/auth.service.js";

const PASSWORD = "correct-horse-battery";

function createService(password = PASSWORD): AuthService {
  return new AuthService({ password });
}

describe("AuthService verifyPassword(§5.4 恒定时间比较)", () => {
  it("正确密码 → true;错误密码 → false", () => {
    const service = createService();

    expect(service.verifyPassword(PASSWORD)).toBe(true);
    expect(service.verifyPassword("wrong-password")).toBe(false);
    expect(service.verifyPassword("")).toBe(false);
  });

  it("长度归一化:任意长度候选都不抛错,长度差异不影响比较安全性", () => {
    const service = createService();

    expect(() => service.verifyPassword("a")).not.toThrow();
    expect(service.verifyPassword("a".repeat(200))).toBe(false);
    // sha256 后双方恒 32 字节,长度不等也能安全比较
    expect(createHash("sha256").update("a").digest().length).toBe(32);
  });

  it("密码原样字节比较,不 trim", () => {
    const service = createService("  spaced pass 12 ");

    expect(service.verifyPassword("  spaced pass 12 ")).toBe(true);
    expect(service.verifyPassword("spaced pass 12")).toBe(false);
  });

  it("Unicode 密码原样处理", () => {
    const service = createService(" 密码十二个字以上 ");

    expect(service.verifyPassword(" 密码十二个字以上 ")).toBe(true);
    expect(service.verifyPassword("密码十二个字以上")).toBe(false);
  });
});
