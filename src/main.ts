import "dotenv/config";

import http from "node:http";

import { createApp } from "./app.js";
import { createLogger } from "./common/logger/logger.js";
import { AUTH_SESSION_SWEEP_INTERVAL_MS } from "./config/constants.js";
import { parseEnv } from "./config/env.js";
import { createPrismaClient, probeDatabase } from "./database/prisma.js";
import { buildAuthDeps } from "./modules/auth/auth.middleware.js";
import { BrowserManager } from "./providers/gemini/browser-manager.js";
import { runBrowserPrewarm } from "./providers/gemini/browser-prewarm.js";
import { createDriver } from "./providers/gemini/create-driver.js";
import { GeminiWebAdapter } from "./providers/gemini/gemini.adapter.js";
import { E2EFakeBrowserManager } from "./providers/fake/e2e-fake-browser-manager.js";
import { E2EFakeGeminiAdapter } from "./providers/fake/e2e-fake-gemini.adapter.js";

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const logger = createLogger(env.LOG_LEVEL);
  const prisma = await createPrismaClient(env.DATABASE_URL);
  const useE2EFakeProvider = env.NODE_ENV === "test" && env.E2E_FAKE_PROVIDER;

  // Browser Manager:进程级单实例(一个 Persistent Context)
  const browserManager = useE2EFakeProvider
    ? new E2EFakeBrowserManager(logger)
    : new BrowserManager({
        driver: createDriver(env),
        profileDir: env.BROWSER_PROFILE_DIR,
        headless: env.BROWSER_HEADLESS,
        geminiBaseUrl: env.GEMINI_BASE_URL,
        logger,
      });

  const { app, scheduler, recovery, sse, attachmentStore, authSessions, rateLimits } = createApp({
    prisma,
    probeDatabase: () => probeDatabase(prisma),
    logger,
    browserManager,
    auth: buildAuthDeps(env),
    geminiAdapter: useE2EFakeProvider
      ? new E2EFakeGeminiAdapter()
      : new GeminiWebAdapter({
          manager: browserManager,
          baseUrl: env.GEMINI_BASE_URL,
          options: { responseTimeoutMs: env.GEMINI_RESPONSE_TIMEOUT_MS },
          logger,
        }),
    argon2MaxConcurrency: env.AUTH_ARGON2_MAX_CONCURRENCY,
    // V1.3 P6:限额全部来自 env(§13:不进数据库);生产逐项显式传,不依赖代码默认值
    abuse: {
      anonymousIpLimitPerHour: env.AUTH_ANONYMOUS_IP_LIMIT_PER_HOUR,
      anonymousIpLimitPerDay: env.AUTH_ANONYMOUS_IP_LIMIT_PER_DAY,
      chatSubmitRatePerMinute: env.CHAT_SUBMIT_RATE_LIMIT_PER_MINUTE,
      userMaxPendingRequests: env.USER_MAX_PENDING_REQUESTS,
      userMaxActiveRequests: env.USER_MAX_ACTIVE_REQUESTS,
      globalMaxPendingRequests: env.GLOBAL_MAX_PENDING_REQUESTS,
      // V1.4 U2 §28/§29:Registered 登录与注册尝试的 IP 计数(窗口长度是常量)
      userLoginIpMaxFailures: env.AUTH_USER_LOGIN_IP_MAX_FAILURES,
      registerIpMaxAttempts: env.AUTH_REGISTER_IP_MAX_ATTEMPTS,
    },
    // 启动顺序由下面三行掌握:恢复 → 开始扫描 → 才开始接受 HTTP 请求
    scheduler: {
      executionTimeoutMs: env.REQUEST_EXECUTION_TIMEOUT_MS,
      autoStart: false,
    },
    streaming: { updateIntervalMs: env.STREAMING_UPDATE_INTERVAL_MS },
  });

  // prd §12.1 + V1.2 §十三:残留 PROCESSING/CANCELLING 与带附件的 PENDING 先判 FAILED(禁止自动重发),
  // 纯文本 PENDING 留给 Scheduler 首轮扫描续跑
  await recovery.run();
  scheduler.start();

  // V1.3-B2 §19:过期 Session 轻量周期清理(先清一次);unref 不阻止退出,
  // 失败已在 service 内收敛成日志,不会打崩服务
  let authSweepTimer: NodeJS.Timeout | null = null;
  if (authSessions !== null) {
    void authSessions.sweepExpired();
    authSweepTimer = setInterval(
      () => void authSessions.sweepExpired(),
      AUTH_SESSION_SWEEP_INTERVAL_MS,
    );
    authSweepTimer.unref();
  }

  const server = http.createServer(app);
  server.listen(env.PORT, env.HOST, () => {
    logger.info(`server listening on http://${env.HOST}:${env.PORT}`);
    // P7:HTTP 已对外服务,浏览器预热才开工;fake provider 不启动任何浏览器。
    if (!useE2EFakeProvider) void runBrowserPrewarm(browserManager, logger);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    // 关闭顺序:停 Scheduler → 撤定时器 → 释放限流器 → 释放附件 → 结束 SSE → 停止 HTTP → 关 Browser → disconnect Prisma
    // Scheduler 先停:在飞的 Request 留在 PROCESSING/CANCELLING,由下次启动的 recovery 落 FAILED
    // AttachmentStore/Session sweep/限流器 sweep 紧随其后:撤掉定时器,否则它们可能在 $disconnect 之后才发起查询
    scheduler.stop();
    if (authSweepTimer !== null) {
      clearInterval(authSweepTimer);
      authSweepTimer = null;
    }
    // P6 §20:入口限流器只有内存态 + unref 的 sweep 定时器;停机撤掉,不留下还在跑的窗口清理
    // V1.4 U2 §74:新增的 Registered 登录与注册尝试 limiter 同批撤除,绝不漏一个定时器
    rateLimits.anonymousIp.dispose();
    rateLimits.chatSubmit.dispose();
    rateLimits.userLogin.dispose();
    rateLimits.register.dispose();
    rateLimits.passwordChange.dispose();
    attachmentStore.dispose();
    sse.closeAll();
    // 空闲 keep-alive 立即断开(in-flight 请求不受影响),否则 server.close() 要等客户端保活超时
    server.closeIdleConnections();
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
