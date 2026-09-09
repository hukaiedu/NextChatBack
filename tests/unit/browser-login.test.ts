/**
 * P8 Provisioning CLI 单测(P8-CLI-01..06):runBrowserLogin 业务编排 ——
 * FakeDriver + 注入脚本化 checker 的 BrowserManager,不启动真实 Chromium/DB/HTTP。
 * Rev3.1 §33:openGemini 返回 ERROR 时进入有界重试(最多 maxErrorRetries 次)。
 * 进程信号与退出码不在 runBrowserLogin 契约内(main() 负责,entrypoint 守卫下
 * import 本模块不会触发浏览器 boot 副作用)。
 */
import { describe, expect, it } from "vitest";

import { createLogger } from "../../src/common/logger/logger.js";
import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { BrowserManager } from "../../src/providers/gemini/browser-manager.js";
import { GeminiSessionChecker } from "../../src/providers/gemini/session-checker.js";
import type { GeminiSessionState } from "../../src/providers/gemini/session-checker.js";
import { runBrowserLogin } from "../../src/scripts/browser-login.js";
import { FakeDriver, ScriptedSessionChecker } from "../fakes.js";

const GEMINI_BASE_URL = "https://gemini.google.com/app";
const silent = createLogger("silent");
const SETTLE = { timeoutMs: 120, pollMs: 10 };

/** 登录态由测试手动翻转(模拟管理员在 headed 窗口里完成 Google 登录) */
class ManualLoginChecker extends GeminiSessionChecker {
  calls = 0;
  loggedIn = false;

  constructor() {
    super(GEMINI_BASE_URL);
  }

  override async checkSessionState(): Promise<GeminiSessionState> {
    this.calls += 1;
    return this.loggedIn ? "AUTHENTICATED" : "UNAUTHENTICATED";
  }
}

function makeManager(driver: FakeDriver, checker: GeminiSessionChecker): BrowserManager {
  return new BrowserManager({
    driver,
    profileDir: "./data/browser-profile",
    headless: true,
    geminiBaseUrl: GEMINI_BASE_URL,
    logger: silent,
    sessionChecker: checker,
    postNavSettle: SETTLE,
  });
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("runBrowserLogin(P8-CLI)", () => {
  it("P8-CLI-01 打开即 READY(已登录)→ 直接返回 READY,不进入轮询;stop 关闭 context", async () => {
    const driver = new FakeDriver();
    const checker = new ManualLoginChecker();
    checker.loggedIn = true;
    const manager = makeManager(driver, checker);

    await expect(runBrowserLogin(manager, silent)).resolves.toBe("READY");

    expect(checker.calls).toBe(1); // openGemini 单次判定,无轮询
    expect(manager.getStatus()).toBe("READY");
    // main() 的收尾动作:graceful stop 关闭 persistent context(profile flush)
    await manager.stop();
    expect(manager.getStatus()).toBe("STOPPED");
    expect(driver.latestContext?.isClosed()).toBe(true);
  });

  it("P8-CLI-02 LOGIN_REQUIRED → 提示等待人工登录;登录完成后下一轮轮询 → READY", async () => {
    const driver = new FakeDriver();
    const checker = new ManualLoginChecker();
    const manager = makeManager(driver, checker);

    const outcome = runBrowserLogin(manager, silent, { pollIntervalMs: 10 });
    await waitFor(() => manager.getStatus() === "LOGIN_REQUIRED", "LOGIN_REQUIRED");
    const pollChecksAtFlip = checker.calls;
    // 模拟管理员在浏览器窗口内完成 Google 登录
    checker.loggedIn = true;

    await expect(outcome).resolves.toBe("READY");
    expect(manager.getStatus()).toBe("READY");
    // 进入过等待轮询(不是 openGemini 内直接 READY)
    expect(checker.calls).toBeGreaterThanOrEqual(pollChecksAtFlip + 1);
  });

  it("P8-CLI-03 等待登录期间收到终止信号 → CANCELLED(cleanup/exit 留给 main)", async () => {
    const driver = new FakeDriver();
    const checker = new ManualLoginChecker();
    const manager = makeManager(driver, checker);
    let cancelled = false;

    const outcome = runBrowserLogin(manager, silent, {
      pollIntervalMs: 10,
      isCancelled: () => cancelled,
    });
    await waitFor(() => manager.getStatus() === "LOGIN_REQUIRED", "LOGIN_REQUIRED");
    cancelled = true;

    await expect(outcome).resolves.toBe("CANCELLED");
    // runBrowserLogin 不负责 cleanup:context 仍开,由 main() 的 stopAndExit 收口
    expect(manager.getStatus()).toBe("LOGIN_REQUIRED");
  });

  it("P8-CLI-04 launch 失败 → 原样上抛,manager 收敛 ERROR(profile/lock 不删除)", async () => {
    const driver = new FakeDriver();
    driver.throwOnLaunch = new Error("Cannot find chromium executable");
    const manager = makeManager(driver, new ManualLoginChecker());

    await expect(runBrowserLogin(manager, silent)).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_BROWSER_START_FAILED,
    });

    expect(manager.getStatus()).toBe("ERROR");
    expect(manager.getLastBrowserError()?.code).toBe(ErrorCodes.PROVIDER_BROWSER_START_FAILED);
    expect(driver.launchCount).toBe(1);
  });

  it("P8-CLI-05 openGemini 返回 ERROR → 等待后重试 → READY(有界恢复,不抛错)", async () => {
    const driver = new FakeDriver();
    // 第一次 open:settle 第 2 次检查时页面 crash → settle 收敛为 ERROR 状态返回;
    // 重试(ERROR 自愈重建 context)后第二次 open 读到 AUTHENTICATED → READY
    const checker = new ScriptedSessionChecker(
      GEMINI_BASE_URL,
      ["INDETERMINATE", "INDETERMINATE", "AUTHENTICATED"],
      (call) => {
        if (call === 2) {
          driver.latestContext?.lastPage?.emitCrashed();
        }
      },
    );
    const manager = new BrowserManager({
      driver,
      profileDir: "./data/browser-profile",
      headless: true,
      geminiBaseUrl: GEMINI_BASE_URL,
      logger: silent,
      sessionChecker: checker,
      postNavSettle: SETTLE,
    });

    const outcome = await runBrowserLogin(manager, silent, {
      errorRetryDelayMs: 5,
      maxErrorRetries: 2,
    });

    expect(outcome).toBe("READY");
    expect(driver.launchCount).toBe(2); // ERROR 自愈触发了一次 context 重建
    expect(manager.getStatus()).toBe("READY");
  });

  it("P8-CLI-06 openGemini 持续 ERROR → 3 次尝试(初始+2 重试)后抛安全摘要,绝不无限重试", async () => {
    const driver = new FakeDriver();
    const crashOn = new Set([2, 4, 6]);
    const checker = new ScriptedSessionChecker(GEMINI_BASE_URL, ["INDETERMINATE"], (call) => {
      if (crashOn.has(call)) {
        driver.latestContext?.lastPage?.emitCrashed();
      }
    });
    const manager = new BrowserManager({
      driver,
      profileDir: "./data/browser-profile",
      headless: true,
      geminiBaseUrl: GEMINI_BASE_URL,
      logger: silent,
      sessionChecker: checker,
      postNavSettle: SETTLE,
    });

    await expect(
      runBrowserLogin(manager, silent, { errorRetryDelayMs: 5, maxErrorRetries: 2 }),
    ).rejects.toThrow(
      /gemini browser open failed: ERROR \(PROVIDER_BROWSER_CRASHED\); check network\/Gemini page state and re-run browser:login/,
    );

    expect(driver.launchCount).toBe(3); // 初始 + 2 次重试,不无限重启
    expect(manager.getStatus()).toBe("ERROR");
  });
});
