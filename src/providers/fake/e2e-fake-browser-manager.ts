import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import type { Logger } from "../../common/logger/logger.js";
import type { BrowserDriver, BrowserPageHandle, BrowserProviderStatus } from "../gemini/browser-driver.js";
import { BrowserManager } from "../gemini/browser-manager.js";

/**
 * E2E 专用 BrowserManager。
 *
 * Fake provider 模式不能启动 Chromium 或导航 Gemini；Scheduler 仍通过同一
 * BrowserManager 状态接口完成 READY/BUSY/释放槽位生命周期。
 */
export class E2EFakeBrowserManager extends BrowserManager {
  private fakeStatus: BrowserProviderStatus = "READY";
  private readonly fakeStartedAt = new Date();

  constructor(logger: Logger) {
    const unusedDriver: BrowserDriver = {
      async launchPersistentContext(): Promise<never> {
        throw new Error("E2E fake BrowserManager must not launch a browser");
      },
    };
    super({
      driver: unusedDriver,
      profileDir: "<e2e-fake-provider>",
      headless: true,
      geminiBaseUrl: "https://fake-provider.invalid/app",
      logger,
    });
  }

  override getProviderName(): string {
    return "FAKE_E2E";
  }

  override getStatus(): BrowserProviderStatus {
    return this.fakeStatus;
  }

  override async openGemini(): Promise<BrowserProviderStatus> {
    this.fakeStatus = "READY";
    return this.fakeStatus;
  }

  override async ensureReady(): Promise<BrowserProviderStatus> {
    if (this.fakeStatus === "BUSY") return this.fakeStatus;
    this.fakeStatus = "READY";
    return this.fakeStatus;
  }

  override async start(): Promise<BrowserProviderStatus> {
    this.fakeStatus = "READY";
    return this.fakeStatus;
  }

  override async stop(): Promise<void> {
    this.fakeStatus = "STOPPED";
  }

  override async restart(): Promise<BrowserProviderStatus> {
    this.fakeStatus = "READY";
    return this.fakeStatus;
  }

  override setBusy(): void {
    this.fakeStatus = "BUSY";
  }

  override clearBusy(): void {
    if (this.fakeStatus === "BUSY") this.fakeStatus = "READY";
  }

  override peekGeminiPage(): BrowserPageHandle | null {
    return null;
  }

  override requireGeminiPage(): never {
    throw new AppError(ErrorCodes.PROVIDER_NOT_READY, "E2E fake provider has no browser page");
  }

  override takeProviderFault(): string | null {
    return null;
  }

  override getStartedAt(): Date | null {
    return this.fakeStatus === "STOPPED" ? null : this.fakeStartedAt;
  }

  override isRestarting(): boolean {
    return false;
  }

  override getLastBrowserError(): { code: string; message: string } | null {
    return null;
  }

  override getProfileDir(): string {
    return "<e2e-fake-provider>";
  }

  override isHeadless(): boolean {
    return true;
  }

  override async settleCloseEvents(timeoutMs: number): Promise<"crashed" | "page-closed" | "none"> {
    void timeoutMs;
    return "none";
  }
}
