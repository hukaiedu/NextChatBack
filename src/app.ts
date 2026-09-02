import express from "express";
import type { Express } from "express";

import { errorHandler } from "./common/middleware/error-handler.js";
import { requestId } from "./common/middleware/request-id.js";
import type { Logger } from "./common/logger/logger.js";
import { HEALTH_PATH } from "./config/constants.js";
import { createHealthRouter } from "./modules/health/health.controller.js";
import type { HealthProbe } from "./modules/health/health.controller.js";

export interface AppDeps {
  probeDatabase: HealthProbe;
  logger: Logger;
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(requestId());
  app.use(express.json());

  app.use(HEALTH_PATH, createHealthRouter(deps));

  // 统一错误出口,必须最后挂载
  app.use(errorHandler(deps.logger));

  return app;
}
