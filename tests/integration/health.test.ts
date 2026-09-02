import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import type { Express } from "express";

import { createApp } from "../../src/app.js";
import { createLogger } from "../../src/common/logger/logger.js";
import { REQUEST_ID_HEADER } from "../../src/config/constants.js";

const silentLogger = createLogger("silent");

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    ),
  );
});

async function listen(app: Express): Promise<{ baseUrl: string }> {
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);

  await new Promise<void>((resolve) => server.once("listening", resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to get listening port");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

describe("GET /api/health", () => {
  it("数据库正常时返回 200 OK", async () => {
    const { baseUrl } = await listen(
      createApp({
        probeDatabase: async () => undefined,
        logger: silentLogger,
      }),
    );

    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { status: string; database: string };
    };
    expect(body.data).toEqual({ status: "OK", database: "OK" });
  });

  it("数据库不可用时返回 503,不返回写死的 OK", async () => {
    const { baseUrl } = await listen(
      createApp({
        probeDatabase: async () => {
          throw new Error("sqlite connection refused");
        },
        logger: silentLogger,
      }),
    );

    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(503);

    const body = (await res.json()) as {
      data: { status: string; database: string };
    };
    expect(body.data).toEqual({ status: "ERROR", database: "DOWN" });
  });

  it("响应带有 x-request-id", async () => {
    const { baseUrl } = await listen(
      createApp({
        probeDatabase: async () => undefined,
        logger: silentLogger,
      }),
    );

    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
  });
});
