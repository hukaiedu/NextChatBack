import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { FakeDriver, createFakeManager } from "../fakes.js";
import { setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

interface ProviderStatusBody {
  data: { provider: string; status: string };
}

describe("Provider API", () => {
  // BrowserManager 是状态机,每个用例用全新的 driver + manager 避免状态串扰
  let ctx: TestContext;
  let driver: FakeDriver;

  beforeEach(async () => {
    driver = new FakeDriver();
    ctx = await setupTestContext({ browserManager: createFakeManager(driver) });
  });

  afterEach(async () => {
    await ctx.close();
  });

  it("GET /api/provider/status:初始 STOPPED(不启动浏览器)", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/provider/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProviderStatusBody;
    expect(body.data).toEqual({ provider: "GEMINI_WEB", status: "STOPPED" });
    expect(driver.launchCount).toBe(0);
  });

  it("POST /api/provider/open:未登录 → LOGIN_REQUIRED", async () => {
    driver.redirectToLogin = true;

    const res = await fetch(`${ctx.baseUrl}/api/provider/open`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProviderStatusBody;
    expect(body.data).toEqual({ provider: "GEMINI_WEB", status: "LOGIN_REQUIRED" });
    expect(driver.launchCount).toBe(1);
  });

  it("POST /api/provider/open:已登录 → READY,重复 open 不二次启动", async () => {
    const first = await fetch(`${ctx.baseUrl}/api/provider/open`, { method: "POST" });
    expect(((await first.json()) as ProviderStatusBody).data.status).toBe("READY");
    expect(driver.launchCount).toBe(1);

    const second = await fetch(`${ctx.baseUrl}/api/provider/open`, { method: "POST" });
    expect(((await second.json()) as ProviderStatusBody).data.status).toBe("READY");
    expect(driver.launchCount).toBe(1);
  });

  it("POST /api/provider/open:Profile 被占用 → 500 PROVIDER_PROFILE_IN_USE,状态 ERROR", async () => {
    driver.throwOnLaunch = new Error("User data directory is already in use");

    const res = await fetch(`${ctx.baseUrl}/api/provider/open`, { method: "POST" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe(ErrorCodes.PROVIDER_PROFILE_IN_USE);
    expect(body.error.requestId).toBe(res.headers.get("x-request-id"));

    const status = await fetch(`${ctx.baseUrl}/api/provider/status`);
    expect(((await status.json()) as ProviderStatusBody).data.status).toBe("ERROR");
  });

  it("POST /api/provider/open:启动失败 → 500 PROVIDER_BROWSER_START_FAILED", async () => {
    driver.throwOnLaunch = new Error("crash in launch");

    const res = await fetch(`${ctx.baseUrl}/api/provider/open`, { method: "POST" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe(ErrorCodes.PROVIDER_BROWSER_START_FAILED);
  });

  it("POST /api/provider/restart:关闭 Context → 同一 Profile 重启 → READY", async () => {
    await fetch(`${ctx.baseUrl}/api/provider/open`, { method: "POST" });
    expect(driver.launchCount).toBe(1);

    const res = await fetch(`${ctx.baseUrl}/api/provider/restart`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ProviderStatusBody).data.status).toBe("READY");
    expect(driver.launchCount).toBe(2);
  });
});
