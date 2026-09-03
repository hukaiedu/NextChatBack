import type { Server } from "node:http";

import type { Express } from "express";

import { createApp } from "../src/app.js";
import type { SchedulerConfig } from "../src/app.js";
import { createLogger } from "../src/common/logger/logger.js";
import type { BrowserManager } from "../src/providers/gemini/browser-manager.js";
import type { GeminiAdapter } from "../src/providers/gemini/gemini.types.js";
import type { RequestScheduler } from "../src/modules/request/request.scheduler.js";
import type { RequestRecovery } from "../src/modules/request/request.recovery.js";
import { TEST_DATABASE_URL } from "./global-setup.js";
import { createPrismaClient, probeDatabase } from "../src/database/prisma.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { FakeDriver, FakeGeminiAdapter, createFakeManager } from "./fakes.js";

export interface TestContext {
  prisma: PrismaClient;
  baseUrl: string;
  /** 仅当 setup 时开启 scheduler 才有值;autoStart=false 时可手动 runOnce 驱动 */
  scheduler: RequestScheduler | null;
  /** 启动恢复器;helper 不自动跑,测试用 run() 模拟「服务重启」 */
  recovery: RequestRecovery;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** 每个测试文件独立 app + prisma(同一测试库),beforeEach 时 reset 数据 */
export async function setupTestContext(options?: {
  browserManager?: BrowserManager;
  geminiAdapter?: GeminiAdapter;
  /** 默认不启动 Scheduler(第 2 阶段行为测试不受影响);传入即启用,可 autoStart:false + runOnce 手动驱动 */
  scheduler?: SchedulerConfig;
}): Promise<TestContext> {
  const prisma = await createPrismaClient(TEST_DATABASE_URL);
  const logger = createLogger("silent");

  // 默认注入"永不启动"的 Browser Manager stub(provider 测试才需要真实/可操纵实例)
  const browserManager = options?.browserManager ?? createFakeManager(new FakeDriver());

  const { app, scheduler, recovery } = createApp({
    prisma,
    probeDatabase: () => probeDatabase(prisma),
    logger,
    browserManager,
    geminiAdapter: options?.geminiAdapter ?? new FakeGeminiAdapter(),
    scheduler: {
      scanIntervalMs: options?.scheduler?.scanIntervalMs ?? 25,
      executionTimeoutMs: options?.scheduler?.executionTimeoutMs,
      autoStart: options?.scheduler ? (options.scheduler.autoStart ?? true) : false,
    },
  });

  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test server");
  }

  return {
    prisma,
    baseUrl: `http://127.0.0.1:${address.port}`,
    scheduler,
    recovery,

    async reset(): Promise<void> {
      await prisma.modelRequest.deleteMany();
      await prisma.message.deleteMany();
      await prisma.conversation.deleteMany();
    },

    async close(): Promise<void> {
      scheduler.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await prisma.$disconnect();
    },
  };
}

export async function createConversation(
  baseUrl: string,
  title?: string,
): Promise<{ id: string; title: string; status: string; provider: string }> {
  const res = await fetch(`${baseUrl}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(title !== undefined ? { title } : {}),
  });
  if (res.status !== 201) {
    throw new Error(`createConversation failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data: { id: string; title: string; status: string; provider: string } };
  return body.data;
}

export async function sendMessage(
  baseUrl: string,
  conversationId: string,
  content: string,
  idempotencyKey: string,
): Promise<Response> {
  return fetch(`${baseUrl}/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ content }),
  });
}
