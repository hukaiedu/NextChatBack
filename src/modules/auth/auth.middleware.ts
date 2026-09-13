import type { NextFunction, Request, RequestHandler, Response } from "express";

import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import { markAdminErrorSurface } from "../../common/errors/error-exposure.js";
import { AUTH_COOKIE_NAME, COMPAT_USER_ID } from "../../config/constants.js";
import type { Env } from "../../config/env.js";
import type { AuthSessionService } from "./auth.session.service.js";
import type { AuthDeps } from "./auth.types.js";

/** 仅 unsafe method 校验 Origin;GET/HEAD/OPTIONS 放行 */
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** §7.2:未配置 AUTH_ALLOWED_ORIGINS 时的 dev 默认白名单 */
const DEV_DEFAULT_ORIGIN_PATTERN = /^(https?):\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * §7.2 配置侧:逗号分隔 → 去单个尾部 `/` → `input === new URL(input).origin`
 * 逐项校验并保存规范化 origin;未配置 → null(dev 默认白名单)。
 * 带 path/query/hash/credentials/通配 → VALIDATION_ERROR fail-fast。
 */
export function parseAllowedOrigins(
  raw: string | undefined,
  requireHttps: boolean,
): string[] | null {
  if (raw === undefined || raw.trim().length === 0) return null;
  const origins: string[] = [];
  for (const item of raw.split(",")) {
    const candidate = item.trim();
    if (candidate.length === 0 || candidate.includes("*")) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `Invalid AUTH_ALLOWED_ORIGINS entry: ${JSON.stringify(item)}`,
      );
    }
    const withoutTrailingSlash =
      candidate.endsWith("/") && !candidate.endsWith("://")
        ? candidate.slice(0, -1)
        : candidate;
    let origin: string;
    try {
      origin = new URL(withoutTrailingSlash).origin;
    } catch {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `Invalid AUTH_ALLOWED_ORIGINS entry: ${JSON.stringify(item)}`,
      );
    }
    if (origin !== withoutTrailingSlash) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `AUTH_ALLOWED_ORIGINS entry must be a bare origin: ${JSON.stringify(item)}`,
      );
    }
    if (requireHttps && origin.startsWith("http://")) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `AUTH_ALLOWED_ORIGINS must be https-only in production: ${JSON.stringify(item)}`,
      );
    }
    origins.push(origin);
  }
  return origins;
}

/** env → AuthDeps(main.ts 唯一装配入口;AppDeps.auth 类型上允许 null = 关闭鉴权) */
export function buildAuthDeps(env: Env): AuthDeps {
  return {
    enabled: env.AUTH_ENABLED,
    password: env.AUTH_PASSWORD ?? "",
    ttlAnonymousSeconds: env.AUTH_SESSION_TTL_ANONYMOUS_SECONDS,
    ttlRegisteredSeconds: env.AUTH_SESSION_TTL_REGISTERED_SECONDS,
    ttlAdminSeconds: env.AUTH_SESSION_TTL_SECONDS,
    touchIntervalSeconds: env.AUTH_SESSION_TOUCH_INTERVAL_SECONDS,
    allowedOrigins: parseAllowedOrigins(
      env.AUTH_ALLOWED_ORIGINS,
      env.NODE_ENV === "production" && env.AUTH_ENABLED,
    ),
    trustProxy: env.AUTH_TRUST_PROXY,
    cookieSecureAlways: env.NODE_ENV === "production",
  };
}

/**
 * §七:unsafe method 的 Origin 白名单校验(始终挂载,不随 AUTH_ENABLED 关闭)。
 * 无 Origin 头(curl/supertest)→ 放行;解析失败与 `Origin: null` → 403。
 * 禁止任何形式的通配与子串匹配。
 */
export function originCheck(allowedOrigins: string[] | null): RequestHandler {
  const whitelist = allowedOrigins === null ? null : new Set(allowedOrigins);
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!UNSAFE_METHODS.has(req.method)) return next();
    const header = req.headers.origin;
    if (header === undefined) return next();
    let origin: string;
    try {
      origin = new URL(header).origin;
    } catch {
      return next(new AppError(ErrorCodes.AUTH_CSRF_REJECTED, "Origin header rejected"));
    }
    const allowed =
      whitelist === null ? DEV_DEFAULT_ORIGIN_PATTERN.test(origin) : whitelist.has(origin);
    if (!allowed) {
      return next(new AppError(ErrorCodes.AUTH_CSRF_REJECTED, "Origin not allowed"));
    }
    next();
  };
}

/** 手写解析 Cookie 头(§六):同名多条取第一段;解析异常按 cookie 缺失处理 */
export function extractCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * §六:Cookie 属性唯一出处(登录 / 匿名 bootstrap / 滑动续期共用)。
 * production 恒 Secure(fail-closed);dev/test 按 req.secure。
 */
export function setSessionCookie(
  res: Response,
  req: Request,
  auth: AuthDeps,
  rawToken: string,
  maxAgeSeconds: number,
): void {
  res.cookie(AUTH_COOKIE_NAME, rawToken, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: maxAgeSeconds * 1000,
    secure: auth.cookieSecureAlways || req.secure,
  });
}

/** 登出清 Cookie(§六):同名同 Path;不覆盖 Max-Age=0 的既有 204 契约 */
export function clearSessionCookie(res: Response): void {
  res.cookie(AUTH_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
}

/**
 * §12.1 + V1.3 §13:DB Session 认证。
 * valid → 写 req.auth;续期 CAS 胜出 → 同步重发 Set-Cookie(同一 raw token)。
 * 无效 / 过期 / DISABLED → 统一 401 AUTH_REQUIRED;数据库异常按内部错误出口(不伪装成 401)。
 */
export function requireAuth(sessions: AuthSessionService, auth: AuthDeps): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = extractCookie(req.headers.cookie, AUTH_COOKIE_NAME);
    sessions
      .resolve(token, { touch: true })
      .then((resolved) => {
        if (resolved.kind !== "active") {
          return next(
            new AppError(ErrorCodes.AUTH_REQUIRED, "Missing or invalid session cookie"),
          );
        }
        req.auth = resolved.auth;
        if (resolved.renewed) {
          setSessionCookie(res, req, auth, resolved.rawToken, resolved.ttlSeconds);
        }
        next();
      })
      .catch(next);
  };
}

/**
 * V1.3-B3-3 §21:运维 API 的唯一权限判据 = `req.auth.userType === "ADMIN"`。
 *
 * 刻意不看 AUTH_ENABLED,也不看 userId 是否等于 COMPAT:
 * 下面 injectCompatAuth 注入的 type 恒为 ANONYMOUS,所以 `AUTH_ENABLED=false` 的本地
 * 兼容模式访问 Admin 端点同样 403(§22)。反过来,自报 ADMIN_USER_ID 也不算数 ——
 * userType 只来自 Session 解析出的 User.type,客户端无从伪造。
 *
 * 403 而非 404:这里保护的是「运维能力」而不是某个用户拥有的资源,
 * 存在性本来就是公开事实(路由在不在),不需要伪装成 not found。
 *
 * FIX-02A:本中间件同时是 **Admin API surface 的唯一标记点** —— 授权通过即把该请求的错误
 * 暴露级别切成 admin。耦合是刻意且单向的:admin surface ⇒ admin 错误语义,但
 * 「调用者是 ADMIN」不构成切换(ADMIN 走聊天路由时仍是 Public Error);
 * 被拒的 403 也留在 public 默认值上。canonical `/api/admin/*` 与旧 alias 复用同一个
 * guard 实例 ⇒ 复用同一个标记,不存在「加了 alias 忘了标记」的窗口。
 */
export function requireAdmin(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.auth?.userType === "ADMIN") {
      markAdminErrorSurface(res);
      next();
      return;
    }
    next(new AppError(ErrorCodes.AUTH_FORBIDDEN, "Administrator privileges required"));
  };
}

/**
 * §18:AUTH_ENABLED=false 的 test/dev compatibility seam(仅 loopback 可启动,见 env refine)。
 * 注入固定 COMPAT User(type=ANONYMOUS),不建 Session/User;绝不是隐式管理员 ——
 * B3 起 /api/admin/* 对 COMPAT 必须 403。
 */
export function injectCompatAuth(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.auth = {
      userId: COMPAT_USER_ID,
      userType: "ANONYMOUS",
      sessionId: null,
      expiresAt: null,
    };
    next();
  };
}
