import "dotenv/config";

import http from "node:http";

import { createApp } from "./app.js";
import { createLogger } from "./common/logger/logger.js";
import { parseEnv } from "./config/env.js";
import { createPrismaClient, probeDatabase } from "./database/prisma.js";

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const logger = createLogger(env.LOG_LEVEL);
  const prisma = createPrismaClient(env.DATABASE_URL);

  const app = createApp({
    probeDatabase: () => probeDatabase(prisma),
    logger,
  });

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
    server.close(() => {
      prisma
        .$disconnect()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });
    // 兜底:连接迟迟不关闭时强制退出
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
