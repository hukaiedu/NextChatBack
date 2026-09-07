import type { NextFunction, Request, RequestHandler, Response } from "express";

import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import { AUTH_COOKIE_NAME } from "../../config/constants.js";
import type { Env } from "../../config/env.js";
import { AuthService } from "./auth.service.js";
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
    secret: env.AUTH_SESSION_SECRET ?? "",
    ttlSeconds: env.AUTH_SESSION_TTL_SECONDS,
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

/** §12.1:cookie → verify → 失败统一 401 AUTH_REQUIRED(经既有 errorHandler 出口) */
export function requireAuth(authService: AuthService): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = extractCookie(req.headers.cookie, AUTH_COOKIE_NAME);
    if (!authService.verify(token).valid) {
      return next(
        new AppError(ErrorCodes.AUTH_REQUIRED, "Missing or invalid session cookie"),
      );
    }
    next();
  };
}
