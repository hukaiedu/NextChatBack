import type { Logger } from "../../common/logger/logger.js";
import type { BrowserManager } from "./browser-manager.js";

/**
 * P7 Backend startup prewarm:HTTP listen 成功后把 Chromium + Gemini Page + 登录检测
 * 提前推到 READY / LOGIN_REQUIRED,使首条请求命中 gate 的零导航短路。
 *
 * 错误语义(设计文档 docs/P7_BROWSER_CONTEXT_PREWARM_DESIGN.md §13/§14):
 * - launch/navigation 失败已在 BrowserManager 内收敛为 ERROR + lastBrowserError;
 * - 这里只补日志,绝不向外重抛 → `void` 调用点不会产生 unhandledRejection;
 * - 不新增任何后台重试:无 PENDING 时保持 ERROR,有 PENDING 时由既有
 *   RequestScheduler WAIT + periodic scan 语义驱动恢复。
 */
export async function runBrowserPrewarm(
  manager: BrowserManager,
  logger: Logger,
): Promise<void> {
  try {
    const status = await manager.ensureReady();
    logger.info({ status }, "browser prewarm finished");
  } catch (err) {
    logger.warn({ err }, "browser prewarm failed; will recover per existing scheduler semantics");
  }
}
