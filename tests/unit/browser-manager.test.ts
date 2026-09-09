import { describe, expect, it } from "vitest";

import type {
  BrowserContextHandle,
  BrowserPageHandle,
} from "../../src/providers/gemini/browser-driver.js";
import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { isGeminiChatUrl } from "../../src/providers/gemini/session-checker.js";
import { BrowserManager } from "../../src/providers/gemini/browser-manager.js";
import { createLogger } from "../../src/common/logger/logger.js";
import {
  FakeDriver,
  ScriptedSessionChecker,
  createFakeManager,
  FAKE_CONVERSATION_URL,
} from "../fakes.js";

const BASE_URL = "https://gemini.google.com/app";

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

    // ERROR 自愈:ensureGeminiPage 先 closeContext 再重建,所以 launchCount +1
    const status = await manager.openGemini();
    expect(driver.launchCount).toBe(2);
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

describe("isGeminiChatUrl(纯函数,P2 零导航判据)", () => {
  it("接受 /app 与 /app/<conversationId>,拒绝外域、非聊天路径、坏 URL 与 /u/N 形态", () => {
    expect(isGeminiChatUrl(BASE_URL, BASE_URL)).toBe(true);
    expect(isGeminiChatUrl(FAKE_CONVERSATION_URL, BASE_URL)).toBe(true);
    expect(isGeminiChatUrl(`${BASE_URL}/`, BASE_URL)).toBe(true);
    expect(isGeminiChatUrl("https://gemini.google.com/gems", BASE_URL)).toBe(false);
    expect(isGeminiChatUrl("https://accounts.google.com/app", BASE_URL)).toBe(false);
    expect(isGeminiChatUrl("about:blank", BASE_URL)).toBe(false);
    // FIX-01:/u/N/app 多账号形态不在本阶段支持范围(避免两套 URL 语义)
    expect(isGeminiChatUrl("https://gemini.google.com/u/1/app", BASE_URL)).toBe(false);
  });
});

describe("BrowserManager.ensureReady(Provider Gate 零导航,P2)", () => {
  it("BM-ER-00 冷启动(页缺失):新建页 + 恰一次 goto 首页 → READY", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);

    const status = await manager.ensureReady();

    expect(status).toBe("READY");
    expect(driver.launchCount).toBe(1);
    expect(driver.latestContext!.lastPage!.gotoCalls).toEqual([BASE_URL]);
  });

  it("BM-ER-A 健康 Gemini 聊天页(会话页)ensureReady 零导航直达 READY", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);
    await manager.openGemini();
    const page = driver.latestContext!.lastPage!;
    // 模拟上一轮执行后页面停在某个会话(真实落点不经 goto)
    page.currentUrl = FAKE_CONVERSATION_URL;

    const status = await manager.ensureReady();

    expect(status).toBe("READY");
    expect(page.gotoCalls).toEqual([BASE_URL]);
    expect(manager.requireGeminiPage()).toBe(page);
  });

  it("BM-ER-A2 页面漂到同域非聊天路径 → fallback 恰一次 goto 回首页", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);
    await manager.openGemini();
    const page = driver.latestContext!.lastPage!;
    page.currentUrl = "https://gemini.google.com/gems";

    const status = await manager.ensureReady();

    expect(status).toBe("READY");
    expect(page.gotoCalls).toEqual([BASE_URL, BASE_URL]);
  });

  it("BM-ER-B 聊天页上登录检查失败 → fallback goto 后仍 false → LOGIN_REQUIRED(恰一次 fallback 导航)", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);
    await manager.openGemini();
    const page = driver.latestContext!.lastPage!;
    page.currentUrl = FAKE_CONVERSATION_URL;
    page.showSignInLink = true; // 登录态失效:无 composer、有 Sign in 链接

    const status = await manager.ensureReady();

    // FIX-04:一次 check=false 不定案,必须先 fallback 导航,导航后仍 false 才 LOGIN_REQUIRED
    expect(status).toBe("LOGIN_REQUIRED");
    expect(page.gotoCalls).toEqual([BASE_URL, BASE_URL]);
  });

  it("BM-ER-C 会话检查抛关闭族 + goto 恒抛(断连竞态)→ NAVIGATION_FAILED,不误报 LOGIN_REQUIRED", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);
    await manager.openGemini();
    const page = driver.latestContext!.lastPage!;
    page.currentUrl = FAKE_CONVERSATION_URL;
    page.countElements = async () => {
      throw new Error("Target page, context or browser has been closed");
    };
    page.goto = async () => {
      throw new Error("Target page, context or browser has been closed");
    };

    await expect(manager.ensureReady()).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_NAVIGATION_FAILED,
    });
    expect(manager.getStatus()).toBe("ERROR");
  });

  it("BM-ER-D BUSY 状态下 ensureReady 与 openGemini 均抛 PROVIDER_NOT_READY", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);
    await manager.openGemini();
    manager.setBusy();

    await expect(manager.ensureReady()).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_NOT_READY,
    });
    await expect(manager.openGemini()).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_NOT_READY,
    });
    expect(driver.latestContext!.lastPage!.gotoCalls).toEqual([BASE_URL]);
  });

  it("BM-ER-E 页面 crash → ERROR;ensureReady 走自愈重启恢复 READY", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);
    await manager.openGemini();
    driver.latestContext!.lastPage!.emitCrashed();
    expect(manager.getStatus()).toBe("ERROR");

    const status = await manager.ensureReady();

    expect(status).toBe("READY");
    expect(driver.launchCount).toBe(2);
    expect(driver.latestContext!.lastPage!.gotoCalls).toEqual([BASE_URL]);
  });

  it("BM-ER-F 页面被用户关闭 → STOPPED;ensureReady 同 Context 重建页(不二次 launch)", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);
    await manager.openGemini();
    driver.latestContext!.lastPage!.emitClosed();
    expect(manager.getStatus()).toBe("STOPPED");

    const status = await manager.ensureReady();

    expect(status).toBe("READY");
    expect(driver.launchCount).toBe(1);
    expect(driver.latestContext!.lastPage!.gotoCalls).toEqual([BASE_URL]);
  });

  it("BM-ER-G openGemini/restart 语义回归:页面健康时仍强制导航首页", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);
    await manager.openGemini();
    await manager.ensureReady(); // 零导航
    expect(driver.latestContext!.lastPage!.gotoCalls).toEqual([BASE_URL]);

    await manager.openGemini();
    expect(driver.latestContext!.lastPage!.gotoCalls).toEqual([BASE_URL, BASE_URL]);

    await manager.restart();
    expect(driver.launchCount).toBe(2);
    expect(driver.latestContext!.lastPage!.gotoCalls).toEqual([BASE_URL]);
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

/**
 * P8-FIX-01/Rev3.1:Post-navigation Session Stabilization —— 导航后 SPA 水合窗口内
 * 消费三态:GeminiSessionChecker INDETERMINATE→AUTHENTICATED 时最终 READY;
 * 稳定 UNAUTHENTICATED 至 deadline 才定案 LOGIN_REQUIRED(20s min-age 语义由
 * P8-AUTH-04 缩短参数覆盖);settle 中 page 生命周期故障不得被伪装成登录失效
 * (P8-SESSION-01..03b);INDETERMINATE 窗口耗尽定案 ERROR(P8-AUTH-06/07)。
 */
describe("BrowserManager post-navigation stabilization(P8-FIX-01)", () => {
  const silent = createLogger("silent");
  const SETTLE = { timeoutMs: 150, pollMs: 10 };

  function makeManager(
    driver: FakeDriver,
    checker: ScriptedSessionChecker,
    settle?: Partial<{
      timeoutMs: number;
      pollMs: number;
      minUnauthConfirmElapsedMs: number;
      unauthStabilityRounds: number;
    }>,
  ): BrowserManager {
    return new BrowserManager({
      driver,
      profileDir: "./data/browser-profile",
      headless: true,
      geminiBaseUrl: BASE_URL,
      logger: silent,
      sessionChecker: checker,
      postNavSettle: { ...SETTLE, ...settle },
    });
  }

  it("P8-SESSION-01 水合窗口内 INDETERMINATE×2 → AUTHENTICATED → 最终 READY,不出现最终 LOGIN_REQUIRED", async () => {
    const driver = new FakeDriver();
    const checker = new ScriptedSessionChecker(BASE_URL, [
      "INDETERMINATE",
      "INDETERMINATE",
      "AUTHENTICATED",
    ]);
    const manager = makeManager(driver, checker);

    const status = await manager.openGemini();

    expect(status).toBe("READY");
    expect(manager.getStatus()).toBe("READY");
    expect(checker.calls).toBeGreaterThanOrEqual(3);
    // 稳定化不引入二次导航:仍恰一次 goto 首页
    expect(driver.latestContext!.lastPage!.gotoCalls).toEqual([BASE_URL]);
  });

  it("P8-SESSION-02 checker 持续 UNAUTHENTICATED 至 settle deadline → 最终 LOGIN_REQUIRED(有界轮询后定案)", async () => {
    const driver = new FakeDriver();
    const checker = new ScriptedSessionChecker(BASE_URL, ["UNAUTHENTICATED"]);
    const manager = makeManager(driver, checker);

    const status = await manager.openGemini();

    expect(status).toBe("LOGIN_REQUIRED");
    expect(manager.getStatus()).toBe("LOGIN_REQUIRED");
    // 轮询确实发生过(不是 goto 后一次判定)
    expect(checker.calls).toBeGreaterThanOrEqual(2);
    expect(driver.latestContext!.lastPage!.gotoCalls).toEqual([BASE_URL]);
  });

  it("P8-SESSION-03a settle 期间 page close → STOPPED,不得最终 LOGIN_REQUIRED", async () => {
    const driver = new FakeDriver();
    const checker = new ScriptedSessionChecker(BASE_URL, ["INDETERMINATE"], (call) => {
      if (call === 2) {
        driver.latestContext?.lastPage?.emitClosed();
      }
    });
    const manager = makeManager(driver, checker);

    const status = await manager.openGemini();

    expect(status).toBe("STOPPED");
    expect(manager.getStatus()).toBe("STOPPED");
  });

  it("P8-SESSION-03b settle 期间 page crash → ERROR,不得最终 LOGIN_REQUIRED", async () => {
    const driver = new FakeDriver();
    const checker = new ScriptedSessionChecker(BASE_URL, ["INDETERMINATE"], (call) => {
      if (call === 2) {
        driver.latestContext?.lastPage?.emitCrashed();
      }
    });
    const manager = makeManager(driver, checker);

    const status = await manager.openGemini();

    expect(status).toBe("ERROR");
    expect(manager.getStatus()).toBe("ERROR");
  });

  it("P8-AUTH-04 guest 稳定 UNAUTHENTICATED:min-age 前不定案,elapsed ≥ min-age 且连续轮数达标才 LOGIN_REQUIRED", async () => {
    const driver = new FakeDriver();
    // 缩短参数:min-age 150ms 前只累计证据;连续 3 轮且过 min-age 才定案
    const checker = new ScriptedSessionChecker(BASE_URL, ["UNAUTHENTICATED"]);
    const manager = makeManager(driver, checker, {
      timeoutMs: 1_000,
      pollMs: 10,
      minUnauthConfirmElapsedMs: 150,
      unauthStabilityRounds: 3,
    });
    const startedAt = Date.now();

    const status = await manager.openGemini();

    expect(status).toBe("LOGIN_REQUIRED");
    // 不是 goto 后首轮立即定案:至少等满 min-age(150ms)才 LOGIN_REQUIRED
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140);
    expect(driver.latestContext!.lastPage!.gotoCalls).toEqual([BASE_URL]);
  });

  it("P8-AUTH-05 UNAUTHENTICATED→INDETERMINATE→AUTHENTICATED → 最终 READY,从不最终 LOGIN_REQUIRED", async () => {
    const driver = new FakeDriver();
    // Tier-1 短暂出现(UNAUTH)→ 水合回 INDETERMINATE 清零计数 → 登录完成
    const checker = new ScriptedSessionChecker(BASE_URL, [
      "UNAUTHENTICATED",
      "INDETERMINATE",
      "AUTHENTICATED",
    ]);
    const manager = makeManager(driver, checker);

    const status = await manager.openGemini();

    expect(status).toBe("READY");
    expect(manager.getStatus()).toBe("READY");
    expect(checker.calls).toBeGreaterThanOrEqual(3);
    expect(driver.latestContext!.lastPage!.gotoCalls).toEqual([BASE_URL]);
  });

  it("P8-AUTH-06 INDETERMINATE/UNAUTHENTICATED 交替至 deadline → ERROR(非连续 Tier-1 不累加成稳定证据)", async () => {
    const driver = new FakeDriver();
    // Tier-1 只短暂出现一轮(UNAUTH),前后都是水合未定(INDETERMINATE)→ 连续计数清零
    const checker = new ScriptedSessionChecker(BASE_URL, [
      "INDETERMINATE",
      "UNAUTHENTICATED",
      "INDETERMINATE",
    ]);
    const manager = makeManager(driver, checker);

    const status = await manager.openGemini();

    expect(status).toBe("ERROR");
    expect(manager.getStatus()).toBe("ERROR");
    expect(manager.getLastBrowserError()?.code).toBe("PROVIDER_SESSION_INDETERMINATE");
  });

  it("P8-AUTH-07 纯 INDETERMINATE 至 deadline → ERROR + PROVIDER_SESSION_INDETERMINATE,绝不 LOGIN_REQUIRED", async () => {
    const driver = new FakeDriver();
    const checker = new ScriptedSessionChecker(BASE_URL, ["INDETERMINATE"]);
    const manager = makeManager(driver, checker);

    const status = await manager.openGemini();

    expect(status).toBe("ERROR");
    expect(manager.getStatus()).toBe("ERROR");
    expect(manager.getLastBrowserError()?.code).toBe("PROVIDER_SESSION_INDETERMINATE");
  });

  it("P8-AUTH-08 ifNeeded 上 INDETERMINATE → 不零导航,fallback goto 后 AUTHENTICATED → READY", async () => {
    const driver = new FakeDriver();
    // call1 = openGemini settle(AUTH → READY);call2 = ifNeeded 检查(INDETERMINATE);
    // call3 = fallback goto 后 settle(AUTH → READY)
    const checker = new ScriptedSessionChecker(BASE_URL, [
      "AUTHENTICATED",
      "INDETERMINATE",
      "AUTHENTICATED",
    ]);
    const manager = makeManager(driver, checker);
    await manager.openGemini();
    const page = driver.latestContext!.lastPage!;
    page.currentUrl = FAKE_CONVERSATION_URL;

    const status = await manager.ensureReady();

    expect(status).toBe("READY");
    expect(page.gotoCalls).toEqual([BASE_URL, BASE_URL]);
  });

  it("P8-AUTH-09 ifNeeded 上 UNAUTHENTICATED → fallback 前不最终定案;goto 后按 settle 语义 LOGIN_REQUIRED", async () => {
    const driver = new FakeDriver();
    const checker = new ScriptedSessionChecker(BASE_URL, ["AUTHENTICATED", "UNAUTHENTICATED"]);
    const manager = makeManager(driver, checker);
    await manager.openGemini();
    const page = driver.latestContext!.lastPage!;
    page.currentUrl = FAKE_CONVERSATION_URL;

    const status = await manager.ensureReady();

    // 恰一次 fallback 导航:证明若 ifNeeded 时提前定案就不会有第二次 goto
    expect(status).toBe("LOGIN_REQUIRED");
    expect(page.gotoCalls).toEqual([BASE_URL, BASE_URL]);
  });

  it("checkGeminiSession 保持单次检测(不引入稳定化等待):未登录页单次 UNAUTHENTICATED → LOGIN_REQUIRED", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);
    await manager.openGemini();
    const page = driver.latestContext!.lastPage!;
    page.currentUrl = FAKE_CONVERSATION_URL;
    page.showSignInLink = true;

    const status = await manager.checkGeminiSession();

    expect(status).toBe("LOGIN_REQUIRED");
  });
});
