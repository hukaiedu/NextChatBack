import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import type { BrowserManager } from "../../src/providers/gemini/browser-manager.js";
import { FakeDriver, createFakeManager } from "../fakes.js";
import { setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

interface BrowserStatusData {
  state: string;
  provider: string;
  browserType: string;
  headless: boolean;
  profileDir: string;
  startedAt: string | null;
  uptimeMs: number | null;
  providerLoggedIn: boolean | null;
  activeRequests: number;
  lastError: { code: string; message: string } | null;
  observedAt: string;
}

interface StatusBody {
  data: BrowserStatusData;
}

interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

async function getStatus(baseUrl: string): Promise<BrowserStatusData> {
  const res = await fetch(`${baseUrl}/api/browser/status`);
  expect(res.status).toBe(200);
  return ((await res.json()) as StatusBody).data;
}

describe("Browser Status API", () => {
  // BrowserManager 是状态机,每个用例用全新的 driver + manager 避免状态串扰
  let ctx: TestContext;
  let driver: FakeDriver;
  let manager: BrowserManager;

  beforeEach(async () => {
    driver = new FakeDriver();
    manager = createFakeManager(driver);
    ctx = await setupTestContext({ browserManager: manager });
    await ctx.reset();
  });

  afterEach(async () => {
    await ctx.close();
  });

  it("GET /api/browser/status:STOPPED 快照(不启动浏览器)", async () => {
    const data = await getStatus(ctx.baseUrl);
    expect(data).toMatchObject({
      state: "STOPPED",
      provider: "GEMINI_WEB",
      browserType: "chromium",
      headless: true,
      profileDir: "./data/browser-profile",
      startedAt: null,
      uptimeMs: null,
      providerLoggedIn: null,
      activeRequests: 0,
      lastError: null,
    });
    expect(Number.isNaN(Date.parse(data.observedAt))).toBe(false);
    expect(driver.launchCount).toBe(0);
  });

  it("GET /api/browser/status:READY → RUNNING + providerLoggedIn true + 启动时间", async () => {
    await manager.openGemini();

    const data = await getStatus(ctx.baseUrl);
    expect(data.state).toBe("RUNNING");
    expect(data.providerLoggedIn).toBe(true);
    expect(data.startedAt).not.toBeNull();
    expect(data.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("GET /api/browser/status:LOGIN_REQUIRED → RUNNING + providerLoggedIn false", async () => {
    driver.redirectToLogin = true;
    await manager.openGemini();

    const data = await getStatus(ctx.baseUrl);
    expect(data.state).toBe("RUNNING");
    expect(data.providerLoggedIn).toBe(false);
  });

  it("GET /api/browser/status:PROCESSING 的 Request 计入 activeRequests", async () => {
    const conversation = await ctx.prisma.conversation.create({ data: { title: "t" } });
    const userMessage = await ctx.prisma.message.create({
      data: { conversationId: conversation.id, role: "USER", content: "hi", status: "COMPLETED", position: 0 },
    });
    const assistantMessage = await ctx.prisma.message.create({
      data: { conversationId: conversation.id, role: "ASSISTANT", content: "", status: "PENDING", position: 1 },
    });
    await ctx.prisma.modelRequest.create({
      data: {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        idempotencyKey: "browser-status-k1",
        requestFingerprint: "f1",
        status: "PROCESSING",
      },
    });

    const data = await getStatus(ctx.baseUrl);
    expect(data.activeRequests).toBe(1);
  });

  it("POST /api/browser/restart:STOPPED 直接重启(自愈路径)→ RUNNING", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/browser/restart`, { method: "POST" });
    expect(res.status).toBe(200);

    const data = ((await res.json()) as StatusBody).data;
    expect(data.state).toBe("RUNNING");
    expect(data.startedAt).not.toBeNull();
    expect(driver.launchCount).toBe(1);
  });

  it("POST /api/browser/restart:已运行时重启 → 关旧启新,startedAt 变新", async () => {
    await manager.openGemini();
    const before = await getStatus(ctx.baseUrl);

    const res = await fetch(`${ctx.baseUrl}/api/browser/restart`, { method: "POST" });
    expect(res.status).toBe(200);

    const after = ((await res.json()) as StatusBody).data;
    expect(after.state).toBe("RUNNING");
    expect(Date.parse(after.startedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(before.startedAt ?? ""));
    expect(driver.launchCount).toBe(2);
  });

  it("POST /api/browser/restart:有在飞 Request → 409 BROWSER_RESTART_CONFLICT", async () => {
    const conversation = await ctx.prisma.conversation.create({ data: { title: "t" } });
    const userMessage = await ctx.prisma.message.create({
      data: { conversationId: conversation.id, role: "USER", content: "hi", status: "COMPLETED", position: 0 },
    });
    const assistantMessage = await ctx.prisma.message.create({
      data: { conversationId: conversation.id, role: "ASSISTANT", content: "", status: "PENDING", position: 1 },
    });
    await ctx.prisma.modelRequest.create({
      data: {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        idempotencyKey: "browser-status-k2",
        requestFingerprint: "f2",
        status: "PROCESSING",
      },
    });

    const res = await fetch(`${ctx.baseUrl}/api/browser/restart`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe(ErrorCodes.BROWSER_RESTART_CONFLICT);
    expect(body.error.requestId).toBe(res.headers.get("x-request-id"));
    expect(driver.launchCount).toBe(0);
  });

  it("POST /api/browser/restart:BUSY → 409 BROWSER_RESTART_CONFLICT", async () => {
    await manager.openGemini();
    manager.setBusy();

    const res = await fetch(`${ctx.baseUrl}/api/browser/restart`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe(ErrorCodes.BROWSER_RESTART_CONFLICT);
  });

  it("POST /api/browser/restart:重启进行中 → 409 BROWSER_RESTART_CONFLICT", async () => {
    // launch 挂起期间 restart 一直处于 in-flight:第二次重启必须被拒
    driver.launchDelayMs = 50;
    const pending = manager.restart();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const res = await fetch(`${ctx.baseUrl}/api/browser/restart`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe(ErrorCodes.BROWSER_RESTART_CONFLICT);

    await pending;
    expect(driver.launchCount).toBe(1);
  });

  it("POST /api/browser/restart:启动失败 → 500 BROWSER_LAUNCH_FAILED,快照 FAILED + lastError", async () => {
    driver.throwOnLaunch = new Error("crash in launch");

    const res = await fetch(`${ctx.baseUrl}/api/browser/restart`, { method: "POST" });
    expect(res.status).toBe(500);
    expect(((await res.json()) as ErrorBody).error.code).toBe(ErrorCodes.BROWSER_LAUNCH_FAILED);

    const data = await getStatus(ctx.baseUrl);
    expect(data.state).toBe("FAILED");
    expect(data.lastError).toEqual({ code: ErrorCodes.PROVIDER_BROWSER_START_FAILED, message: "crash in launch" });
  });

  it("POST /api/browser/restart:Profile 被占用 → BROWSER_LAUNCH_FAILED,lastError 记 PROFILE_IN_USE", async () => {
    driver.throwOnLaunch = new Error("User data directory is already in use");

    const res = await fetch(`${ctx.baseUrl}/api/browser/restart`, { method: "POST" });
    expect(res.status).toBe(500);
    expect(((await res.json()) as ErrorBody).error.code).toBe(ErrorCodes.BROWSER_LAUNCH_FAILED);

    const data = await getStatus(ctx.baseUrl);
    expect(data.lastError?.code).toBe(ErrorCodes.PROVIDER_PROFILE_IN_USE);
  });

  it("POST /api/browser/restart:非启动阶段失败(导航)→ 500 BROWSER_RESTART_FAILED", async () => {
    driver.pageScript = { throwOnGoto: true };

    const res = await fetch(`${ctx.baseUrl}/api/browser/restart`, { method: "POST" });
    expect(res.status).toBe(500);
    expect(((await res.json()) as ErrorBody).error.code).toBe(ErrorCodes.BROWSER_RESTART_FAILED);

    const data = await getStatus(ctx.baseUrl);
    expect(data.state).toBe("FAILED");
  });

  it("POST /api/browser/restart:失败后重启成功 → lastError 清空,回 RUNNING", async () => {
    driver.throwOnLaunch = new Error("boom");
    const failed = await fetch(`${ctx.baseUrl}/api/browser/restart`, { method: "POST" });
    expect(failed.status).toBe(500);

    driver.throwOnLaunch = null;
    const res = await fetch(`${ctx.baseUrl}/api/browser/restart`, { method: "POST" });
    expect(res.status).toBe(200);

    const data = await getStatus(ctx.baseUrl);
    expect(data.state).toBe("RUNNING");
    expect(data.lastError).toBeNull();
  });
});
