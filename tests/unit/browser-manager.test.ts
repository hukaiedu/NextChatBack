import { describe, expect, it } from "vitest";

import type {
  BrowserContextHandle,
  BrowserPageHandle,
} from "../../src/providers/gemini/browser-driver.js";
import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { FakeDriver, createFakeManager } from "../fakes.js";

describe("BrowserManager 状态机(Fake Driver,不依赖真实浏览器/Google)", () => {
  it("初始状态 STOPPED", () => {
    const manager = createFakeManager(new FakeDriver());
    expect(manager.getStatus()).toBe("STOPPED");
  });

  it("STOPPED → STARTING → READY(默认已登录场景)", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);

    const status = await manager.openGemini();

    expect(driver.launchCount).toBe(1);
    expect(status).toBe("READY");
    expect(manager.getStatus()).toBe("READY");
  });

  it("STOPPED → STARTING → LOGIN_REQUIRED(重定向到 Google 登录页)", async () => {
    const driver = new FakeDriver();
    driver.redirectToLogin = true;
    const manager = createFakeManager(driver);

    const status = await manager.openGemini();

    expect(status).toBe("LOGIN_REQUIRED");
    expect(manager.getStatus()).toBe("LOGIN_REQUIRED");
  });

  it("同域但显示 Sign in 链接(未登录 Gemini 首页)→ LOGIN_REQUIRED", async () => {
    const driver = new FakeDriver();
    driver.sameOriginNotLoggedIn = true;
    const manager = createFakeManager(driver);

    const status = await manager.openGemini();

    expect(driver.latestContext?.lastPage?.url()).toContain("gemini.google.com");
    expect(status).toBe("LOGIN_REQUIRED");
  });

  it("重复 start / openGemini 不创建第二个 Persistent Context", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);

    await manager.start();
    await manager.start();
    await manager.openGemini();
    await manager.openGemini();

    expect(driver.launchCount).toBe(1);
    expect(manager.getStatus()).toBe("READY");
  });

  it("start 失败 → ERROR + PROVIDER_BROWSER_START_FAILED", async () => {
    const driver = new FakeDriver();
    driver.throwOnLaunch = new Error("boom: cannot launch chromium");
    const manager = createFakeManager(driver);

    await expect(manager.openGemini()).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_BROWSER_START_FAILED,
    });
    expect(manager.getStatus()).toBe("ERROR");
  });

  it("Profile 被占用 → ERROR + PROVIDER_PROFILE_IN_USE(不删除锁文件)", async () => {
    const driver = new FakeDriver();
    driver.throwOnLaunch = new Error("User data directory is already in use by another process");
    const manager = createFakeManager(driver);

    await expect(manager.openGemini()).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_PROFILE_IN_USE,
    });
    expect(manager.getStatus()).toBe("ERROR");
  });

  it("stop → STOPPED,Context 被关闭", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);
    await manager.openGemini();

    await manager.stop();

    expect(manager.getStatus()).toBe("STOPPED");
    expect(driver.latestContext?.closed).toBe(true);
  });

  it("stop 后再次 openGemini 会重新启动(单实例,新的 Context)", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);
    await manager.openGemini();
    await manager.stop();

    const status = await manager.openGemini();

    expect(driver.launchCount).toBe(2);
    expect(status).toBe("READY");
  });

  it("Gemini Page 被用户关闭:状态回 STOPPED,再次 openGemini 重建 Page 且不二次启动 Chromium", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);
    await manager.openGemini();
    expect(driver.launchCount).toBe(1);

    // 模拟用户关闭页面
    driver.latestContext!.lastPage!.emitClosed();
    expect(manager.getStatus()).toBe("STOPPED");

    // open 恢复:同一 Context,新建 Page,不再 launch
    const status = await manager.openGemini();
    expect(driver.launchCount).toBe(1);
    expect(status).toBe("READY");
  });

  it("Page crash → ERROR;再次 openGemini 可以恢复", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);
    await manager.openGemini();

    driver.latestContext!.lastPage!.emitCrashed();
    expect(manager.getStatus()).toBe("ERROR");

    const status = await manager.openGemini();
    expect(driver.launchCount).toBe(1);
    expect(status).toBe("READY");
  });

  it("Context 意外关闭(未主动 stop)→ STOPPED,可重新启动", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);
    await manager.openGemini();

    driver.latestContext!.emitClosed();
    expect(manager.getStatus()).toBe("STOPPED");

    const status = await manager.openGemini();
    expect(driver.launchCount).toBe(2);
    expect(status).toBe("READY");
  });

  it("restart:关闭 Context → 同一 Profile 重新启动 → 重新打开 Gemini", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);
    await manager.openGemini();
    expect(driver.launchCount).toBe(1);

    const status = await manager.restart();

    expect(driver.launchCount).toBe(2);
    expect(status).toBe("READY");
  });

  it("导航失败 → ERROR + PROVIDER_NAVIGATION_FAILED", async () => {
    const manager = createFakeManager(new ThrowingGotoDriver());

    await expect(manager.openGemini()).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_NAVIGATION_FAILED,
    });
    expect(manager.getStatus()).toBe("ERROR");
  });
});

/** goto 恒抛错的 Driver:模拟 Gemini 页面导航失败 */
class ThrowingGotoDriver extends FakeDriver {
  override async launchPersistentContext(): Promise<BrowserContextHandle> {
    const context = await super.launchPersistentContext();
    const original = context;
    return {
      isClosed: () => original.isClosed(),
      close: () => original.close(),
      onClose: (listener: () => void) => original.onClose(listener),
      async newPage(): Promise<BrowserPageHandle> {
        const page = await original.newPage();
        return new Proxy(page, {
          get(target, prop: string | symbol) {
            if (prop === "goto") {
              return async () => {
                throw new Error("net::ERR_NAME_NOT_RESOLVED");
              };
            }
            return Reflect.get(target, prop);
          },
        });
      },
    };
  }
}
