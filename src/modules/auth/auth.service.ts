import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type {
  AuthServiceOptions,
  SessionTokenPayload,
  SignedSession,
  VerifyResult,
} from "./auth.types.js";

/** 超长 DoS 防线(§5.3) */
const TOKEN_MAX_LENGTH = 1024;
/** SEC-IMPL-02:严格 base64url 字符集,解码合法性不依赖 Buffer 宽松行为 */
const TOKEN_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const HMAC_SHA256_BYTE_LENGTH = 32;
const SESSION_VERSION = 1;
const SID_PATTERN = /^[0-9a-f]{32}$/;

function unixNowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function hmacPayload(payloadB64: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payloadB64, "ascii").digest();
}

function isSessionPayload(value: unknown): value is SessionTokenPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.v !== SESSION_VERSION) return false;
  const { iat, exp, sid } = record;
  if (typeof iat !== "number" || !Number.isSafeInteger(iat)) return false;
  if (typeof exp !== "number" || !Number.isSafeInteger(exp)) return false;
  if (typeof sid !== "string" || !SID_PATTERN.test(sid)) return false;
  return exp > iat;
}

/**
 * 无状态 HMAC Session 的签发/验证与恒定时间密码比较(§5)。
 * 不持有任何存储;全局吊销 = 轮换 secret 重启。
 */
export class AuthService {
  private readonly passwordHash: Buffer;
  private readonly secret: string;
  private readonly ttlSeconds: number;

  constructor(options: AuthServiceOptions) {
    this.passwordHash = createHash("sha256").update(options.password, "utf8").digest();
    this.secret = options.secret;
    this.ttlSeconds = options.ttlSeconds;
  }

  sign(nowSeconds: number = unixNowSeconds()): SignedSession {
    const payload: SessionTokenPayload = {
      v: SESSION_VERSION,
      iat: nowSeconds,
      exp: nowSeconds + this.ttlSeconds,
      sid: randomBytes(16).toString("hex"),
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = hmacPayload(payloadB64, this.secret);
    return {
      token: `${payloadB64}.${signature.toString("base64url")}`,
      expiresAt: payload.exp,
    };
  }

  /** §5.3 验证流程;无效一律返回 { valid:false },不区分原因(对外统一 401) */
  verify(token: string | undefined, nowSeconds: number = unixNowSeconds()): VerifyResult {
    if (typeof token !== "string" || token.length === 0 || token.length > TOKEN_MAX_LENGTH) {
      return { valid: false };
    }
    const parts = token.split(".");
    if (parts.length !== 2) {
      return { valid: false };
    }
    const payloadB64 = parts[0];
    const signatureB64 = parts[1];
    if (payloadB64 === undefined || signatureB64 === undefined) {
      return { valid: false };
    }
    if (!TOKEN_SEGMENT_PATTERN.test(payloadB64) || !TOKEN_SEGMENT_PATTERN.test(signatureB64)) {
      return { valid: false };
    }
    const signature = Buffer.from(signatureB64, "base64url");
    if (signature.length !== HMAC_SHA256_BYTE_LENGTH) {
      return { valid: false };
    }
    const expected = hmacPayload(payloadB64, this.secret);
    if (!timingSafeEqual(signature, expected)) {
      return { valid: false };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    } catch {
      return { valid: false };
    }
    if (!isSessionPayload(payload)) {
      return { valid: false };
    }
    if (payload.exp <= nowSeconds) {
      return { valid: false };
    }
    return { valid: true, expiresAt: payload.exp };
  }

  /** §5.4:双侧 sha256 归一化长度后 timingSafeEqual;原样字节,不 trim */
  verifyPassword(candidate: string): boolean {
    const suppliedHash = createHash("sha256").update(candidate, "utf8").digest();
    return timingSafeEqual(this.passwordHash, suppliedHash);
  }
}
