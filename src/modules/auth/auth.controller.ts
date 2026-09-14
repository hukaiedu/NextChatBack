import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";

import { AppError, RetryAfterError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import {
  AUTH_COOKIE_NAME,
  UNKNOWN_RATE_LIMIT_KEY,
} from "../../config/constants.js";
import type { FixedWindowRateLimiter } from "../../common/rate-limit/rate-limiter.js";
import { AnonymousIpRateLimiter } from "./auth.anonymous-rate-limit.js";
import {
  clearSessionCookie,
  extractCookie,
  setSessionCookie,
} from "./auth.middleware.js";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, hashPassword } from "./auth.password.js";
import { LoginRateLimiter } from "./auth.rate-limit.js";
import type { ActiveSession, AuthSessionService } from "./auth.session.service.js";
import type { AuthService } from "./auth.service.js";
import type { AuthDeps, UserType } from "./auth.types.js";
import { USERNAME_PATTERN } from "./auth.username.js";

const loginSchema = z.object({ password: z.string().min(1) });

/**
 * V1.4 U2 §19-§20:username 规则的唯一出处是 auth.username.ts,这里只引用不复制;
 * 归一化(小写)由 service 做 —— 两处各自维护迟早漂移成「前端放行、后端 409」。
 */
const usernameSchema = z.string().regex(USERNAME_PATTERN);

/** §18:长度即政策(不做字符类别要求);Backend 强校验,前端提示只是体验层 */
const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH)
  .max(PASSWORD_MAX_LENGTH);

const registerSchema = z.object({ username: usernameSchema, password: passwordSchema });
const userLoginSchema = registerSchema;
const passwordChangeSchema = z.object({
  currentPassword: passwordSchema,
  newPassword: passwordSchema,
});

/** 所有入口限流器都由装配层(app.ts)创建:控制器不负责窗口与淘汰策略 */
export interface AuthRateLimiters {
  /** 测试接缝:带假时钟的登录限流器;省略 = 新建 */
  loginLimiter?: LoginRateLimiter;
  /** P6 §14:匿名身份新建的 IP 双窗口限流器 */
  anonymousIpLimiter: AnonymousIpRateLimiter;
  /**
   * V1.4 U2 §11/§73:Registered 登录 limiter。与 ADMIN 那份是**同一 class 的两个独立实例**
   * ⇒ 桶互不干扰,但也不复制第二套 fixed-window 实现。必须由装配层创建(不得在控制器内 new)。
   */
  userLoginLimiter: LoginRateLimiter;
  /**
   * V1.4 U2 §29-§31:注册尝试 limiter,计**尝试**而非失败 —— Argon2id 的 CPU 在进入请求时
   * 就已产生,与结果无关。用裸 FixedWindowRateLimiter + register 语义,与 chatSubmit 同源。
   */
  registerLimiter: FixedWindowRateLimiter;
  /** D1B:Registered 改密按 User.id 计 attempt,必须在 Argon2 前注册。 */
  passwordChangeLimiter: FixedWindowRateLimiter;
}

function toIso(at: Date): string {
  return at.toISOString();
}

/**
 * V1.4 U2 §37/§38:authenticated 面固定**四键**,含 `username: string | null`。
 * 绝不返回 userId / sessionId / tokenHash / raw token / passwordHash / usernameNormalized。
 */
function authenticatedPayload(
  expiresAt: Date | null,
  userType: UserType,
  username: string | null,
) {
  return {
    authenticated: true,
    expiresAt: expiresAt === null ? null : toIso(expiresAt),
    userType,
    username,
  };
}

/**
 * 兼容既有调用形状的便捷出口:ANONYMOUS / ADMIN / COMPAT 的 username 恒为 null。
 * unauthenticated 保持两键(不补 userType) —— 探测失败不该暗示任何身份(§38)。
 */
function sessionPayload(authenticated: boolean, expiresAt: Date | null, userType: UserType) {
  return authenticated
    ? authenticatedPayload(expiresAt, userType, null)
    : { authenticated: false, expiresAt: null };
}

/**
 * POST /api/auth/login · GET /api/auth/session · POST /api/auth/logout · POST /api/auth/anonymous
 * (SEC-1 §四 + V1.3 §8/§9/§10)
 * + V1.4 U2 §42-§65:/register · /user/login · /password/change · /sessions/revoke-all
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
    // V1.4 U2 §43/§97:注册 / 普通登录 / 改密 / 撤销全部会话在 COMPAT 下一律 403 **硬失败**。
    // 刻意不沿用 login 的 no-op-成功形状:那会让客户端以为账号已建/身份已切换,而 COMPAT 既没有
    // 可升级的凭据行也没有 Session 运行时(design R12)。403 也必然排在 hash / 写库 / Set-Cookie 之前。
    const compatForbidden: RequestHandler = (_req, _res, next) => {
      next(
        new AppError(
          ErrorCodes.AUTH_FORBIDDEN,
          "Registered accounts require AUTH_ENABLED=true",
        ),
      );
    };
    router.post("/login", compat);
    router.get("/session", compat);
    router.post("/anonymous", compat);
    router.post("/logout", (_req, res) => {
      res.status(204).end();
    });
    router.post("/register", compatForbidden);
    router.post("/user/login", compatForbidden);
    router.post("/password/change", compatForbidden);
    router.post("/sessions/revoke-all", compatForbidden);
    return router;
  }

  // limiter 可注入(测试假时钟);生产默认新建
  const limiter = rateLimits.loginLimiter ?? new LoginRateLimiter();
  const anonymousIpLimiter = rateLimits.anonymousIpLimiter;
  const userLoginLimiter = rateLimits.userLoginLimiter;
  const registerLimiter = rateLimits.registerLimiter;
  const passwordChangeLimiter = rateLimits.passwordChangeLimiter;

  /**
   * V1.4 U2 §42/§58/§102/§103:本 router 挂在全局 requireAuth **之前**,所以四个新端点拿不到
   * `req.auth`,必须自行解析 Cookie 并把三态映射成出口码。返回 ActiveSession;不合规一律抛
   * AppError 交给 errorHandler。
   *
   * 刻意不改成「把 auth router 移到 requireAuth 之后」—— 那会连带改掉 /session、/anonymous、
   * /login、/user/login 四条公开端点的契约(§102)。
   * `touch:false`:探测与身份转换路径不产生滑动续期副作用(续期属业务 API)。
   *
   * 写成 const 箭头而不是函数声明:声明会被提升,TS 不把外层 `sessions !== null` 的收窄带进
   * 函数体(改回去就报 possibly null);其余本文件内的 handler 同理。
   */
  const resolveIdentityFor = async (
    req: Request,
    requirement: "ANONYMOUS" | "REGISTERED",
  ): Promise<ActiveSession> => {
    const resolved = await sessions.resolve(
      extractCookie(req.headers.cookie, AUTH_COOKIE_NAME),
      { touch: false },
    );
    if (resolved.kind === "none") {
      throw new AppError(ErrorCodes.AUTH_REQUIRED, "Missing or invalid session cookie");
    }
    if (resolved.kind === "disabled") {
      // 与业务 API 同为 401,但这里给注册/改密面更精确的码:它们要区分「没登录」与「被禁用」
      throw new AppError(ErrorCodes.AUTH_USER_DISABLED, "Session belongs to a disabled user");
    }
    if (resolved.auth.userType !== requirement) {
      // 注册要求匿名 → 业务码 409;改密/撤销要求 REGISTERED → 沿用既有权限码 403(§58/§64)
      throw new AppError(
        requirement === "ANONYMOUS"
          ? ErrorCodes.AUTH_IDENTITY_NOT_ANONYMOUS
          : ErrorCodes.AUTH_FORBIDDEN,
        requirement === "ANONYMOUS"
          ? "Only an anonymous identity can register"
          : "Registered session required",
      );
    }
    if (resolved.auth.sessionId === null) {
      // active 结果只可能来自 DB Session 行 ⇒ sessionId 恒非 null;走到这里属运行时异常
      throw new AppError(ErrorCodes.INTERNAL_ERROR, "Active session without a session id");
    }
    return resolved;
  };

  /** 限流器自身满容量 = 服务容量 → 503 SERVICE_BUSY;刻意不是 AUTH_RATE_LIMITED(design §33) */
  function limiterCapacityExceeded(): AppError {
    return new AppError(
      ErrorCodes.RATE_LIMITER_CAPACITY_EXCEEDED,
      "Auth rate limiter capacity exceeded",
    );
  }

  router.post("/login", (req, res, next) => {
    // 400 不计入限流;只有「密码错误」注册失败
    const input = loginSchema.safeParse(req.body ?? {});
    if (!input.success) {
      return next(new AppError(ErrorCodes.VALIDATION_ERROR, "login: invalid body"));
    }
    const key = req.ip ?? UNKNOWN_RATE_LIMIT_KEY;
    const status = limiter.check(key);
    if (status.blocked) {
      // V1.4 U2 §33:容量耗尽(新 IP 且键表已满)→ 503,与本 IP 的失败次数无关
      if ("capacityExceeded" in status) {
        return next(limiterCapacityExceeded());
      }
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
          data: authenticatedPayload(issued.expiresAt, issued.auth.userType, issued.username),
        });
      })
      .catch(next);
  });

  router.get("/session", (req, res, next) => {
    // §9:probe 永不 401;不返回 userId/sessionId/tokenHash。V1.4 U2 §67:touch:false 保持只读
    void sessions
      .resolve(extractCookie(req.headers.cookie, AUTH_COOKIE_NAME), { touch: false })
      .then((resolved) => {
        res.status(200).json({
          data:
            resolved.kind === "active"
              ? authenticatedPayload(
                  resolved.expiresAt,
                  resolved.auth.userType,
                  resolved.username,
                )
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
            data: authenticatedPayload(
              resolved.expiresAt,
              resolved.auth.userType,
              resolved.username,
            ),
          });
          return undefined;
        }
        if (resolved.kind === "disabled") {
          // Cookie 指向 DISABLED User:不新建、不覆盖 Cookie,交回客户端 401。
          // 刻意保持既有 AUTH_REQUIRED 出口(§98 要继续 PASS 的 V1.3 契约),不换成 U2 新码
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
            data: authenticatedPayload(result.expiresAt, result.auth.userType, result.username),
          });
        });
      })
      .catch(next);
  });

  /**
   * V1.4 U2 §42-§47:把当前匿名身份原地注册为 REGISTERED(design R7)。
   *
   * §30 冻结的顺序:**所有免费分支都排在散列之前** —— 非法 body、身份不对、用户名已占用三条
   * 都不消耗 Argon2id,限流同样在 hash 之前(§79 CPU 保护)。
   * 注册端点**不**自动创建匿名身份(§100):没有 ANONYMOUS Session 就是 401,由前端 /register 先 bootstrap。
   */
  router.post(
    "/register",
    (req: Request, res: Response, next: NextFunction) => {
      const input = registerSchema.safeParse(req.body ?? {});
      if (!input.success) {
        return next(new AppError(ErrorCodes.VALIDATION_ERROR, "register: invalid body"));
      }
      void (async () => {
        const identity = await resolveIdentityFor(req, "ANONYMOUS");
        if (await sessions.isUsernameTaken(input.data.username)) {
          throw new AppError(
            ErrorCodes.AUTH_USERNAME_ALREADY_TAKEN,
            "Username is already taken",
          );
        }
        const decision = registerLimiter.register(req.ip ?? UNKNOWN_RATE_LIMIT_KEY);
        if (decision.limited) {
          if ("capacityExceeded" in decision) {
            throw limiterCapacityExceeded();
          }
          throw new RetryAfterError(
            ErrorCodes.AUTH_RATE_LIMITED,
            "Too many registration attempts",
            decision.retryAfterSeconds,
          );
        }
        const passwordHash = await hashPassword(input.data.password);
        const issued = await sessions.registerAnonymous({
          userId: identity.auth.userId,
          sessionId: identity.auth.sessionId!,
          username: input.data.username,
          passwordHash,
        });
        // §66:身份等级与 TTL 同时变化 ⇒ 必须换发新 token;旧匿名 token 随事务删除而失效
        setSessionCookie(res, req, auth, issued.rawToken, auth.ttlRegisteredSeconds);
        res.status(200).json({
          data: authenticatedPayload(issued.expiresAt, issued.auth.userType, issued.username),
        });
      })().catch(next);
    },
  );

  /**
   * V1.4 U2 §48-§56:登录已有 REGISTERED 账号。
   *
   * 与 ADMIN 的 `/login` 完全分开:那条是共享密码 + 固定 ADMIN User 的运维入口(§40),
   * 这条才是普通账号入口。两者都不迁移匿名数据(design R9)。
   * 访客(无 Cookie / 非法 / 过期)可直接登录,无需先建匿名身份(§101)。
   */
  router.post(
    "/user/login",
    (req: Request, res: Response, next: NextFunction) => {
      const input = userLoginSchema.safeParse(req.body ?? {});
      if (!input.success) {
        return next(new AppError(ErrorCodes.VALIDATION_ERROR, "user login: invalid body"));
      }
      const key = req.ip ?? UNKNOWN_RATE_LIMIT_KEY;
      const status = userLoginLimiter.check(key);
      if (status.blocked) {
        // §9/§79:容量耗尽与本 IP 失败超限都在 verify 之前拒绝 ⇒ 被拒请求零次口令校验
        if ("capacityExceeded" in status) {
          return next(limiterCapacityExceeded());
        }
        return next(
          new RetryAfterError(
            ErrorCodes.AUTH_RATE_LIMITED,
            "Too many failed login attempts",
            status.retryAfterSeconds,
          ),
        );
      }
      void sessions
        .loginRegistered({
          username: input.data.username,
          password: input.data.password,
          presentedToken: extractCookie(req.headers.cookie, AUTH_COOKIE_NAME),
        })
        .then((result) => {
          if (result.kind === "invalid-credentials") {
            // §32/§49:用户名不存在 / 密码错 / 非 REGISTERED / 已 DISABLED 一律同一码同一文案
            userLoginLimiter.registerFailure(key);
            throw new AppError(
              ErrorCodes.AUTH_INVALID_CREDENTIALS,
              "Invalid username or password",
            );
          }
          userLoginLimiter.reset(key);
          setSessionCookie(res, req, auth, result.session.rawToken, auth.ttlRegisteredSeconds);
          res.status(200).json({
            data: authenticatedPayload(
              result.session.expiresAt,
              result.session.auth.userType,
              result.session.username,
            ),
          });
        })
        .catch(next);
    },
  );

  /**
   * V1.4 U2 §57-§62:REGISTERED 改密。
   *
   * `newPassword === currentPassword` 排在 verify 之前(§59):那条判断不需要任何散列。
   * 当前口令校验失败**不改任何 Session**(§60) —— 否则拿到他人 Cookie 的人就能用错密码踢人下线。
   * D1B:按 active REGISTERED User.id 计 attempt,先于两次散列;成功不清零。
   */
  router.post(
    "/password/change",
    (req: Request, res: Response, next: NextFunction) => {
      const input = passwordChangeSchema.safeParse(req.body ?? {});
      if (!input.success) {
        return next(new AppError(ErrorCodes.VALIDATION_ERROR, "password change: invalid body"));
      }
      if (input.data.newPassword === input.data.currentPassword) {
        return next(
          new AppError(ErrorCodes.VALIDATION_ERROR, "password change: newPassword unchanged"),
        );
      }
      void (async () => {
        const identity = await resolveIdentityFor(req, "REGISTERED");
        const decision = passwordChangeLimiter.register(identity.auth.userId);
        if (decision.limited) {
          if ("capacityExceeded" in decision) {
            throw limiterCapacityExceeded();
          }
          throw new RetryAfterError(
            ErrorCodes.AUTH_RATE_LIMITED,
            "Too many password change attempts",
            decision.retryAfterSeconds,
          );
        }
        if (
          !(await sessions.verifyRegisteredPassword(
            identity.auth.userId,
            input.data.currentPassword,
          ))
        ) {
          throw new AppError(ErrorCodes.AUTH_INVALID_CREDENTIALS, "Invalid password");
        }
        const passwordHash = await hashPassword(input.data.newPassword);
        const issued = await sessions.changeRegisteredPassword({
          userId: identity.auth.userId,
          sessionId: identity.auth.sessionId!,
          passwordHash,
        });
        setSessionCookie(res, req, auth, issued.rawToken, auth.ttlRegisteredSeconds);
        res.status(200).json({
          data: authenticatedPayload(issued.expiresAt, issued.auth.userType, issued.username),
        });
      })().catch(next);
    },
  );

  router.post(
    "/sessions/revoke-all",
    (req: Request, res: Response, next: NextFunction) => {
      // V1.4 U2 §63/§64:普通用户只能撤销**自己**的会话 —— userId 只来自 resolve,无入参可伪造
      void (async () => {
        const identity = await resolveIdentityFor(req, "REGISTERED");
        const revoked = await sessions.revokeAllForUser(identity.auth.userId);
        // 与 ADMIN 那条同一纪律:删库成功才清 Cookie,半途失败绝不留「看着已退出、Session 还有效」
        clearSessionCookie(res);
        res.status(200).json({ data: { revoked } });
      })().catch(next);
    },
  );

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
