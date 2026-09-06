import { Router } from "express";

import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import type { BrowserManager } from "../../providers/gemini/browser-manager.js";
import type { BrowserStatusService } from "./browser-status.service.js";

/**
 * 浏览器状态 API(docs/browser-status-api.md):
 * GET  /api/browser/status   状态快照(不启动浏览器)
 * POST /api/browser/restart  重启浏览器,返回重启后的快照
 *
 * 重启守卫顺序:已在重启中 → 有在飞 Request → BUSY,都返回 409 CONFLICT。
 * 30s 内未完成按 504 超时返回,后台重启继续收敛(状态端点观察到 RESTARTING → 终态)。
 * 启动阶段失败(Profile 占用 / launch 抛错)映射 BROWSER_LAUNCH_FAILED,
 * 其余失败映射 BROWSER_RESTART_FAILED;内部细节只进日志与快照 lastError。
 */
const RESTART_TIMEOUT_MS = 30_000;

const RESTART_TIMEOUT = Symbol("restart-timeout");

export function createBrowserStatusRouter(
  browserManager: BrowserManager,
  statusService: BrowserStatusService,
): Router {
  const router = Router();

  router.get("/status", async (_req, res) => {
    res.json({ data: await statusService.getSnapshot() });
  });

  router.post("/restart", async (_req, res) => {
    if (browserManager.isRestarting()) {
      throw restartConflict("another restart is already in progress");
    }
    const activeRequests = await statusService.countActiveRequests();
    if (activeRequests > 0) {
      throw restartConflict(`${activeRequests} request(s) are being processed`);
    }
    if (browserManager.getStatus() === "BUSY") {
      throw restartConflict("browser is busy executing another request");
    }

    const outcome = await Promise.race([
      browserManager.restart().then(
        () => null,
        (err: unknown) => err,
      ),
      delay(RESTART_TIMEOUT_MS),
    ]);
    if (outcome === RESTART_TIMEOUT) {
      throw new AppError(
        ErrorCodes.BROWSER_RESTART_TIMEOUT,
        `Browser restart did not finish within ${RESTART_TIMEOUT_MS}ms`,
      );
    }
    if (outcome !== null) {
      throw toRestartError(outcome);
    }
    res.json({ data: await statusService.getSnapshot() });
  });

  return router;
}

function restartConflict(message: string): AppError {
  return new AppError(ErrorCodes.BROWSER_RESTART_CONFLICT, message);
}

function toRestartError(err: unknown): AppError {
  if (
    err instanceof AppError &&
    (err.code === ErrorCodes.PROVIDER_BROWSER_START_FAILED ||
      err.code === ErrorCodes.PROVIDER_PROFILE_IN_USE)
  ) {
    return new AppError(
      ErrorCodes.BROWSER_LAUNCH_FAILED,
      "Failed to launch browser during restart",
      err,
    );
  }
  return new AppError(ErrorCodes.BROWSER_RESTART_FAILED, "Failed to restart browser", err);
}

function delay(ms: number): Promise<typeof RESTART_TIMEOUT> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(RESTART_TIMEOUT), ms);
    // 不阻塞进程退出:重启先完成时,残留的计时器不能挂住 shutdown / 测试 teardown
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}
