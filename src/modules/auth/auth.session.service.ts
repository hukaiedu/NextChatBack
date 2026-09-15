import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import type { Logger } from "../../common/logger/logger.js";
import { ADMIN_USER_ID } from "../../config/constants.js";
import { uniqueViolationInfo } from "../../common/utils/prisma-error.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { DUMMY_PASSWORD_HASH } from "./auth.password.js";
import type { PasswordCrypto } from "./auth.password.js";
import type { AuthSessionRepository } from "./auth.session.repository.js";
import { generateSessionToken, hashSessionToken, parseSessionToken } from "./auth.session-token.js";
import type { AuthUserRepository } from "./auth.user.repository.js";
import type { AnonymousDataCleanupService } from "./anonymous-data-cleanup.service.js";
import { normalizeUsername } from "./auth.username.js";
import type { AuthContext, UserType } from "./auth.types.js";

export interface AuthSessionServiceOptions {
  /** V1.3 §15:ANONYMOUS Session TTL 秒 */
  ttlAnonymousSeconds: number;
  /** V1.4 U2 §7:REGISTERED Session TTL 秒(独立于匿名与 ADMIN) */
  ttlRegisteredSeconds: number;
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
  passwordCrypto: PasswordCrypto;
  options: AuthSessionServiceOptions;
  /** 测试接缝:假时钟(与 LoginRateLimiter 同一约定);生产不传 */
  clock?: () => Date;
  anonymousDataCleanup?: AnonymousDataCleanupService;
}

/** renewed=true ⇒ 本次调用赢得 CAS,调用方必须按同一 raw token 重发 Set-Cookie */
export type ActiveSession = {
  kind: "active";
  auth: AuthContext;
  rawToken: string;
  expiresAt: Date;
  ttlSeconds: number;
  renewed: boolean;
  /** Auth DTO 用(V1.4 U2 §39);ANONYMOUS / ADMIN 恒为 null */
  username: string | null;
};

export type SessionResolution = { kind: "none" } | { kind: "disabled" } | ActiveSession;

export type AnonymousBootstrap =
  | { kind: "created"; rawToken: string; expiresAt: Date; auth: AuthContext; username: null }
  | {
      kind: "existing";
      expiresAt: Date;
      auth: AuthContext;
      username: string | null;
    }
  | { kind: "disabled" };

export interface IssuedSession {
  rawToken: string;
  expiresAt: Date;
  auth: AuthContext;
  /** V1.4 U2 §37:成功响应的第四个键来源;ADMIN / 匿名恒为 null */
  username: string | null;
}

/**
 * Registered 登录的结论(V1.4 U2 §48-§54)。
 *
 * 刻意不抛 AppError 表达「凭据不对」:limiter 的「只计失败」记账按 IP 键,而 IP 只有
 * controller 知道。service 给出判别结果,controller 负责 `registerFailure` / `reset` 与出口码。
 * 竞态失败(`deleteById` 命中 0)则是另一回事:它不是凭据违规,直接以 AUTH_REQUIRED 上抛。
 */
export type RegisteredLoginResult =
  | { kind: "invalid-credentials" }
  | { kind: "issued"; session: IssuedSession };

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
  private readonly passwordCrypto: PasswordCrypto;
  private readonly anonymousDataCleanup?: AnonymousDataCleanupService;

  constructor(deps: AuthSessionServiceDeps) {
    this.prisma = deps.prisma;
    this.sessions = deps.sessions;
    this.users = deps.users;
    this.logger = deps.logger;
    this.passwordCrypto = deps.passwordCrypto;
    this.options = deps.options;
    this.clock = deps.clock ?? (() => new Date());
    this.anonymousDataCleanup = deps.anonymousDataCleanup;
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
      username: session.user.username,
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
      return {
        kind: "existing",
        expiresAt: resolved.expiresAt,
        auth: resolved.auth,
        username: resolved.username,
      };
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
      username: null,
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
      // 与 V1.4 的差异是刻意的:这里对「解析不到旧 Session」选择跳过删除继续创建 —— 那是
      // V1.3 已冻结的 ADMIN 登录契约(有测试覆盖:旧 Cookie 指向已消失的 Session 时登录仍要成功)。
      // 而 register / loginRegistered / changePassword 要求首写删除**必须命中 1**,否则
      // AUTH_REQUIRED 并回滚(见 registerAnonymous 的注释与 design §31.5/§31.6)。
      // 不要因为「看起来该统一」把任一侧改成另一侧:一边放宽会打开 fixation 窗口,
      // 一边收紧会打破 V1.3 契约。
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
      username: admin.username,
      auth: { userId: admin.id, userType, sessionId: session.id, expiresAt },
    };
  }

  /** V1.3 §12:删除可解析出的 Session;Cookie 清理由调用方无条件执行(整体幂等) */
  async logout(rawTokenFromCookie: string | undefined): Promise<boolean> {
    const rawToken = parseSessionToken(rawTokenFromCookie);
    if (rawToken === null) {
      return false;
    }
    const tokenHash = hashSessionToken(rawToken);
    const session = await this.sessions.findByTokenHash(this.prisma, tokenHash);
    const count = await this.sessions.deleteByTokenHash(this.prisma, tokenHash);
    if (count > 0 && session?.user.type === "ANONYMOUS") {
      await this.anonymousDataCleanup?.cleanupEligible(this.clock());
    }
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

  /**
   * V1.4 U2 §30:注册前的用户名预查。
   *
   * 它**不是**唯一性的裁决者 —— 那是 DB 的 `UNIQUE(usernameNormalized)`(§35)。
   * 存在的唯一理由:让「用户名已被占用」在花钱跑 Argon2id 之前返回(design §21 CPU 保护)。
   */
  async isUsernameTaken(username: string): Promise<boolean> {
    const user = await this.users.findByNormalizedUsername(
      this.prisma,
      normalizeUsername(username),
    );
    return user !== null;
  }

  /**
   * V1.4 U2 §23/§45:匿名 User 原地升级为 REGISTERED(design R7)。
   *
   * 写入顺序是 design §31 冻结的唯一顺序:
   *   1. FIRST WRITE = 精准删除本次呈现的匿名 Session,且必须命中 1
   *      命中 0 ⇒ 身份已被并发替换 → AUTH_REQUIRED + 回滚(绝不留下新 Session)
   *   2. CAS 升级 User(WHERE id AND type='ANONYMOUS'):count=0 ⇒ AUTH_IDENTITY_NOT_ANONYMOUS + 回滚
   *      —— 第 1 步的删除随之恢复,所以双提交不会出现「两个都成功」
   *   3. 用**同一个 userId** 建 REGISTERED Session
   * 事务里没有任何 Conversation/Message/ModelRequest 语句 ⇒ 零业务数据搬迁是结构性的(§47)。
   */
  async registerAnonymous(input: {
    userId: string;
    sessionId: string;
    username: string;
    passwordHash: string;
  }): Promise<IssuedSession> {
    const usernameNormalized = normalizeUsername(input.username);
    const rawToken = generateSessionToken();
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + this.options.ttlRegisteredSeconds * 1000);
    try {
      const session = await this.prisma.$transaction(async (tx) => {
        if ((await this.sessions.deleteById(tx, input.sessionId)) !== 1) {
          throw new AppError(
            ErrorCodes.AUTH_REQUIRED,
            "Presented session is no longer active",
          );
        }
        const upgraded = await this.users.upgradeAnonymousToRegistered(tx, {
          userId: input.userId,
          username: input.username,
          usernameNormalized,
          passwordHash: input.passwordHash,
        });
        if (upgraded !== 1) {
          throw new AppError(
            ErrorCodes.AUTH_IDENTITY_NOT_ANONYMOUS,
            "Identity is no longer anonymous",
          );
        }
        return this.sessions.create(tx, {
          userId: input.userId,
          tokenHash: hashSessionToken(rawToken),
          expiresAt,
          lastSeenAt: now,
        });
      });
      return {
        rawToken,
        expiresAt,
        username: input.username,
        auth: {
          userId: input.userId,
          userType: "REGISTERED",
          sessionId: session.id,
          expiresAt,
        },
      };
    } catch (err) {
      // §46:同名并发由 DB UNIQUE 裁决。判定只看 uniqueViolationInfo 的结构化 fields,
      // 绝不解析 error.message 或索引名 —— Prisma 对文案不承诺兼容(见 prisma-error.ts 的 I1.1 教训)。
      // 两个 AppError(401/409)不是 P2002,fields 恒为空 ⇒ 原样上抛。
      if (uniqueViolationInfo(err).fields.includes("usernameNormalized")) {
        throw new AppError(
          ErrorCodes.AUTH_USERNAME_ALREADY_TAKEN,
          "Username is already taken",
        );
      }
      throw err;
    }
  }

  /**
   * V1.4 U2 §48-§56:用户名 + 口令登录已有 REGISTERED 账号。
   *
   * 顺序刻意为「先验证凭据,再动 Session」(§51):否则任何拿到他人 Cookie 的人都能用
   * 错误密码把当前用户踢下线。凭据不成立时不做任何写入,也不区分「用户不存在 / 密码错 /
   * 已禁用 / 不是注册用户」—— 四种情况一律同一结论,同一 CPU 形状(§49 + design §6)。
   *
   * 凭据成立后按 §31 走事务:解析到 active presented Session 就必须删掉它且命中 1,
   * 命中 0 ⇒ AUTH_REQUIRED + 回滚(并发重复提交的败方不会留下第二条 Session);
   * 完全没有 presented Session 的访客不执行删除,直接 create(§52)。
   * 只删呈现的那一条 ⇒ 同账号其它设备的 Session 仍然有效(§56),绝不 deleteAllForUser。
   */
  async loginRegistered(input: {
    username: string;
    password: string;
    presentedToken: string | undefined;
  }): Promise<RegisteredLoginResult> {
    const user = await this.users.findByNormalizedUsername(
      this.prisma,
      normalizeUsername(input.username),
    );
    // user 为 null 或 passwordHash 为 null(匿名/管理员行)时打 DUMMY:同等 CPU,不泄漏该用户名是否存在
    const ok = await this.passwordCrypto.verifyPassword(
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
      input.password,
    );
    if (!ok) {
      return { kind: "invalid-credentials" };
    }
    // 刻意排在 verify 之后:提前返回就省掉了那次散列,CPU 差本身会变成枚举信号
    if (user === null || user.type !== "REGISTERED" || user.status !== "ACTIVE") {
      return { kind: "invalid-credentials" };
    }
    const presented = await this.resolve(input.presentedToken, { touch: false });
    const presentedSessionId = presented.kind === "active" ? presented.auth.sessionId : null;
    const rawToken = generateSessionToken();
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + this.options.ttlRegisteredSeconds * 1000);
    const session = await this.prisma.$transaction(async (tx) => {
      if (presentedSessionId !== null) {
        if ((await this.sessions.deleteById(tx, presentedSessionId)) !== 1) {
          throw new AppError(
            ErrorCodes.AUTH_REQUIRED,
            "Presented session is no longer active",
          );
        }
      }
      return this.sessions.create(tx, {
        userId: user.id,
        tokenHash: hashSessionToken(rawToken),
        expiresAt,
        lastSeenAt: now,
      });
    });
    return {
      kind: "issued",
      session: {
        rawToken,
        expiresAt,
        username: user.username,
        auth: {
          userId: user.id,
          userType: "REGISTERED",
          sessionId: session.id,
          expiresAt,
        },
      },
    };
  }

  /**
   * V1.4 U2 §60:改密前校验当前口令。与登录共用同一条 verify 原语,不触碰任何 Session。
   *
   * 身份不是 REGISTERED 或摘要缺失时返回 false(而不是抛新码):这条路径的 Public 出口
   * 本来就是 AUTH_INVALID_CREDENTIALS,多一个码只是多一个可观测的分支。
   */
  async verifyRegisteredPassword(userId: string, currentPassword: string): Promise<boolean> {
    const user = await this.users.findById(this.prisma, userId);
    if (user === null || user.type !== "REGISTERED" || user.passwordHash === null) {
      return false;
    }
    return this.passwordCrypto.verifyPassword(user.passwordHash, currentPassword);
  }

  /**
   * V1.4 U2 §61:写入新摘要并收敛 Session 集合。
   *
   * 事务顺序同样服从 §31:首写删除当前 Session 必须命中 1;随后
   * `updatePasswordHash`(WHERE 带 type='REGISTERED' ⇒ 命中 0 说明身份已不是注册用户,
   * 属数据异常 → INTERNAL_ERROR 回滚,绝不静默写匿名行)、
   * `deleteAllForUser`(此刻当前条已删 ⇒ 语义恰为「其它设备全部退出」)、再为当前设备建新 Session。
   * 全事务不碰 User 的其它列,也不碰任何业务表(§62)。
   */
  async changeRegisteredPassword(input: {
    userId: string;
    sessionId: string;
    passwordHash: string;
  }): Promise<IssuedSession> {
    const rawToken = generateSessionToken();
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + this.options.ttlRegisteredSeconds * 1000);
    const { session, username } = await this.prisma.$transaction(async (tx) => {
      if ((await this.sessions.deleteById(tx, input.sessionId)) !== 1) {
        throw new AppError(ErrorCodes.AUTH_REQUIRED, "Presented session is no longer active");
      }
      if (
        (await this.users.updatePasswordHash(tx, {
          userId: input.userId,
          passwordHash: input.passwordHash,
        })) !== 1
      ) {
        throw new AppError(
          ErrorCodes.INTERNAL_ERROR,
          "password change target is not an active REGISTERED user",
        );
      }
      await this.sessions.deleteAllForUser(tx, input.userId);
      const created = await this.sessions.create(tx, {
        userId: input.userId,
        tokenHash: hashSessionToken(rawToken),
        expiresAt,
        lastSeenAt: now,
      });
      // 事务内回读展示名:保证响应里的 username 与刚提交的状态一致,而不是请求前的快照
      const updated = await this.users.findById(tx, input.userId);
      return { session: created, username: updated?.username ?? null };
    });
    return {
      rawToken,
      expiresAt,
      username,
      auth: {
        userId: input.userId,
        userType: "REGISTERED",
        sessionId: session.id,
        expiresAt,
      },
    };
  }

  /** V1.3 §19:删已过期 Session并清理失效匿名用户;失败只记日志,绝不打崩服务 */
  async sweepExpired(): Promise<number> {
    try {
      const now = this.clock();
      const count = await this.sessions.deleteExpired(this.prisma, now);
      await this.anonymousDataCleanup?.cleanupEligible(now);
      if (count > 0) {
        this.logger.info({ count }, "expired auth sessions removed");
      }
      return count;
    } catch (err) {
      this.logger.error({ err }, "auth session sweep failed");
      return 0;
    }
  }

  /**
   * §15 + V1.4 U2 §26:三种身份各自的 TTL **穷举**。
   *
   * 不再写成 `ADMIN ? admin : anonymous` —— 那种写法会把 REGISTERED 静默归到匿名档,
   * 而注册账号的存活时长是需要独立运维的业务契约(design §7)。
   * default 分支由 `never` 收窄:将来新增 UserType 而忘记登记 TTL 时会在这里编译失败/运行期 fail-fast。
   */
  private ttlForType(userType: UserType): number {
    switch (userType) {
      case "ADMIN":
        return this.options.ttlAdminSeconds;
      case "REGISTERED":
        return this.options.ttlRegisteredSeconds;
      case "ANONYMOUS":
        return this.options.ttlAnonymousSeconds;
      default: {
        const unreachable: never = userType;
        throw new AppError(
          ErrorCodes.INTERNAL_ERROR,
          `no session TTL configured for user type ${String(unreachable)}`,
        );
      }
    }
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
