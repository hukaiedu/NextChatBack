import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { FakeDriver, createFakeManager } from "../fakes.js";
import { ADMIN_AUTH, loginAdmin, setupTestContext, withAdminCookie } from "../helpers.js";
import type { TestContext } from "../helpers.js";

interface ProviderStatusBody {
  data: { provider: string; status: string };
}

describe("Provider API", () => {
  // BrowserManager 是状态机,每个用例用全新的 driver + manager 避免状态串扰
  let ctx: TestContext;
  let driver: FakeDriver;
  let cookie: string;

  /**
   * V1.3-B3-3 §26/§28:provider status/open/restart 属运维能力,
   * 自本轮起 ADMIN-only(§24 的 /api/provider/models 不在本文件,仍对匿名开放)。
   */
  async function api(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${ctx.baseUrl}${path}`, withAdminCookie(cookie, init));
  }

  beforeEach(async () => {
    driver = new FakeDriver();
    ctx = await setupTestContext({
      browserManager: createFakeManager(driver),
      auth: ADMIN_AUTH,
    });
    cookie = await loginAdmin(ctx.baseUrl);
  });

  afterEach(async () => {
    await ctx.close();
  });

  it("GET /api/provider/status:初始 STOPPED(不启动浏览器)", async () => {
    const res = await api("/api/provider/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProviderStatusBody;
    expect(body.data).toEqual({ provider: "GEMINI_WEB", status: "STOPPED" });
    expect(driver.launchCount).toBe(0);
  });

  it("POST /api/provider/open:未登录 → LOGIN_REQUIRED", async () => {
    driver.redirectToLogin = true;

    const res = await api("/api/provider/open", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProviderStatusBody;
    expect(body.data).toEqual({ provider: "GEMINI_WEB", status: "LOGIN_REQUIRED" });
    expect(driver.launchCount).toBe(1);
  });

  it("POST /api/provider/open:已登录 → READY,重复 open 不二次启动", async () => {
    const first = await api("/api/provider/open", { method: "POST" });
    expect(((await first.json()) as ProviderStatusBody).data.status).toBe("READY");
    expect(driver.launchCount).toBe(1);

    const second = await api("/api/provider/open", { method: "POST" });
    expect(((await second.json()) as ProviderStatusBody).data.status).toBe("READY");
    expect(driver.launchCount).toBe(1);
  });

  it("POST /api/provider/open:Profile 被占用 → 500 PROVIDER_PROFILE_IN_USE,状态 ERROR", async () => {
    driver.throwOnLaunch = new Error("User data directory is already in use");

    const res = await api("/api/provider/open", { method: "POST" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    // §32:ADMIN 的 HTTP 错误信封保留原始码 —— 运维要靠它区分「Profile 被占用」和其他启动失败
    expect(body.error.code).toBe(ErrorCodes.PROVIDER_PROFILE_IN_USE);
    expect(body.error.requestId).toBe(res.headers.get("x-request-id"));

    const status = await api("/api/provider/status");
    expect(((await status.json()) as ProviderStatusBody).data.status).toBe("ERROR");
  });

  it("POST /api/provider/open:启动失败 → 500 PROVIDER_BROWSER_START_FAILED", async () => {
    driver.throwOnLaunch = new Error("crash in launch");

    const res = await api("/api/provider/open", { method: "POST" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe(ErrorCodes.PROVIDER_BROWSER_START_FAILED);
  });

  it("POST /api/provider/restart:关闭 Context → 同一 Profile 重启 → READY", async () => {
    await api("/api/provider/open", { method: "POST" });
    expect(driver.launchCount).toBe(1);

    const res = await api("/api/provider/restart", { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ProviderStatusBody).data.status).toBe("READY");
    expect(driver.launchCount).toBe(2);
  });
});
