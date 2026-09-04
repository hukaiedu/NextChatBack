import express from "express";
import type { Express } from "express";

import { errorHandler } from "./common/middleware/error-handler.js";
import { requestId } from "./common/middleware/request-id.js";
import type { Logger } from "./common/logger/logger.js";
import { HEALTH_PATH } from "./config/constants.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import { createHealthRouter } from "./modules/health/health.controller.js";
import type { HealthProbe } from "./modules/health/health.controller.js";
import { createProviderRouter } from "./modules/provider/provider.controller.js";
import { GeminiPromptService } from "./modules/provider/gemini-prompt.service.js";
import type { BrowserManager } from "./providers/gemini/browser-manager.js";
import type { GeminiAdapter } from "./providers/gemini/gemini.types.js";
import { ConversationRepository } from "./modules/conversation/conversation.repository.js";
import { ConversationService } from "./modules/conversation/conversation.service.js";
import { createConversationRouter } from "./modules/conversation/conversation.controller.js";
import { MessageRepository } from "./modules/message/message.repository.js";
import { MessageService } from "./modules/message/message.service.js";
import { createMessageRouter } from "./modules/message/message.controller.js";
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

export interface AppDeps {
  prisma: PrismaClient;
  probeDatabase: HealthProbe;
  logger: Logger;
  browserManager: BrowserManager;
  geminiAdapter: GeminiAdapter;
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
}

export function createApp(deps: AppDeps): AppHandle {
  const app = express();

  app.disable("x-powered-by");
  app.use(requestId());
  app.use(express.json());

  // Health
  app.use(HEALTH_PATH, createHealthRouter(deps));

  // 模块组装:Controller → Service → Scheduler → GeminiPromptService → Adapter(prd §3.1)
  // 第 6 阶段的流式通道单向向外:RequestService / GeminiStreamService 发布, SSE 只订阅读取
  const conversationRepo = new ConversationRepository();
  const messageRepo = new MessageRepository();
  const requestRepo = new RequestRepository();
  const events = new RequestEventEmitter();

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
    // scheduler 在下方创建:回调只在新 Request 提交后才运行,前向引用安全
    { onRequestCreated: () => scheduler.notify() },
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
  );
  const scheduler = new RequestScheduler({
    prisma: deps.prisma,
    requestRepo,
    messageRepo,
    requestService,
    executor: geminiPromptService,
    browserManager: deps.browserManager,
    logger: deps.logger,
    cancellation,
    options: {
      scanIntervalMs: deps.scheduler?.scanIntervalMs,
      executionTimeoutMs: deps.scheduler?.executionTimeoutMs,
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

  app.use("/api/conversations", createConversationRouter(conversationService));
  app.use(
    "/api/conversations/:conversationId/messages",
    createMessageRouter(messageService),
  );
  app.use("/api/requests", createRequestRouter(requestService));
  // GET /api/requests/:id/events(第 6 阶段 SSE);与 REST 路由共用前缀
  app.use("/api/requests", createSseRouter(sse));
  app.use("/api/provider", createProviderRouter(deps.browserManager));

  // 统一错误出口,必须最后挂载
  app.use(errorHandler(deps.logger));

  if (deps.scheduler?.autoStart !== false) {
    scheduler.start();
  }

  return { app, scheduler, recovery, sse, events, cancellation };
}
