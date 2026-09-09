/**
 * P8-PROXY-03(Rev3.1 §40):共享 driver 工厂的结构约束测试 —— main 与 provisioning
 * CLI 都经 createDriver(env) 获得 proxy wiring,禁止各自 new PlaywrightBrowserDriver。
 * 工厂本身就是约束,故不 grep 源码文本;这里验证工厂产出的 driver 在 launch 时
 * 把 env.BROWSER_PROXY_URL 正确映射进 Playwright launch options。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("playwright", () => ({
  chromium: {
    launchPersistentContext: vi.fn(async () => ({ on: vi.fn() })),
  },
}));

import { chromium } from "playwright";

import { createDriver } from "../../src/providers/gemini/create-driver.js";

const PROFILE_DIR = "./data/browser-profile-p8";

describe("createDriver 共享工厂(P8-PROXY-03)", () => {
  function lastLaunchOptions(): Record<string, unknown> {
    const launch = chromium.launchPersistentContext as unknown as {
      mock: { calls: [string, Record<string, unknown>][] };
    };
    expect(launch.mock.calls).toHaveLength(1);
    return launch.mock.calls[0]?.[1] ?? {};
  }

  it("P8-PROXY-03a BROWSER_PROXY_URL 未配置 → 工厂 driver launch 无显式 proxy(Chromium 走系统配置)", async () => {
    const launch = chromium.launchPersistentContext as unknown as {
      mock: { calls: unknown[][] };
    };
    launch.mock.calls.length = 0;

    const driver = createDriver({});
    await driver.launchPersistentContext(PROFILE_DIR, { headless: true });

    expect(lastLaunchOptions()).not.toHaveProperty("proxy");
  });

  it("P8-PROXY-03b BROWSER_PROXY_URL 配置 → 工厂 driver launch 的 proxy.server 正确", async () => {
    const launch = chromium.launchPersistentContext as unknown as {
      mock: { calls: unknown[][] };
    };
    launch.mock.calls.length = 0;

    const driver = createDriver({ BROWSER_PROXY_URL: "http://127.0.0.1:7892" });
    await driver.launchPersistentContext(PROFILE_DIR, { headless: true });

    expect(lastLaunchOptions()).toMatchObject({
      proxy: { server: "http://127.0.0.1:7892" },
    });
  });
});
