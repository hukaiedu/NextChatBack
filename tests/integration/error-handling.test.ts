import type { Server } from "node:http";

import express from "express";
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "../../src/common/logger/logger.js";
import { errorHandler } from "../../src/common/middleware/error-handler.js";
import { requestId } from "../../src/common/middleware/request-id.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

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
  async function withBoomApp(throwingError: () => Error): Promise<{
    baseUrl: string;
    close(): Promise<void>;
  }> {
    const app: Express = express();
    app.use(requestId());
    app.get("/boom", () => {
      throw throwingError();
    });
    app.use(errorHandler(createLogger("silent")));

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
  ])("%s → 500 DATABASE_ERROR,不泄露内部细节", async (_name, factory) => {
    const server = await withBoomApp(factory);

    try {
      const res = await fetch(`${server.baseUrl}/boom`);
      expect(res.status).toBe(500);

      const body = (await res.json()) as {
        error: { code: string; message: string; requestId: string };
      };
      expect(body.error.code).toBe("DATABASE_ERROR");
      expect(body.error.message).toBe("Database error");
      // 内部数据库错误细节不得出现在响应里
      expect(body.error.message).not.toContain("internal db detail");
      expect(body.error.message).not.toContain("SQLITE");
      // requestId 与响应头一致
      expect(body.error.requestId).toBe(res.headers.get("x-request-id"));
    } finally {
      await server.close();
    }
  });

  it("非数据库异常保持 500 INTERNAL_ERROR(回归)", async () => {
    const server = await withBoomApp(() => new Error("some bug"));

    try {
      const res = await fetch(`${server.baseUrl}/boom`);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INTERNAL_ERROR");
    } finally {
      await server.close();
    }
  });
});
