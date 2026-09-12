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
 * Admin(canonical /api/admin/provider/*,旧路径保留为 ADMIN-only alias)
 *   GET  /api/provider/status                    Provider 运行状态
 *   POST /api/provider/open                      启动 Browser Manager → 打开/聚焦 Gemini Page
 *   POST /api/provider/restart                   关闭 Context → 同一 Profile 重启
 *
 * handler 只有一份实现(§25):createProviderHandlers 产出,canonical 与 alias 各挂一次,
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
 * 旧路径(§25/§26):路径不删,但除 models 外全部加 requireAdmin。
 * 匿名与 COMPAT 因此得到 403 —— 普通用户不再能读取 Provider 运维状态或驱动浏览器。
 */
export function createProviderRouter(
  handlers: ProviderHandlers,
  requireAdmin: RequestHandler,
): Router {
  const router = Router();

  router.get("/models", handlers.models);
  router.get("/status", requireAdmin, handlers.status);
  router.post("/open", requireAdmin, handlers.open);
  router.post("/restart", requireAdmin, handlers.restart);

  return router;
}
