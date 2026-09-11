import { createHash, timingSafeEqual } from "node:crypto";

import type { AuthServiceOptions } from "./auth.types.js";

/**
 * 共享密码校验(§5.4)。
 * V1.3-B2 起 Session 改为 DB-backed(opaque token + tokenHash,见 auth.session.service.ts),
 * 原无状态 HMAC 签发/验证已退役,本类只保留恒定时间密码比较职责。
 */
export class AuthService {
  private readonly passwordHash: Buffer;

  constructor(options: AuthServiceOptions) {
    this.passwordHash = createHash("sha256").update(options.password, "utf8").digest();
  }

  /** §5.4:双侧 sha256 归一化长度后 timingSafeEqual;原样字节,不 trim */
  verifyPassword(candidate: string): boolean {
    const suppliedHash = createHash("sha256").update(candidate, "utf8").digest();
    return timingSafeEqual(this.passwordHash, suppliedHash);
  }
}
