import { describe, expect, it } from "vitest";

import { AppError } from "../../src/common/errors/app-error.js";
import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { httpStatusForCode } from "../../src/common/errors/error-code-map.js";
import { FakeDriver, createFakeManager } from "../fakes.js";

/** 同步执行并捕获抛出的错误(不抛则返回 null) */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}

/**
 * ERROR-02 专项(ISSUE-04):PROVIDER_NOT_READY。
 *
 * 构造 BrowserManager 无可用 Page 且「非 LOGIN_REQUIRED」的场景:
 * 状态机是唯一真相源,requireGeminiPage 必须抛 PROVIDER_NOT_READY(→ HTTP 500),
 * 调用方(Adapter)不得绕过状态机直接取页。
 * 对照用例证明:同样是「无可用页面」,登录态走的是 PROVIDER_LOGIN_REQUIRED,
 * 二者不混淆。
 */
describe("ERROR-02 PROVIDER_NOT_READY 专项(ISSUE-04)", () => {
  it("无可用 Page 且非 LOGIN_REQUIRED(STOPPED)→ requireGeminiPage 抛 PROVIDER_NOT_READY", () => {
    const manager = createFakeManager(new FakeDriver());
    expect(manager.getStatus()).toBe("STOPPED");

    const err = captureError(() => manager.requireGeminiPage()) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe(ErrorCodes.PROVIDER_NOT_READY);
    // 明确不是 LOGIN_REQUIRED:本场景没有任何登录信号
    expect(err.code).not.toBe(ErrorCodes.PROVIDER_LOGIN_REQUIRED);
    expect(httpStatusForCode(ErrorCodes.PROVIDER_NOT_READY)).toBe(500);
  });

  it("Gemini Page 被用户关闭(回 STOPPED)→ requireGeminiPage 抛 PROVIDER_NOT_READY", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);
    await manager.openGemini();
    expect(manager.getStatus()).toBe("READY");

    driver.latestContext!.lastPage!.emitClosed();
    expect(manager.getStatus()).toBe("STOPPED");

    const err = captureError(() => manager.requireGeminiPage()) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe(ErrorCodes.PROVIDER_NOT_READY);
  });

  it("对照:LOGIN_REQUIRED 场景抛 PROVIDER_LOGIN_REQUIRED 而非 PROVIDER_NOT_READY", async () => {
    const driver = new FakeDriver();
    driver.redirectToLogin = true;
    const manager = createFakeManager(driver);
    await manager.openGemini();
    expect(manager.getStatus()).toBe("LOGIN_REQUIRED");

    const err = captureError(() => manager.requireGeminiPage()) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe(ErrorCodes.PROVIDER_LOGIN_REQUIRED);
    expect(err.code).not.toBe(ErrorCodes.PROVIDER_NOT_READY);
  });

  it("执行中(BUSY)调 openGemini → PROVIDER_NOT_READY(不导航毁掉进行中的生成)", async () => {
    const manager = createFakeManager(new FakeDriver());
    await manager.openGemini();
    manager.setBusy();
    expect(manager.getStatus()).toBe("BUSY");

    await expect(manager.openGemini()).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_NOT_READY,
    });
  });
});
