import type { Server } from "node:http";

import type { Express } from "express";

import { createApp } from "../src/app.js";
import { createLogger } from "../src/common/logger/logger.js";
import { TEST_DATABASE_URL } from "./global-setup.js";
import { createPrismaClient, probeDatabase } from "../src/database/prisma.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";

export interface TestContext {
  prisma: PrismaClient;
  baseUrl: string;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** 每个测试文件独立 app + prisma(同一测试库),beforeEach 时 reset 数据 */
export async function setupTestContext(): Promise<TestContext> {
  const prisma = await createPrismaClient(TEST_DATABASE_URL);
  const logger = createLogger("silent");

  const app: Express = createApp({
    prisma,
    probeDatabase: () => probeDatabase(prisma),
    logger,
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

    async reset(): Promise<void> {
      await prisma.modelRequest.deleteMany();
      await prisma.message.deleteMany();
      await prisma.conversation.deleteMany();
    },

    async close(): Promise<void> {
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
