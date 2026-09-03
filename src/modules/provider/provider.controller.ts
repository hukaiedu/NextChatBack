import { Router } from "express";

import { PROVIDER_GEMINI_WEB } from "../../config/constants.js";
import type { BrowserManager } from "../../providers/gemini/browser-manager.js";

/**
 * Provider API:
 *
 * GET  /api/provider/status   当前 Provider 状态(不启动浏览器)
 * POST /api/provider/open     启动 Browser Manager → 打开/聚焦 Gemini Page
 * POST /api/provider/restart  关闭 Context → 同一 Profile 重启 → 打开 Gemini
 *
 * 第 4 阶段的 POST /prompt 验证载体已在第 5 阶段移除:正式发送走
 * POST /api/conversations/:id/messages → MessageService(事务)→ Scheduler
 * → GeminiPromptService → GeminiAdapter(prd §6.2 / §3.1)。
 *
 * 启动失败(如 Profile 被占用)由 BrowserManager 抛 AppError,
 * 统一错误出口返回 { error: { code, message, requestId } }。
 */
export function createProviderRouter(browserManager: BrowserManager): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    res.json({
      data: {
        provider: PROVIDER_GEMINI_WEB,
        status: browserManager.getStatus(),
      },
    });
  });

  router.post("/open", async (_req, res) => {
    const status = await browserManager.openGemini();
    res.json({
      data: {
        provider: PROVIDER_GEMINI_WEB,
        status,
      },
    });
  });

  router.post("/restart", async (_req, res) => {
    const status = await browserManager.restart();
    res.json({
      data: {
        provider: PROVIDER_GEMINI_WEB,
        status,
      },
    });
  });

  return router;
}
