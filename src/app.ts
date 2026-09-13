import express from "express";
import type { Express } from "express";

import { errorHandler } from "./common/middleware/error-handler.js";
import { requestId } from "./common/middleware/request-id.js";
import type { Logger } from "./common/logger/logger.js";
import { FixedWindowRateLimiter } from "./common/rate-limit/rate-limiter.js";
import type { RateLimitClock } from "./common/rate-limit/rate-limiter.js";
import {
  ANONYMOUS_IP_LIMIT_PER_DAY,
  ANONYMOUS_IP_LIMIT_PER_HOUR,
  ATTACHMENT_BODY_LIMIT,
  CHAT_SUBMIT_RATE_LIMIT_PER_MINUTE,
  CHAT_SUBMIT_RATE_WINDOW_MS,
  GLOBAL_MAX_PENDING_REQUESTS,
  HEALTH_PATH,
  MESSAGES_BODY_PATH,
  REGISTER_IP_MAX_ATTEMPTS,
  REGISTER_IP_WINDOW_MS,
  USER_LOGIN_IP_MAX_FAILURES,
  USER_LOGIN_IP_WINDOW_MS,
  USER_MAX_ACTIVE_REQUESTS,
  USER_MAX_PENDING_REQUESTS,
} from "./config/constants.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import { createHealthRouter } from "./modules/health/health.controller.js";
import type { HealthProbe } from "./modules/health/health.controller.js";
import { createBrowserStatusHandlers } from "./modules/browser/browser-status.controller.js";
import { BrowserStatusService } from "./modules/browser/browser-status.service.js";
import {
  createProviderHandlers,
  createProviderRouter,
} from "./modules/provider/provider.controller.js";
import { createAdminRouter } from "./modules/admin/admin.controller.js";
import { ProviderModelsService } from "./modules/provider/provider-models.service.js";
import { GeminiPromptService } from "./modules/provider/gemini-prompt.service.js";
import type { BrowserManager } from "./providers/gemini/browser-manager.js";
import type { GeminiAdapter } from "./providers/gemini/gemini.types.js";
import { ConversationRepository } from "./modules/conversation/conversation.repository.js";
import { ConversationService } from "./modules/conversation/conversation.service.js";
import { createConversationRouter } from "./modules/conversation/conversation.controller.js";
import { MessageRepository } from "./modules/message/message.repository.js";
import { MessageService } from "./modules/message/message.service.js";
import type { MessageAdmission } from "./modules/message/message.service.js";
import { createMessageRouter } from "./modules/message/message.controller.js";
import { AttachmentStore } from "./modules/request/request.attachment-store.js";
import { RequestAdmissionGate } from "./modules/request/request.admission.js";
import { RequestRepository } from "./modules/request/request.repository.js";
import { RequestService } from "./modules/request/request.service.js";
import { RequestScheduler } from "./modules/request/request.scheduler.js";
import { RequestRecovery } from "./modules/request/request.recovery.js";
import { CancellationRegistry } from "./modules/request/request.cancellation.js";
import { createRequestRouter } from "./modules/request/request.controller.js";
import { GeminiStreamService } from "./modules/provider/gemini-stream.service.js";
import { RequestEventEmitter } from "./modules/sse/event-emitter.js";
import { createSseRouter } from "./modules/sse/sse.controller.js";
import { SseService } from "./modules/sse/sse.service.js";
import { ProviderPageLock } from "./providers/gemini/provider-page-lock.js";
import { createAuthRouter } from "./modules/auth/auth.controller.js";
import {
  injectCompatAuth,
  originCheck,
  requireAdmin,
  requireAuth,
} from "./modules/auth/auth.middleware.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { AuthSessionRepository } from "./modules/auth/auth.session.repository.js";
import { AuthSessionService } from "./modules/auth/auth.session.service.js";
import { AuthUserRepository } from "./modules/auth/auth.user.repository.js";
import { AnonymousIpRateLimiter } from "./modules/auth/auth.anonymous-rate-limit.js";
import { LoginRateLimiter } from "./modules/auth/auth.rate-limit.js";
import type { AuthDeps } from "./modules/auth/auth.types.js";

export interface SchedulerConfig {
  /** PENDING 扫描周期(ms),默认 1000 */
  scanIntervalMs?: number;
  /** 单条 Request 执行 watchdog 上限(ms,env REQUEST_EXECUTION_TIMEOUT_MS),默认 600000 */
  executionTimeoutMs?: number;
  /** 是否随 createApp 自动 start;需要「先恢复再启动」的调用方(main/测试)自行置 false */
  autoStart?: boolean;
}

export interface StreamingConfig {
  /** 流式回答期间 Assistant Message 的最小写库间隔(ms,env STREAMING_UPDATE_INTERVAL_MS),默认 300 */
  updateIntervalMs?: number;
}

/**
 * V1.3 P6:入口防刷与队列容量的 runtime config(env → 这里,绝不进数据库)。
 *
 * 每一项省略即回落到 constants 里的 canonical 默认值,所以生产(只有 main.ts 一个装配点)
 * 必须逐项显式传 env,而测试可以只写它关心的那一档。
 * clock 是测试接缝:三个 limiter 共用同一个可推进假时钟,用来验证窗口边界(不进生产路径)。
 */
export interface AbuseProtectionConfig {
  anonymousIpLimitPerHour?: number;
  anonymousIpLimitPerDay?: number;
  chatSubmitRatePerMinute?: number;
  userMaxPendingRequests?: number;
  /** 单用户在飞上限(§57 + FIX-01A):按数据库 PROCESSING/CANCELLING 条数强制;单 worker 下不提高并行度 */
  userMaxActiveRequests?: number;
  globalMaxPendingRequests?: number;
  clock?: RateLimitClock;
  /** P10 §45:限流器键数量上限(默认 10000)。达到后新键 fail-closed(503 SERVICE_BUSY),不淘汰 active bucket */
  maxKeys?: number;
  /**
   * V1.4 U2 §28:Registered 登录同一 IP 窗口内允许的**失败**次数(窗口 = USER_LOGIN_IP_WINDOW_MS)。
   * 省略 = 常量默认。与 ADMIN 登录 limiter 是两个独立实例,互不见到对方的桶。
   */
  userLoginIpMaxFailures?: number;
  /**
   * V1.4 U2 §29:注册同一 IP 窗口内允许的**尝试**次数(窗口 = REGISTER_IP_WINDOW_MS)。
   * 计尝试而非失败:Argon2id 的 CPU 在进入请求时就产生,与结果无关(§31)。
   */
  registerIpMaxAttempts?: number;
}

export interface AppDeps {
  prisma: PrismaClient;
  probeDatabase: HealthProbe;
  logger: Logger;
  browserManager: BrowserManager;
  geminiAdapter: GeminiAdapter;
  /** SEC-1 鉴权;null = 不鉴权(AUTH_ENABLED=false)。组装根必须显式做这个决定 */
  auth: AuthDeps | null;
  /** SEC-1 测试接缝:注入带假时钟的 limiter 验证限流窗口(AUTH-07);生产不传 */
  loginRateLimiter?: LoginRateLimiter;
  /** V1.3 P6:防刷与排队容量;省略 = 全部走 canonical 默认值 */
  abuse?: AbuseProtectionConfig;
  scheduler?: SchedulerConfig;
  streaming?: StreamingConfig;
}

/**
 * createApp 不自行启动 Scheduler:启动顺序必须是
 * `await recovery.run()` → `scheduler.start()`(prd §12.1),由组装根(main.ts / 测试 helper)掌握。
 */
export interface AppHandle {
  app: Express;
  scheduler: RequestScheduler;
  recovery: RequestRecovery;
  /** 第 6 阶段:SSE 连接登记表,关闭服务器前需要 closeAll() 结束长连接 */
  sse: SseService;
  /** 进程内 Request 事件总线(装配与测试观察用) */
  events: RequestEventEmitter;
  /** 第 8 阶段:取消通道登记表(测试可断言 abort 次数 / 有界性) */
  cancellation: CancellationRegistry;
  /** M3:执行器实例(测试直接驱动 execute,精确控制取消时点) */
  executor: GeminiPromptService;
  /** V1.2 I1:附件内存容器(停机要 dispose;测试断言 liveBytes 不变量) */
  attachmentStore: AttachmentStore;
  /** V1.3-B2:DB Session 运行时(enabled 时非 null;main.ts 用它启动 sweep) */
  authSessions: AuthSessionService | null;
  /**
   * V1.3 P6:两个入口限流器。停机必须 dispose(撤 sweep 定时器),
   * 测试用它们断言窗口边界与「过期键被清理、键数不无限增长」。
   */
  rateLimits: {
    anonymousIp: AnonymousIpRateLimiter;
    chatSubmit: FixedWindowRateLimiter;
    /** V1.4 U2 §74:Registered 登录 limiter,停机必须撤 sweep 定时器 */
    userLogin: LoginRateLimiter;
    /** V1.4 U2 §74:注册尝试 limiter,同上 */
    register: FixedWindowRateLimiter;
  };
}

export function createApp(deps: AppDeps): AppHandle {
  const app = express();

  // §10.2:仅影响 req.ip(登录限流键/审计),必须在挂任何路由前设置
  if (deps.auth?.trustProxy === true) {
    app.set("trust proxy", "loopback");
  }

  app.disable("x-powered-by");
  app.use(requestId());

  // V1.2 I1 §三:带图请求的 body 上限只在 POST messages 这一条精确路径上放宽到 14MB,
  // 且必须挂在全局默认 parser **之前** —— 请求流只能读一次,反过来则 100KB 上限先掐掉大图。
  // 判据用锚定正则而不是 app.use(path, …):挂载是前缀匹配,会把放宽额度漏给 /messages/extra。
  const messagesJson = express.json({ limit: ATTACHMENT_BODY_LIMIT });
  app.use((req, res, next) =>
    req.method === "POST" && MESSAGES_BODY_PATH.test(req.path)
      ? messagesJson(req, res, next)
      : next(),
  );
  app.use(express.json());

  // §7:unsafe method Origin 校验,始终挂载(不随 AUTH_ENABLED 关闭)
  app.use(originCheck(deps.auth?.allowedOrigins ?? null));

  // Health
  app.use(HEALTH_PATH, createHealthRouter(deps));

  // SEC-1 §12.1 + V1.3 §20:auth 端点始终挂载(disabled 模式);之后业务路由统一带 req.auth ——
  // enabled → DB Session 认证 / disabled → COMPAT 身份注入(loopback 由 env 保证)
  const authRuntime =
    deps.auth !== null && deps.auth.enabled
      ? {
          service: new AuthService({ password: deps.auth.password }),
          sessions: new AuthSessionService({
            prisma: deps.prisma,
            sessions: new AuthSessionRepository(),
            users: new AuthUserRepository(),
            logger: deps.logger,
            options: {
              ttlAnonymousSeconds: deps.auth.ttlAnonymousSeconds,
              ttlRegisteredSeconds: deps.auth.ttlRegisteredSeconds,
              ttlAdminSeconds: deps.auth.ttlAdminSeconds,
              touchIntervalSeconds: deps.auth.touchIntervalSeconds,
            },
          }),
        }
      : null;
  // V1.3 P6 §11/§82:三道入口准入的 runtime 组件(env → config → 这里;测试可注入假时钟)
  const abuse = deps.abuse ?? {};
  const anonymousIpLimiter = new AnonymousIpRateLimiter({
    perHour: abuse.anonymousIpLimitPerHour ?? ANONYMOUS_IP_LIMIT_PER_HOUR,
    perDay: abuse.anonymousIpLimitPerDay ?? ANONYMOUS_IP_LIMIT_PER_DAY,
    clock: abuse.clock,
    maxKeys: abuse.maxKeys,
  });
  const chatSubmitLimiter = new FixedWindowRateLimiter({
    windowMs: CHAT_SUBMIT_RATE_WINDOW_MS,
    max: abuse.chatSubmitRatePerMinute ?? CHAT_SUBMIT_RATE_LIMIT_PER_MINUTE,
    clock: abuse.clock,
    maxKeys: abuse.maxKeys,
  });
  // V1.4 U2 §11/§73:Registered 登录复用同一个 LoginRateLimiter class(「只计失败 + 成功清零」
  // 的语义与 ADMIN 登录完全一致),但实例独立 ⇒ 两个桶互不可见。绝不复制第二套 fixed-window 实现。
  const userLoginLimiter = new LoginRateLimiter({
    windowMs: USER_LOGIN_IP_WINDOW_MS,
    max: abuse.userLoginIpMaxFailures ?? USER_LOGIN_IP_MAX_FAILURES,
    clock: abuse.clock,
    maxKeys: abuse.maxKeys,
  });
  // V1.4 U2 §29-§31:注册尝试 limiter 直接是裸原语 —— 语义就是「计一次尝试」,与 chatSubmit 同源,
  // 不需要再包一层 class。
  const registerLimiter = new FixedWindowRateLimiter({
    windowMs: REGISTER_IP_WINDOW_MS,
    max: abuse.registerIpMaxAttempts ?? REGISTER_IP_MAX_ATTEMPTS,
    clock: abuse.clock,
    maxKeys: abuse.maxKeys,
  });
  const admission: MessageAdmission = {
    submitLimiter: chatSubmitLimiter,
    gate: new RequestAdmissionGate(),
    limits: {
      userMaxPending: abuse.userMaxPendingRequests ?? USER_MAX_PENDING_REQUESTS,
      globalMaxPending: abuse.globalMaxPendingRequests ?? GLOBAL_MAX_PENDING_REQUESTS,
    },
  };

  app.use(
    "/api/auth",
    createAuthRouter(
      deps.auth ?? null,
      authRuntime?.service ?? null,
      authRuntime?.sessions ?? null,
      {
        loginLimiter: deps.loginRateLimiter,
        anonymousIpLimiter,
        userLoginLimiter,
        registerLimiter,
      },
    ),
  );
  if (authRuntime !== null && deps.auth !== null) {
    app.use(requireAuth(authRuntime.sessions, deps.auth));
  } else {
    app.use(injectCompatAuth());
  }

  // 模块组装:Controller → Service → Scheduler → GeminiPromptService → Adapter(prd §3.1)
  // 第 6 阶段的流式通道单向向外:RequestService / GeminiStreamService 发布, SSE 只订阅读取
  const conversationRepo = new ConversationRepository();
  const messageRepo = new MessageRepository();
  const requestRepo = new RequestRepository();
  const events = new RequestEventEmitter();
  // V1.2 I1:附件字节只在进程内存活,生命周期 = reserve(占位) → drop(执行结束/清理)
  const attachmentStore = new AttachmentStore({
    prisma: deps.prisma,
    requestRepo,
    logger: deps.logger,
  });

  const conversationService = new ConversationService(deps.prisma, conversationRepo, requestRepo);
  const cancellation = new CancellationRegistry();
  const requestService = new RequestService(
    deps.prisma,
    requestRepo,
    messageRepo,
    conversationRepo,
    events,
    cancellation,
  );
  const messageService = new MessageService(
    deps.prisma,
    messageRepo,
    conversationRepo,
    requestRepo,
    attachmentStore,
    // scheduler 在下方创建:回调只在新 Request 提交后才运行,前向引用安全
    {
      onRequestCreated: (requestId, userId) => scheduler.notify(requestId, userId),
    },
    admission,
  );
  const geminiStreamService = new GeminiStreamService({
    messageService,
    events,
    logger: deps.logger,
    options: { updateIntervalMs: deps.streaming?.updateIntervalMs },
  });
  const geminiPromptService = new GeminiPromptService(
    conversationService,
    deps.browserManager,
    deps.geminiAdapter,
    deps.logger,
    geminiStreamService,
    deps.prisma,
    requestRepo,
  );
  // FIX-06:Provider Page 操作互斥锁,Scheduler 与 GET /models 共享同一实例
  const pageLock = new ProviderPageLock();
  const scheduler = new RequestScheduler({
    prisma: deps.prisma,
    requestRepo,
    messageRepo,
    requestService,
    executor: geminiPromptService,
    browserManager: deps.browserManager,
    logger: deps.logger,
    cancellation,
    pageLock,
    attachmentStore,
    options: {
      scanIntervalMs: deps.scheduler?.scanIntervalMs,
      executionTimeoutMs: deps.scheduler?.executionTimeoutMs,
      // P7 §57:公平调度的单用户在飞上限(env USER_MAX_ACTIVE_REQUESTS)
      userMaxActiveRequests: abuse.userMaxActiveRequests,
    },
  });
  const recovery = new RequestRecovery({
    prisma: deps.prisma,
    requestRepo,
    requestService,
    logger: deps.logger,
  });
  const sse = new SseService({
    prisma: deps.prisma,
    requests: requestService,
    messageRepo,
    events,
    logger: deps.logger,
  });
  const providerModelsService = new ProviderModelsService(deps.geminiAdapter, deps.browserManager, pageLock);
  const browserStatusService = new BrowserStatusService(deps.browserManager, deps.prisma);

  // V1.3-B3-3 §25:运维 handler 只有一份实现;V1.3-C 起只有 canonical /api/admin/* 一个挂载点。
  // requireAdmin() 只实例化一次,交给 Admin router 统一使用,避免出现两份权限判据。
  const providerHandlers = createProviderHandlers(deps.browserManager, providerModelsService);
  const browserHandlers = createBrowserStatusHandlers(deps.browserManager, browserStatusService);
  const adminGuard = requireAdmin();

  app.use("/api/conversations", createConversationRouter(conversationService));
  app.use(
    "/api/conversations/:conversationId/messages",
    createMessageRouter(messageService),
  );
  app.use("/api/requests", createRequestRouter(requestService));
  // GET /api/requests/:id/events(第 6 阶段 SSE);与 REST 路由共用前缀
  app.use("/api/requests", createSseRouter(sse));
  // GET /api/provider/models = Public(§24);运维能力只有 canonical /api/admin/provider/*
  app.use("/api/provider", createProviderRouter(providerHandlers));
  // canonical Admin API(§23):全局 requireAuth 已在上方挂载,这里再叠加 requireAdmin
  app.use(
    "/api/admin",
    createAdminRouter({
      browser: browserHandlers,
      provider: providerHandlers,
      // COMPAT 模式没有 Session 运行时;但该分支要求先过 requireAdmin,而 COMPAT 恒 ANONYMOUS
      // ⇒ 永远 403,取不到 sessions。故 handler 内的非空断言与 req.auth! 属同一类已证不变量。
      sessions: authRuntime?.sessions ?? null,
      requireAdmin: adminGuard,
    }),
  );

  // 统一错误出口,必须最后挂载
  app.use(errorHandler(deps.logger));

  if (deps.scheduler?.autoStart !== false) {
    scheduler.start();
  }

  return {
    app,
    scheduler,
    recovery,
    sse,
    events,
    cancellation,
    executor: geminiPromptService,
    attachmentStore,
    authSessions: authRuntime?.sessions ?? null,
    rateLimits: {
      anonymousIp: anonymousIpLimiter,
      chatSubmit: chatSubmitLimiter,
      userLogin: userLoginLimiter,
      register: registerLimiter,
    },
  };
}
