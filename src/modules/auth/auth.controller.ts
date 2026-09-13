import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";

import { AppError, RetryAfterError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import {
  AUTH_COOKIE_NAME,
  UNKNOWN_RATE_LIMIT_KEY,
} from "../../config/constants.js";
import { AnonymousIpRateLimiter } from "./auth.anonymous-rate-limit.js";
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

/** 两个入口限流器都由装配层(app.ts)创建:控制器不负责窗口与淘汰策略 */
export interface AuthRateLimiters {
  /** 测试接缝:带假时钟的登录限流器;省略 = 新建 */
  loginLimiter?: LoginRateLimiter;
  /** P6 §14:匿名身份新建的 IP 双窗口限流器 */
  anonymousIpLimiter: AnonymousIpRateLimiter;
}

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
  rateLimits: AuthRateLimiters,
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
  const limiter = rateLimits.loginLimiter ?? new LoginRateLimiter();
  const anonymousIpLimiter = rateLimits.anonymousIpLimiter;

  router.post("/login", (req, res, next) => {
    // 400 不计入限流;只有「密码错误」注册失败
    const input = loginSchema.safeParse(req.body ?? {});
    if (!input.success) {
      return next(new AppError(ErrorCodes.VALIDATION_ERROR, "login: invalid body"));
    }
    const key = req.ip ?? UNKNOWN_RATE_LIMIT_KEY;
    const status = limiter.check(key);
    if (status.blocked) {
      return next(
        new RetryAfterError(
          ErrorCodes.AUTH_RATE_LIMITED,
          "Too many failed login attempts",
          status.retryAfterSeconds,
        ),
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
    const token = extractCookie(req.headers.cookie, AUTH_COOKIE_NAME);
    // P6 §21:IP 额度必须排在「既有 Session 能否复用」之后 —— 有效身份反复调用
    // /anonymous 是正常行为,不该被算成刷身份;只有会真的新建 User 的那一次才消耗额度。
    void sessions
      .resolve(token, { touch: false })
      .then((resolved) => {
        if (resolved.kind === "active") {
          res.status(200).json({
            data: sessionPayload(true, resolved.expiresAt, resolved.auth.userType),
          });
          return undefined;
        }
        if (resolved.kind === "disabled") {
          // Cookie 指向 DISABLED User:不新建、不覆盖 Cookie,交回客户端 401
          return next(
            new AppError(ErrorCodes.AUTH_REQUIRED, "Session belongs to a disabled user"),
          );
        }
        const decision = anonymousIpLimiter.consume(req.ip ?? UNKNOWN_RATE_LIMIT_KEY);
        if (decision.limited) {
          // P10 §50:限流器自身满容量 → 服务容量 503,与本 IP 是否超限无关,也不得创建身份
          if ("capacityExceeded" in decision) {
            return next(
              new AppError(
                ErrorCodes.RATE_LIMITER_CAPACITY_EXCEEDED,
                "Identity rate limiter capacity exceeded",
              ),
            );
          }
          // §18:沿用既有 Auth 限流的 Public 契约(AUTH_RATE_LIMITED + 429 + Retry-After)
          return next(
            new RetryAfterError(
              ErrorCodes.AUTH_RATE_LIMITED,
              "Too many anonymous identities created",
              decision.retryAfterSeconds,
            ),
          );
        }
        return sessions.bootstrapAnonymous(token).then((result) => {
          if (result.kind === "disabled") {
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
