import { Router } from "express";
import type { RequestHandler } from "express";

import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import { PROVIDER_GEMINI_WEB } from "../../config/constants.js";
import type { BrowserManager } from "../../providers/gemini/browser-manager.js";
import type { ProviderModelsService } from "./provider-models.service.js";

/**
 * Provider API(V1.3-B3-3 起按权限分面):
 *
 * Public(authenticated,不要求 ADMIN)
 *   GET  /api/provider/models                    模型目录 —— 聊天里的模型选择必需能力(§24)
 *
 * Admin(canonical /api/admin/provider/*,旧路径 alias 已于 V1.3-C 退役)
 *   GET  /api/admin/provider/status              Provider 运行状态
 *   POST /api/admin/provider/open                启动 Browser Manager → 打开/聚焦 Gemini Page
 *   POST /api/admin/provider/restart             关闭 Context → 同一 Profile 重启
 *
 * handler 只有一份实现(§25):createProviderHandlers 产出,Public 与 Admin 各挂一次,
 * 不存在第二套业务逻辑。
 */
export interface ProviderHandlers {
  status: RequestHandler;
  models: RequestHandler;
  open: RequestHandler;
  restart: RequestHandler;
}

export function createProviderHandlers(
  browserManager: BrowserManager,
  modelsService: ProviderModelsService,
): ProviderHandlers {
  return {
    status: (_req, res) => {
      res.json({
        data: {
          provider: PROVIDER_GEMINI_WEB,
          status: browserManager.getStatus(),
        },
      });
    },

    models: async (_req, res) => {
      const catalog = await modelsService.listModels();
      res.json({ data: catalog });
    },

    open: async (_req, res) => {
      const status = await browserManager.openGemini();
      res.json({
        data: {
          provider: PROVIDER_GEMINI_WEB,
          status,
        },
      });
    },

    restart: async (_req, res) => {
      // 防运维手滑炸掉在飞的生成:Scheduler 走直接方法调用不受影响
      if (browserManager.getStatus() === "BUSY") {
        throw new AppError(
          ErrorCodes.PROVIDER_NOT_READY,
          "Cannot restart while a request is being processed",
        );
      }
      const status = await browserManager.restart();
      res.json({
        data: {
          provider: PROVIDER_GEMINI_WEB,
          status,
        },
      });
    },
  };
}

/**
 * 旧路径 alias 已退役(V1.3-C §25):本前缀只剩 Public 的模型目录。
 * status/open/restart 走 canonical `/api/admin/provider/*`,由 admin.controller 复用同一批 handler。
 */
export function createProviderRouter(handlers: ProviderHandlers): Router {
  const router = Router();

  router.get("/models", handlers.models);

  return router;
}
