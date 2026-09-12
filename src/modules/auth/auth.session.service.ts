import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import type { Logger } from "../../common/logger/logger.js";
import { ADMIN_USER_ID } from "../../config/constants.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { AuthSessionRepository } from "./auth.session.repository.js";
import { generateSessionToken, hashSessionToken, parseSessionToken } from "./auth.session-token.js";
import type { AuthUserRepository } from "./auth.user.repository.js";
import type { AuthContext, UserType } from "./auth.types.js";

export interface AuthSessionServiceOptions {
  /** V1.3 §15:ANONYMOUS(及 V1.4 前的 REGISTERED)Session TTL 秒 */
  ttlAnonymousSeconds: number;
  /** V1.3 §15:ADMIN Session TTL 秒 */
  ttlAdminSeconds: number;
  /** V1.3 §13:lastSeenAt 距 now 超过该间隔才写库续期并重发 Set-Cookie */
  touchIntervalSeconds: number;
}

export interface AuthSessionServiceDeps {
  prisma: PrismaClient;
  sessions: AuthSessionRepository;
  users: AuthUserRepository;
  logger: Logger;
  options: AuthSessionServiceOptions;
  /** 测试接缝:假时钟(与 LoginRateLimiter 同一约定);生产不传 */
  clock?: () => Date;
}

/** renewed=true ⇒ 本次调用赢得 CAS,调用方必须按同一 raw token 重发 Set-Cookie */
export type ActiveSession = {
  kind: "active";
  auth: AuthContext;
  rawToken: string;
  expiresAt: Date;
  ttlSeconds: number;
  renewed: boolean;
};

export type SessionResolution = { kind: "none" } | { kind: "disabled" } | ActiveSession;

export type AnonymousBootstrap =
  | { kind: "created"; rawToken: string; expiresAt: Date; auth: AuthContext }
  | { kind: "existing"; expiresAt: Date; auth: AuthContext }
  | { kind: "disabled" };

export interface IssuedSession {
  rawToken: string;
  expiresAt: Date;
  auth: AuthContext;
}

/**
 * DB-backed Session 运行时(V1.3 §7/§13/§14)。
 *
 * - token 本体只在浏览器,库内只存 sha256 摘要;raw token 与 tokenHash 都不进日志/响应
 * - 有效 = Session.expiresAt > now 且 User.status = ACTIVE
 * - 滑动续期走条件更新(CAS):一个 touch window 至多一个胜者重发 Set-Cookie
 */
export class AuthSessionService {
  private readonly prisma: PrismaClient;
  private readonly sessions: AuthSessionRepository;
  private readonly users: AuthUserRepository;
  private readonly logger: Logger;
  private readonly options: AuthSessionServiceOptions;
  private readonly clock: () => Date;

  constructor(deps: AuthSessionServiceDeps) {
    this.prisma = deps.prisma;
    this.sessions = deps.sessions;
    this.users = deps.users;
    this.logger = deps.logger;
    this.options = deps.options;
    this.clock = deps.clock ?? (() => new Date());
  }

  /**
   * Cookie token → 身份。touch 只在业务 API 认证路径开启(§13);
   * anonymous / session probe 走只读解析,幂等路径不产生续期副作用。
   *
   * Session 查询失败向上抛(数据库异常不能伪装成"未登录");仅续期失败 fail-open(§14)。
   */
  async resolve(
    rawTokenFromCookie: string | undefined,
    settings: { touch: boolean },
  ): Promise<SessionResolution> {
    const rawToken = parseSessionToken(rawTokenFromCookie);
    if (rawToken === null) {
      return { kind: "none" };
    }
    const now = this.clock();
    const session = await this.sessions.findByTokenHash(this.prisma, hashSessionToken(rawToken));
    if (session === null || session.expiresAt.getTime() <= now.getTime()) {
      return { kind: "none" };
    }
    if (session.user.status !== "ACTIVE") {
      return { kind: "disabled" };
    }
    const userType = session.user.type as UserType;
    const ttlSeconds = this.ttlForType(userType);
    const auth: AuthContext = {
      userId: session.user.id,
      userType,
      sessionId: session.id,
      expiresAt: session.expiresAt,
    };
    const current: ActiveSession = {
      kind: "active",
      auth,
      rawToken,
      expiresAt: session.expiresAt,
      ttlSeconds,
      renewed: false,
    };
    if (!settings.touch) {
      return current;
    }
    const cutoff = new Date(now.getTime() - this.options.touchIntervalSeconds * 1000);
    if (session.lastSeenAt.getTime() > cutoff.getTime()) {
      // 未达阈值:只读,0 UPDATE 0 Set-Cookie
      return current;
    }
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    if (!(await this.touch(session.id, cutoff, now, expiresAt))) {
      return current;
    }
    return { ...current, auth: { ...auth, expiresAt }, expiresAt, renewed: true };
  }

  /**
   * V1.3 §8:匿名身份 bootstrap。
   * - 无 Cookie / 无效 / 已过期 → User + Session 同一事务新建(禁止孤儿 User),调用方 Set-Cookie
   * - 已有有效 Session(ANONYMOUS 或 ADMIN)→ 幂等返回当前身份,不建行不覆盖 Cookie
   * - Cookie 指向 DISABLED User → 不新建不覆盖,调用方 401(服务端不代用户绕过禁用)
   */
  async bootstrapAnonymous(rawTokenFromCookie: string | undefined): Promise<AnonymousBootstrap> {
    const resolved = await this.resolve(rawTokenFromCookie, { touch: false });
    if (resolved.kind === "active") {
      return { kind: "existing", expiresAt: resolved.expiresAt, auth: resolved.auth };
    }
    if (resolved.kind === "disabled") {
      return { kind: "disabled" };
    }
    const rawToken = generateSessionToken();
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + this.options.ttlAnonymousSeconds * 1000);
    const { user, session } = await this.prisma.$transaction(async (tx) => {
      const createdUser = await this.users.createAnonymous(tx);
      const createdSession = await this.sessions.create(tx, {
        userId: createdUser.id,
        tokenHash: hashSessionToken(rawToken),
        expiresAt,
        lastSeenAt: now,
      });
      return { user: createdUser, session: createdSession };
    });
    return {
      kind: "created",
      rawToken,
      expiresAt,
      auth: { userId: user.id, userType: "ANONYMOUS", sessionId: session.id, expiresAt },
    };
  }

  /**
   * V1.3 §10 + Review FIX-01:共享密码 → 固定 ADMIN User 的新 Session。
   *
   * 原子性不变量:登录失败 ⇒ 原 Session 仍有效、Cookie 不变。
   * 因此 ADMIN User 校验发生在任何写入之前;「删除旧 Session + 创建新 ADMIN Session」
   * 在同一事务内提交,任一失败一起回滚 —— 匿名 → ADMIN 失败后匿名身份仍可继续使用。
   * 匿名身份不升级:旧 Session 成功路径下失效,匿名 Conversation 不转移。
   * ADMIN 永远映射固定 ADMIN User,绝不 UPDATE User.type。
   */
  async loginAdmin(rawTokenFromCookie: string | undefined): Promise<IssuedSession> {
    const admin = await this.users.findById(this.prisma, ADMIN_USER_ID);
    if (admin === null || admin.status !== "ACTIVE") {
      // B1 migration 必建 ADMIN 哨兵行:缺失/被禁用属数据异常,不能静默降级成匿名身份;
      // 此时不触碰旧 Session,也不会有 Set-Cookie(由调用方在成功返回后才写)
      throw new AppError(ErrorCodes.INTERNAL_ERROR, "fixed ADMIN user is missing or disabled");
    }
    const previous = parseSessionToken(rawTokenFromCookie);
    const rawToken = generateSessionToken();
    const now = this.clock();
    const userType = admin.type as UserType;
    const expiresAt = new Date(now.getTime() + this.ttlForType(userType) * 1000);
    const session = await this.prisma.$transaction(async (tx) => {
      if (previous !== null) {
        const existing = await this.sessions.findByTokenHash(tx, hashSessionToken(previous));
        if (existing !== null) {
          await this.sessions.deleteById(tx, existing.id);
        }
      }
      return this.sessions.create(tx, {
        userId: admin.id,
        tokenHash: hashSessionToken(rawToken),
        expiresAt,
        lastSeenAt: now,
      });
    });
    return {
      rawToken,
      expiresAt,
      auth: { userId: admin.id, userType, sessionId: session.id, expiresAt },
    };
  }

  /** V1.3 §12:删除可解析出的 Session;Cookie 清理由调用方无条件执行(整体幂等) */
  async logout(rawTokenFromCookie: string | undefined): Promise<boolean> {
    const rawToken = parseSessionToken(rawTokenFromCookie);
    if (rawToken === null) {
      return false;
    }
    const count = await this.sessions.deleteByTokenHash(this.prisma, hashSessionToken(rawToken));
    return count > 0;
  }

  /**
   * V1.3-B3-3 §29/§30:吊销指定 User 的全部 Session(含当前这一条),返回删除行数。
   *
   * 异常一律上抛,不学 sweepExpired 那样吞掉:那条路径的语义是「删库成功才清 Cookie」,
   * 半途失败却清 Cookie 会造成「看起来已登出、实际 Session 还有效」的反向状态。
   */
  async revokeAllForUser(userId: string): Promise<number> {
    const count = await this.sessions.deleteAllForUser(this.prisma, userId);
    this.logger.info({ userId, count }, "all sessions revoked for user");
    return count;
  }

  /** V1.3 §19:只删已过期 Session(不碰 User);失败只记日志,绝不打崩服务 */
  async sweepExpired(): Promise<number> {
    try {
      const count = await this.sessions.deleteExpired(this.prisma, this.clock());
      if (count > 0) {
        this.logger.info({ count }, "expired auth sessions removed");
      }
      return count;
    } catch (err) {
      this.logger.error({ err }, "auth session sweep failed");
      return 0;
    }
  }

  /** §15:ADMIN 用 ADMIN TTL;ANONYMOUS / REGISTERED(暂)用匿名 TTL */
  private ttlForType(userType: UserType): number {
    return userType === "ADMIN" ? this.options.ttlAdminSeconds : this.options.ttlAnonymousSeconds;
  }

  /** CAS 续期;失败 fail-open(§14):本次请求照常继续,只是不重发 Set-Cookie */
  private async touch(
    sessionId: string,
    cutoff: Date,
    now: Date,
    expiresAt: Date,
  ): Promise<boolean> {
    try {
      const count = await this.sessions.touchIfDue(this.prisma, {
        id: sessionId,
        cutoff,
        now,
        expiresAt,
      });
      return count === 1;
    } catch (err) {
      this.logger.error({ err, sessionId }, "auth session renewal failed; continuing without renewal");
      return false;
    }
  }
}
