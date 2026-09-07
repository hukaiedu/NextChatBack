/**
 * SEC-1 服务端鉴权类型(docs/SEC1_AUTH_DESIGN.md §十二)。
 */

/** Session token payload(紧凑 JSON,§5.2;校验规则见 auth.service.verify) */
export interface SessionTokenPayload {
  v: 1;
  iat: number;
  exp: number;
  sid: string;
}

/** verify 结果:有效时带过期时间(unix 秒) */
export type VerifyResult = { valid: true; expiresAt: number } | { valid: false };

/** sign 产物 */
export interface SignedSession {
  token: string;
  /** unix 秒,等于 payload.exp */
  expiresAt: number;
}

export interface AuthServiceOptions {
  password: string;
  secret: string;
  ttlSeconds: number;
}

/**
 * app.ts 装配用鉴权依赖;null = AUTH_ENABLED=false(不挂 requireAuth)。
 * password/secret 由 env refine 保证 enabled 时必有。
 */
export interface AuthDeps {
  enabled: boolean;
  password: string;
  secret: string;
  ttlSeconds: number;
  /** null = dev 默认白名单;非 null = 已规范化 origin 列表(§7.2) */
  allowedOrigins: string[] | null;
  trustProxy: boolean;
  /** §六:production 恒 Secure(fail-closed);dev/test 按 req.secure */
  cookieSecureAlways: boolean;
}
