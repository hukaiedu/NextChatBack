import { Router } from "express";
import { z } from "zod";

import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import { AUTH_COOKIE_NAME } from "../../config/constants.js";
import { extractCookie } from "./auth.middleware.js";
import { LoginRateLimiter } from "./auth.rate-limit.js";
import type { AuthService } from "./auth.service.js";
import type { AuthDeps } from "./auth.types.js";

const loginSchema = z.object({ password: z.string().min(1) });

function toIso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/**
 * POST /api/auth/login · GET /api/auth/session · POST /api/auth/logout(§四)。
 * 三端点始终挂载并统一携带 Cache-Control: no-store(SEC-IMPL-01);
 * auth = null 或 enabled=false 时走 disabled 模式(探测逻辑单一化,避免 404 歧义)。
 */
export function createAuthRouter(
  auth: AuthDeps | null,
  authService: AuthService | null,
  limiterOverride?: LoginRateLimiter,
): Router {
  const router = Router();

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  if (auth === null || !auth.enabled || authService === null) {
    router.post("/login", (_req, res) => {
      res.status(200).json({ data: { authenticated: true, expiresAt: null } });
    });
    router.get("/session", (_req, res) => {
      res.status(200).json({ data: { authenticated: true, expiresAt: null } });
    });
    router.post("/logout", (_req, res) => {
      res.status(204).end();
    });
    return router;
  }

  // limiter 可注入(测试假时钟);生产默认新建
  const limiter = limiterOverride ?? new LoginRateLimiter();

  router.post("/login", (req, res, next) => {
    // 400 不计入限流;只有「密码错误」注册失败
    const input = loginSchema.safeParse(req.body ?? {});
    if (!input.success) {
      return next(new AppError(ErrorCodes.VALIDATION_ERROR, "login: invalid body"));
    }
    const key = req.ip ?? "unknown";
    const status = limiter.check(key);
    if (status.blocked) {
      res.setHeader("Retry-After", String(status.retryAfterSeconds));
      return next(
        new AppError(ErrorCodes.AUTH_RATE_LIMITED, "Too many failed login attempts"),
      );
    }
    if (!authService.verifyPassword(input.data.password)) {
      limiter.registerFailure(key);
      return next(
        new AppError(ErrorCodes.AUTH_INVALID_CREDENTIALS, "Invalid password"),
      );
    }
    limiter.reset(key);
    const signed = authService.sign();
    // §六:production 恒 Secure(fail-closed);dev/test 按 req.secure
    res.cookie(AUTH_COOKIE_NAME, signed.token, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: auth.ttlSeconds * 1000,
      secure: auth.cookieSecureAlways || req.secure,
    });
    res.status(200).json({
      data: { authenticated: true, expiresAt: toIso(signed.expiresAt) },
    });
  });

  router.get("/session", (req, res) => {
    const token = extractCookie(req.headers.cookie, AUTH_COOKIE_NAME);
    const result = authService.verify(token);
    res.status(200).json({
      data: result.valid
        ? { authenticated: true, expiresAt: toIso(result.expiresAt) }
        : { authenticated: false, expiresAt: null },
    });
  });

  router.post("/logout", (_req, res) => {
    // 同名同 Path 清除,不加 Domain(§六);clearCookie 会删除 maxAge(Express 内部),
    // 要按设计输出 Max-Age=0 就必须用 res.cookie 显式置空
    res.cookie(AUTH_COOKIE_NAME, "", {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: 0,
    });
    res.status(204).end();
  });

  return router;
}
