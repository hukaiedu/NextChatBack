import type { Server } from "node:http";
import { Writable } from "node:stream";

import express from "express";
import type { Express } from "express";
import pino from "pino";
import type { Logger } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "../../src/common/logger/logger.js";
import { errorHandler } from "../../src/common/middleware/error-handler.js";
import { requestId } from "../../src/common/middleware/request-id.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

/** 捕获式 logger(JSON 行):断言原始错误码只进日志、不进响应 */
function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = pino(
    { level: "info" },
    new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    }),
  );
  return { logger, lines };
}

describe("统一错误处理", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestContext();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("非法 JSON body 返回 400 VALIDATION_ERROR", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("错误响应 requestId 与 x-request-id 响应头一致", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/conversations/nonexistent`);
    expect(res.status).toBe(404);

    const headerRequestId = res.headers.get("x-request-id");
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    expect(headerRequestId).toBeTruthy();
    expect(body.error.requestId).toBe(headerRequestId);
  });

  it("50001 字符消息返回 400 VALIDATION_ERROR 且带 requestId", async () => {
    const created = await fetch(`${ctx.baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const conversation = (await created.json()) as { data: { id: string } };

    const res = await fetch(
      `${ctx.baseUrl}/api/conversations/${conversation.data.id}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "err-key-1",
        },
        body: JSON.stringify({ content: "a".repeat(50001) }),
      },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.requestId).toBe(res.headers.get("x-request-id"));
  });
});

describe("数据库异常统一映射", () => {
  /** 构造最小 express 链:requestId + 抛错路由 + errorHandler */
  async function withBoomApp(
    throwingError: () => Error,
    logger: Logger = createLogger("silent"),
  ): Promise<{
    baseUrl: string;
    close(): Promise<void>;
  }> {
    const app: Express = express();
    app.use(requestId());
    app.get("/boom", () => {
      throw throwingError();
    });
    app.use(errorHandler(logger));

    const server: Server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind");
    }
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      async close(): Promise<void> {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  it.each([
    ["PrismaClientKnownRequestError", () => new Prisma.PrismaClientKnownRequestError("internal db detail: SQLITE_CONSTRAINT secret", { code: "P2003", clientVersion: "test" })],
    ["PrismaClientUnknownRequestError", () => new Prisma.PrismaClientUnknownRequestError("internal db detail: unknown engine error", { clientVersion: "test" })],
  ])("%s → 500 CHAT_FAILED,不泄露内部细节", async (_name, factory) => {
    const server = await withBoomApp(factory);

    try {
      const res = await fetch(`${server.baseUrl}/boom`);
      expect(res.status).toBe(500);

      const body = (await res.json()) as {
        error: { code: string; message: string; requestId: string };
      };
      // §17:DATABASE_ERROR 是内部实现错误,Public 一律 CHAT_FAILED
      expect(body.error.code).toBe("CHAT_FAILED");
      expect(body.error.message).toBe("Chat request failed.");
      // 内部数据库错误细节不得出现在响应里
      expect(body.error.message).not.toContain("internal db detail");
      expect(body.error.message).not.toContain("SQLITE");
      // requestId 与响应头一致
      expect(body.error.requestId).toBe(res.headers.get("x-request-id"));
    } finally {
      await server.close();
    }
  });

  it("非数据库异常 → 500 CHAT_FAILED(INTERNAL_ERROR 不对外)", async () => {
    const server = await withBoomApp(() => new Error("some bug"));

    try {
      const res = await fetch(`${server.baseUrl}/boom`);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("CHAT_FAILED");
      expect(body.error.message).toBe("Chat request failed.");
    } finally {
      await server.close();
    }
  });

  it("§18:原始 code 与 message 只留在服务端日志,响应侧只剩通用码", async () => {
    const { logger, lines } = captureLogger();
    const server = await withBoomApp(
      () => new Prisma.PrismaClientKnownRequestError("raw db detail for admin only", { code: "P2002", clientVersion: "test" }),
      logger,
    );

    let text = "";
    try {
      const res = await fetch(`${server.baseUrl}/boom`);
      text = await res.text();
      expect(res.status).toBe(500);
    } finally {
      await server.close();
    }

    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      code: "DATABASE_ERROR",
      message: "Database error",
    });
    // 原始异常对象仍完整写日志
    expect(JSON.stringify(logged[0]!.err)).toContain("raw db detail for admin only");
    // 响应里既没有原始码也没有原始细节
    expect(text).not.toContain("DATABASE_ERROR");
    expect(text).not.toContain("raw db detail for admin only");
    expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe("CHAT_FAILED");
  });
});
