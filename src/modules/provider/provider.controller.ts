import { Router } from "express";

import { PROVIDER_GEMINI_WEB } from "../../config/constants.js";
import type { BrowserManager } from "../../providers/gemini/browser-manager.js";
import { parseOrThrow } from "../../common/utils/parse.js";
import type { GeminiPromptService } from "./gemini-prompt.service.js";
import { runPromptSchema } from "./provider.schema.js";

/**
 * Provider API:
 *
 * GET  /api/provider/status   当前 Provider 状态(不启动浏览器)
 * POST /api/provider/open     启动 Browser Manager → 打开/聚焦 Gemini Page
 * POST /api/provider/restart  关闭 Context → 同一 Profile 重启 → 打开 Gemini
 * POST /api/provider/prompt   第 4 阶段最小验证链路:发 Prompt → 存 URL → 读回答
 *
 * /prompt 只是验证载体:除 providerConversationUrl 外不写任何业务数据,
 * Request 状态流转与 assistant message 回填属第 5、6 阶段。
 *
 * 启动失败(如 Profile 被占用)由 BrowserManager 抛 AppError,
 * 统一错误出口返回 { error: { code, message, requestId } }。
 */
export function createProviderRouter(
  browserManager: BrowserManager,
  promptService: GeminiPromptService,
): Router {
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

  // POST /api/provider/prompt
  router.post("/prompt", async (req, res) => {
    const body = parseOrThrow(runPromptSchema, req.body ?? {}, "runPrompt");
    const result = await promptService.runPrompt(body.conversationId, body.prompt);
    res.json({ data: result });
  });

  return router;
}
