import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";

import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import { AUTH_COOKIE_NAME } from "../../config/constants.js";
import {
  clearSessionCookie,
  extractCookie,
  setSessionCookie,
} from "./auth.middleware.js";
import { LoginRateLimiter } from "./auth.rate-limit.js";
import type { AuthSessionService } from "./auth.session.service.js";
import type { AuthService } from "./auth.service.js";
import type { AuthDeps, UserType } from "./auth.types.js";

const loginSchema = z.object({ password: z.string().min(1) });

function toIso(at: Date): string {
  return at.toISOString();
}

function sessionPayload(authenticated: boolean, expiresAt: Date | null, userType: UserType) {
  return {
    authenticated,
    expiresAt: expiresAt === null ? null : toIso(expiresAt),
    userType,
  };
}

/**
 * POST /api/auth/login · GET /api/auth/session · POST /api/auth/logout · POST /api/auth/anonymous
 * (SEC-1 §四 + V1.3 §8/§9/§10)。
 * 始终挂载并统一携带 Cache-Control: no-store(SEC-IMPL-01);
 * auth 缺失/关闭时走 disabled 模式:不鉴权、不建 DB 行、身份恒为 COMPAT(ANONYMOUS,绝非 ADMIN)。
 */
export function createAuthRouter(
  auth: AuthDeps | null,
  authService: AuthService | null,
  sessions: AuthSessionService | null,
  limiterOverride?: LoginRateLimiter,
): Router {
  const router = Router();

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  if (auth === null || !auth.enabled || authService === null || sessions === null) {
    // §18:disabled 模式即 COMPAT 身份;login/logout 保留既有 no-op 契约(绝不返回 ADMIN)
    const compat = (_req: Request, res: Response) => {
      res.status(200).json({ data: sessionPayload(true, null, "ANONYMOUS") });
    };
    router.post("/login", compat);
    router.get("/session", compat);
    router.post("/anonymous", compat);
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
    // §10:删旧 Session → 固定 ADMIN User 新 Session;匿名身份不升级、不转移 Conversation
    void sessions
      .loginAdmin(extractCookie(req.headers.cookie, AUTH_COOKIE_NAME))
      .then((issued) => {
        setSessionCookie(res, req, auth, issued.rawToken, auth.ttlAdminSeconds);
        res.status(200).json({
          data: sessionPayload(true, issued.expiresAt, issued.auth.userType),
        });
      })
      .catch(next);
  });

  router.get("/session", (req, res, next) => {
    // §9:probe 永不 401;不返回 userId/sessionId/tokenHash
    void sessions
      .resolve(extractCookie(req.headers.cookie, AUTH_COOKIE_NAME), { touch: false })
      .then((resolved) => {
        res.status(200).json({
          data:
            resolved.kind === "active"
              ? sessionPayload(true, resolved.expiresAt, resolved.auth.userType)
              : { authenticated: false, expiresAt: null },
        });
      })
      .catch(next);
  });

  router.post("/anonymous", (req, res, next) => {
    // §8:位于业务 requireAuth 之前;无/无效 Cookie → 事务内建 User+Session 并 Set-Cookie
    void sessions
      .bootstrapAnonymous(extractCookie(req.headers.cookie, AUTH_COOKIE_NAME))
      .then((result) => {
        if (result.kind === "disabled") {
          // Cookie 指向 DISABLED User:不新建、不覆盖 Cookie,交回客户端 401
          return next(
            new AppError(ErrorCodes.AUTH_REQUIRED, "Session belongs to a disabled user"),
          );
        }
        if (result.kind === "created") {
          setSessionCookie(res, req, auth, result.rawToken, auth.ttlAnonymousSeconds);
        }
        res.status(200).json({
          data: sessionPayload(true, result.expiresAt, result.auth.userType),
        });
      })
      .catch(next);
  });

  router.post("/logout", (req, res, next) => {
    // §12:删除可解析出的 Session + 无条件清 Cookie + 204(幂等)
    void sessions
      .logout(extractCookie(req.headers.cookie, AUTH_COOKIE_NAME))
      .then(() => {
        clearSessionCookie(res);
        res.status(204).end();
      })
      .catch(next);
  });

  return router;
}
