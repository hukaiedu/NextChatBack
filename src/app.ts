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
import { createRequestRouter } from "./modules/request/request.controller.js";

export interface SchedulerConfig {
  /** PENDING 扫描周期(ms),默认 1000 */
  scanIntervalMs?: number;
  /** 是否随 createApp 自动 start;测试可关掉改用 runOnce 手动驱动,默认 true */
  autoStart?: boolean;
}

export interface AppDeps {
  prisma: PrismaClient;
  probeDatabase: HealthProbe;
  logger: Logger;
  browserManager: BrowserManager;
  geminiAdapter: GeminiAdapter;
  scheduler?: SchedulerConfig;
}

export interface AppHandle {
  app: Express;
  scheduler: RequestScheduler;
}

export function createApp(deps: AppDeps): AppHandle {
  const app = express();

  app.disable("x-powered-by");
  app.use(requestId());
  app.use(express.json());

  // Health
  app.use(HEALTH_PATH, createHealthRouter(deps));

  // 模块组装:Controller → Service → Scheduler → GeminiPromptService → Adapter(prd §3.1)
  const conversationRepo = new ConversationRepository();
  const messageRepo = new MessageRepository();
  const requestRepo = new RequestRepository();

  const conversationService = new ConversationService(deps.prisma, conversationRepo, requestRepo);
  const requestService = new RequestService(
    deps.prisma,
    requestRepo,
    messageRepo,
    conversationRepo,
  );
  const geminiPromptService = new GeminiPromptService(
    conversationService,
    deps.browserManager,
    deps.geminiAdapter,
    deps.logger,
  );
  const scheduler = new RequestScheduler({
    prisma: deps.prisma,
    requestRepo,
    messageRepo,
    requestService,
    executor: geminiPromptService,
    browserManager: deps.browserManager,
    logger: deps.logger,
    options: { scanIntervalMs: deps.scheduler?.scanIntervalMs },
  });
  const messageService = new MessageService(
    deps.prisma,
    messageRepo,
    conversationRepo,
    requestRepo,
    { onRequestCreated: () => scheduler.notify() },
  );

  app.use("/api/conversations", createConversationRouter(conversationService));
  app.use(
    "/api/conversations/:conversationId/messages",
    createMessageRouter(messageService),
  );
  app.use("/api/requests", createRequestRouter(requestService));
  app.use("/api/provider", createProviderRouter(deps.browserManager));

  // 统一错误出口,必须最后挂载
  app.use(errorHandler(deps.logger));

  if (deps.scheduler?.autoStart !== false) {
    scheduler.start();
  }

  return { app, scheduler };
}
