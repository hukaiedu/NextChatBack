import "dotenv/config";

import http from "node:http";

import { createApp } from "./app.js";
import { createLogger } from "./common/logger/logger.js";
import { parseEnv } from "./config/env.js";
import { createPrismaClient, probeDatabase } from "./database/prisma.js";
import { BrowserManager } from "./providers/gemini/browser-manager.js";
import { GeminiWebAdapter } from "./providers/gemini/gemini.adapter.js";
import { PlaywrightBrowserDriver } from "./providers/gemini/playwright-driver.js";

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const logger = createLogger(env.LOG_LEVEL);
  const prisma = await createPrismaClient(env.DATABASE_URL);

  // Browser Manager:进程级单实例(一个 Persistent Context)
  const browserManager = new BrowserManager({
    driver: new PlaywrightBrowserDriver(),
    profileDir: env.BROWSER_PROFILE_DIR,
    headless: env.BROWSER_HEADLESS,
    geminiBaseUrl: env.GEMINI_BASE_URL,
    logger,
  });

  const { app, scheduler, recovery } = createApp({
    prisma,
    probeDatabase: () => probeDatabase(prisma),
    logger,
    browserManager,
    geminiAdapter: new GeminiWebAdapter({
      manager: browserManager,
      baseUrl: env.GEMINI_BASE_URL,
      options: { responseTimeoutMs: env.GEMINI_RESPONSE_TIMEOUT_MS },
      logger,
    }),
    // 启动顺序由下面三行掌握:恢复 → 开始扫描 → 才开始接受 HTTP 请求
    scheduler: {
      executionTimeoutMs: env.REQUEST_EXECUTION_TIMEOUT_MS,
      autoStart: false,
    },
  });

  // prd §12.1:残留 PROCESSING 先判 FAILED(禁止自动重发),PENDING 留给 Scheduler 首轮扫描
  await recovery.run();
  scheduler.start();

  const server = http.createServer(app);
  server.listen(env.PORT, env.HOST, () => {
    logger.info(`server listening on http://${env.HOST}:${env.PORT}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    // 关闭顺序:停止接受 HTTP → 关闭 Browser Manager → disconnect Prisma
    server.close(() => {
      browserManager
        .stop()
        .catch((err) => {
          logger.error({ err }, "error while stopping browser manager");
        })
        .finally(() => {
          prisma
            .$disconnect()
            .catch(() => undefined)
            .finally(() => process.exit(0));
        });
    });
    // 兜底:连接迟迟不关闭时强制退出(先尝试关闭浏览器,避免孤儿进程)
    setTimeout(() => {
      logger.warn("graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
