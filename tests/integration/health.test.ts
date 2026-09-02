import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";
import { REQUEST_ID_HEADER } from "../../src/config/constants.js";

describe("GET /api/health", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("HTTP 服务 + SQLite/Prisma 连接正常时返回 200 OK", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/health`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { status: string; database: string } };
    expect(body.data).toEqual({ status: "OK", database: "OK" });
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
  });
});
