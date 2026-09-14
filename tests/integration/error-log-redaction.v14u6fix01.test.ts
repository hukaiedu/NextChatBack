import type { Server } from "node:http";
import { Writable } from "node:stream";

import express from "express";
import type { Express } from "express";
import pino from "pino";
import type { Logger } from "pino";
import { describe, expect, it } from "vitest";

import { errorHandler } from "../../src/common/middleware/error-handler.js";
import { requestId } from "../../src/common/middleware/request-id.js";

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

async function withJsonParserApp(logger: Logger, boomError?: Error): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const app: Express = express();
  app.use(requestId());
  app.use(express.json());
  for (const path of ["/api/auth/register", "/api/auth/password/change", "/api/conversations"]) {
    app.post(path, (_req, res) => res.status(204).end());
  }
  if (boomError !== undefined) {
    app.get("/boom", () => {
      throw boomError;
    });
  }
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

async function flushLogger(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("U6-FIX-01 error log redaction", () => {
  it("real Express JSON parser: malformed register/password-change/generic body is not logged", async () => {
    const { logger, lines } = captureLogger();
    const server = await withJsonParserApp(logger);
    const registerMarker = `FAULT_REGISTER_PASSWORD_${Date.now()}`;
    const currentMarker = `U6_FIX01_CURRENT_${Date.now()}`;
    const newMarker = `U6_FIX01_NEW_${Date.now()}`;
    const genericMarker = `U6_FIX01_GENERIC_${Date.now()}`;
    const cases = [
      {
        path: "/api/auth/register",
        body: `{"username":"fault-user","password":"${registerMarker}"`,
        forbidden: [registerMarker],
      },
      {
        path: "/api/auth/password/change",
        body: `{"currentPassword":"${currentMarker}","newPassword":"${newMarker}"`,
        forbidden: [currentMarker, newMarker],
      },
      {
        path: "/api/conversations",
        body: `{"note":"${genericMarker}"`,
        forbidden: [genericMarker],
      },
    ];

    try {
      for (const testCase of cases) {
        const res = await fetch(`${server.baseUrl}${testCase.path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: testCase.body,
        });
        expect(res.status).toBe(400);
        const response = (await res.json()) as {
          error: { code: string; requestId: string };
        };
        expect(response.error.code).toBe("VALIDATION_ERROR");
        expect(response.error.requestId).toBe(res.headers.get("x-request-id"));
      }
      await flushLogger();
    } finally {
      await server.close();
    }

    const logged = lines.join("");
    expect(logged).toContain('"msg":"request failed"');
    expect(logged).toContain('"type":"SyntaxError"');
    expect(logged).toContain('"statusCode":400');
    expect(logged).not.toContain("password");
    expect(logged).not.toContain("currentPassword");
    expect(logged).not.toContain("newPassword");
    expect(logged).not.toContain("rawBody");
    for (const testCase of cases) {
      for (const forbidden of testCase.forbidden) {
        expect(logged).not.toContain(forbidden);
      }
      expect(logged).not.toContain(testCase.body);
    }
  });

  it("nested Error.cause is projected safely without mutating the original error", async () => {
    const { logger, lines } = captureLogger();
    const marker = `NESTED_SECRET_${Date.now()}`;
    const cause = new Error("parser failed");
    Object.defineProperty(cause, "body", {
      value: `{"password":"${marker}"`,
      enumerable: true,
    });
    const outer = new Error("request failed", { cause });
    const server = await withJsonParserApp(logger, outer);

    try {
      const res = await fetch(`${server.baseUrl}/boom`);
      expect(res.status).toBe(500);
      await res.text();
      await flushLogger();
    } finally {
      await server.close();
    }

    expect(cause).toHaveProperty("body", `{"password":"${marker}"`);
    const logged = lines.join("");
    expect(logged).toContain("request failed");
    expect(logged).toContain("parser failed");
    expect(logged).not.toContain(marker);
    expect(logged).not.toContain('"body"');
  });
});
