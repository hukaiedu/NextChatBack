import { createHash, createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AuthService } from "../../src/modules/auth/auth.service.js";

const SECRET = "unit-test-secret-0123456789abcdef0123";
const PASSWORD = "correct-horse-battery";

function createService(ttlSeconds = 3600): AuthService {
  return new AuthService({ password: PASSWORD, secret: SECRET, ttlSeconds });
}

/** 用指定 payload/secret 构造合法签名 token(伪造 v/sid/iat/exp 等场景用) */
function craftToken(
  payload: Record<string, unknown>,
  secret: string = SECRET,
): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadB64, "ascii").digest();
  return `${payloadB64}.${signature.toString("base64url")}`;
}

function decodePayload(token: string): Record<string, unknown> {
  const [payloadB64] = token.split(".");
  return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
}

describe("AuthService sign/verify roundtrip", () => {
  it("sign → verify 有效,expiresAt = iat + ttl", () => {
    const service = createService(60);
    const signed = service.sign(1000);

    expect(signed.expiresAt).toBe(1060);
    expect(service.verify(signed.token, 1000)).toEqual({
      valid: true,
      expiresAt: 1060,
    });
  });

  it("verify 无 now 参数时用当前时间(真实时钟 roundtrip)", () => {
    const service = createService(60);
    const signed = service.sign();

    const result = service.verify(signed.token);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.expiresAt).toBe(signed.expiresAt);
    }
  });

  it("每次 sign 的 sid 不同(token 唯一化)", () => {
    const service = createService();
    const a = decodePayload(service.sign(1000).token);
    const b = decodePayload(service.sign(1000).token);

    expect(a.sid).not.toBe(b.sid);
  });
});

describe("AuthService verify 拒绝路径", () => {
  it("篡改签名段 1 字符 → invalid", () => {
    const service = createService();
    const token = service.sign(1000).token;
    const [payloadB64, sigB64] = token.split(".");
    const lastChar = sigB64.at(-1)!;
    const flipped = lastChar === "A" ? "B" : "A";
    const tampered = `${payloadB64}.${sigB64.slice(0, -1)}${flipped}`;

    expect(service.verify(tampered, 1000).valid).toBe(false);
  });

  it("篡改 payload 段(签名不再匹配)→ invalid", () => {
    const service = createService();
    const token = service.sign(1000).token;
    const [payloadB64, sigB64] = token.split(".");
    // 原位替换一个合法 base64url 字符,保持签名段不变
    const flipped = payloadB64.endsWith("A") ? "B" : "A";
    const tamperedPayload = payloadB64.slice(0, -1) + flipped;

    expect(service.verify(`${tamperedPayload}.${sigB64}`, 1000).valid).toBe(false);
  });

  it("过期(exp 已过)→ invalid;边界 exp === now 亦 invalid", () => {
    const service = createService(60);
    const token = service.sign(1000).token;

    expect(service.verify(token, 1001).valid).toBe(true);
    expect(service.verify(token, 1060).valid).toBe(false);
    expect(service.verify(token, 1061).valid).toBe(false);
  });

  it("无 cookie / 空串 / undefined → invalid", () => {
    const service = createService();

    expect(service.verify(undefined, 1000).valid).toBe(false);
    expect(service.verify("", 1000).valid).toBe(false);
  });

  it("无点号 / 三段 / 超长 >1024 → invalid", () => {
    const service = createService();

    expect(service.verify("notokenatall", 1000).valid).toBe(false);
    expect(service.verify("a.b.c", 1000).valid).toBe(false);
    expect(service.verify("a".repeat(1025), 1000).valid).toBe(false);
  });

  it("v 不匹配 → invalid", () => {
    const service = createService();
    const token = craftToken({ v: 2, iat: 1000, exp: 1060, sid: "a".repeat(32) });

    expect(service.verify(token, 1000).valid).toBe(false);
  });

  it("iat / exp 非有限安全整数 → invalid", () => {
    const service = createService();

    expect(
      service.verify(craftToken({ v: 1, iat: 1.5, exp: 1060, sid: "a".repeat(32) }), 1000).valid,
    ).toBe(false);
    expect(
      service.verify(craftToken({ v: 1, iat: 1000, exp: "1060", sid: "a".repeat(32) }), 1000).valid,
    ).toBe(false);
  });

  it("sid 非 32 位 hex → invalid", () => {
    const service = createService();

    expect(
      service.verify(craftToken({ v: 1, iat: 1000, exp: 1060, sid: "short" }), 1000).valid,
    ).toBe(false);
    expect(
      service.verify(craftToken({ v: 1, iat: 1000, exp: 1060, sid: "A".repeat(32) }), 1000).valid,
    ).toBe(false);
  });

  it("exp <= iat → invalid", () => {
    const service = createService();

    expect(
      service.verify(craftToken({ v: 1, iat: 1000, exp: 1000, sid: "a".repeat(32) }), 1000).valid,
    ).toBe(false);
    expect(
      service.verify(craftToken({ v: 1, iat: 1000, exp: 999, sid: "a".repeat(32) }), 1000).valid,
    ).toBe(false);
  });

  it("payload 非 JSON → invalid", () => {
    const service = createService();
    const payloadB64 = Buffer.from("{not-json", "utf8").toString("base64url");
    const signature = createHmac("sha256", SECRET).update(payloadB64, "ascii").digest();
    const token = `${payloadB64}.${signature.toString("base64url")}`;

    expect(service.verify(token, 1000).valid).toBe(false);
  });
});

describe("AuthService verify 严格 base64url(SEC-IMPL-02)", () => {
  it("sig 段插入 = / + / % / 空格 → invalid(Buffer 宽松解码不得放行)", () => {
    const service = createService();
    const [payloadB64, sigB64] = service.sign(1000).token.split(".");

    for (const injected of ["=", "+", "%", " "]) {
      const token = `${payloadB64}.${sigB64}${injected}`;
      expect(service.verify(token, 1000).valid, `injected: ${JSON.stringify(injected)}`).toBe(
        false,
      );
    }
  });

  it("payload 段含非 base64url 字符(+ / %)→ invalid", () => {
    const service = createService();
    const [payloadB64, sigB64] = service.sign(1000).token.split(".");

    for (const injected of ["+", "%"]) {
      const token = `${payloadB64}${injected}.${sigB64}`;
      expect(service.verify(token, 1000).valid, `injected: ${JSON.stringify(injected)}`).toBe(
        false,
      );
    }
  });

  it("sig 段解码长度 ≠ 32 → invalid", () => {
    const service = createService();
    const [payloadB64, sigB64] = service.sign(1000).token.split(".");
    // 40 个合法 base64url 字符解码为 30 字节,长度校验在 timingSafeEqual 之前拦截
    const shortSig = sigB64.slice(0, 40);

    expect(service.verify(`${payloadB64}.${shortSig}`, 1000).valid).toBe(false);
  });

  it("错误 secret 签发的 token → invalid", () => {
    const service = createService();
    const token = craftToken({ v: 1, iat: 1000, exp: 1060, sid: "a".repeat(32) }, "wrong-secret");

    expect(service.verify(token, 1000).valid).toBe(false);
  });
});

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
    const service = new AuthService({
      password: "  spaced pass 12 ",
      secret: SECRET,
      ttlSeconds: 60,
    });

    expect(service.verifyPassword("  spaced pass 12 ")).toBe(true);
    expect(service.verifyPassword("spaced pass 12")).toBe(false);
  });

  it("Unicode 密码原样处理", () => {
    const service = new AuthService({
      password: " 密码十二个字以上 ",
      secret: SECRET,
      ttlSeconds: 60,
    });

    expect(service.verifyPassword(" 密码十二个字以上 ")).toBe(true);
    expect(service.verifyPassword("密码十二个字以上")).toBe(false);
  });
});
