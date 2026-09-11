/**
 * SEC-1 服务端鉴权类型(docs/SEC1_AUTH_DESIGN.md §十二)+ V1.3 多用户身份(V13A_MULTIUSER_DESIGN.md §4)。
 */

/** V1.3:User.type(DDL CHECK:ANONYMOUS / REGISTERED / ADMIN) */
export type UserType = "ANONYMOUS" | "REGISTERED" | "ADMIN";

/** V1.3:User.status(DDL CHECK:ACTIVE / DISABLED) */
export type UserStatus = "ACTIVE" | "DISABLED";

/**
 * 单请求身份上下文(V1.3 §4):B3 起 ownership 校验的唯一可信来源。
 * 只允许服务端中间件写入;Controller/Service 不得从 body/query/header 建立身份。
 */
export interface AuthContext {
  userId: string;
  userType: UserType;
  /** DB Session 的 Session.id;COMPAT 兼容模式为 null */
  sessionId: string | null;
  /** Session 过期时间;COMPAT 兼容模式为 null */
  expiresAt: Date | null;
}

declare global {
  namespace Express {
    interface Request {
      /** requireAuth(DB Session)或 COMPAT 注入;公开端点(/api/auth/*、/api/health)上缺省 */
      auth?: AuthContext;
    }
  }
}

/** 共享密码校验的构造参数(V1.3-B2 起 Session DB-backed,本类不再持有 secret) */
export interface AuthServiceOptions {
  password: string;
}

/**
 * app.ts 装配用鉴权依赖;null = AUTH_ENABLED=false(不挂 requireAuth,统一注入 COMPAT 身份)。
 * password 由 env refine 保证 enabled 时必有。
 */
export interface AuthDeps {
  enabled: boolean;
  password: string;
  /** V1.3 §15:ANONYMOUS(及 V1.4 前的 REGISTERED)Session TTL 秒 */
  ttlAnonymousSeconds: number;
  /** V1.3 §15:ADMIN Session TTL 秒(AUTH_SESSION_TTL_SECONDS 语义已改为 ADMIN TTL) */
  ttlAdminSeconds: number;
  /** V1.3 §13:lastSeenAt 距 now 超过该间隔才写库续期并重发 Set-Cookie */
  touchIntervalSeconds: number;
  /** null = dev 默认白名单;非 null = 已规范化 origin 列表(§7.2) */
  allowedOrigins: string[] | null;
  trustProxy: boolean;
  /** §六:production 恒 Secure(fail-closed);dev/test 按 req.secure */
  cookieSecureAlways: boolean;
}
