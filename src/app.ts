import express from "express";
import type { Express } from "express";

import { errorHandler } from "./common/middleware/error-handler.js";
import { requestId } from "./common/middleware/request-id.js";
import type { Logger } from "./common/logger/logger.js";
import { HEALTH_PATH } from "./config/constants.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import { createHealthRouter } from "./modules/health/health.controller.js";
import type { HealthProbe } from "./modules/health/health.controller.js";
import { ConversationRepository } from "./modules/conversation/conversation.repository.js";
import { ConversationService } from "./modules/conversation/conversation.service.js";
import { createConversationRouter } from "./modules/conversation/conversation.controller.js";
import { MessageRepository } from "./modules/message/message.repository.js";
import { MessageService } from "./modules/message/message.service.js";
import { createMessageRouter } from "./modules/message/message.controller.js";
import { RequestRepository } from "./modules/request/request.repository.js";
import { RequestService } from "./modules/request/request.service.js";
import { createRequestRouter } from "./modules/request/request.controller.js";

export interface AppDeps {
  prisma: PrismaClient;
  probeDatabase: HealthProbe;
  logger: Logger;
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(requestId());
  app.use(express.json());

  // Health
  app.use(HEALTH_PATH, createHealthRouter(deps));

  // 模块组装:Controller → Service → Repository → Prisma
  const conversationRepo = new ConversationRepository();
  const messageRepo = new MessageRepository();
  const requestRepo = new RequestRepository();

  const conversationService = new ConversationService(deps.prisma, conversationRepo, requestRepo);
  const messageService = new MessageService(deps.prisma, messageRepo, conversationRepo, requestRepo);
  const requestService = new RequestService(deps.prisma, requestRepo);

  app.use("/api/conversations", createConversationRouter(conversationService));
  app.use(
    "/api/conversations/:conversationId/messages",
    createMessageRouter(messageService),
  );
  app.use("/api/requests", createRequestRouter(requestService));

  // 统一错误出口,必须最后挂载
  app.use(errorHandler(deps.logger));

  return app;
}
