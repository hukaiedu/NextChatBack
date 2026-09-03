import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import type { Logger } from "../../common/logger/logger.js";
import type {
  BrowserContextHandle,
  BrowserDriver,
  BrowserPageHandle,
  BrowserProviderStatus,
} from "./browser-driver.js";
import { GeminiSessionChecker } from "./session-checker.js";
import { normalizeConversationUrl } from "./gemini.selectors.js";

export interface BrowserManagerOptions {
  driver: BrowserDriver;
  profileDir: string;
  headless: boolean;
  geminiBaseUrl: string;
  logger: Logger;
  sessionChecker?: GeminiSessionChecker;
}

/**
 * 第 3 阶段:Browser Manager(进程内单实例,由 main.ts 创建并注入)。
 *
 * 负责:
 * - Persistent Context 生命周期(一个进程一个,launchPersistentContext)
 * - Gemini Page 管理(可重建)
 * - Browser/Context/Page 异常监听与真实状态维护
 * - Gemini 登录状态检测(URL 级,第 3 阶段)
 *
 * 不做:发送 Prompt / DOM Selector / Scheduler / SSE。
 */
export class BrowserManager {
  private state: BrowserProviderStatus = "STOPPED";
  private context: BrowserContextHandle | null = null;
  private page: BrowserPageHandle | null = null;
  /** 主动 stop 中:防止 context close 事件把状态覆盖成意外关闭 */
  private stopping = false;

  private readonly checker: GeminiSessionChecker;

  /** 简单互斥:串行化 start/open/restart/stop,防止并发重复启动 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: BrowserManagerOptions) {
    this.checker =
      options.sessionChecker ?? new GeminiSessionChecker(options.geminiBaseUrl);
  }

  getProviderName(): string {
    return "GEMINI_WEB";
  }

  /** 当前状态(事件驱动 + 惰性校正) */
  getStatus(): BrowserProviderStatus {
    // 防御:context/page 意外消失而事件未触达时,惰性校正
    if (!this.stopping) {
      if (this.context && this.context.isClosed()) {
        this.logger.warn({ from: this.state }, "browser context found closed");
        this.context = null;
        this.page = null;
        this.state = "STOPPED";
      } else if (this.page && this.page.isClosed()) {
        this.logger.info("gemini page found closed");
        this.page = null;
        this.state = "STOPPED";
      }
    }
    return this.state;
  }

  /** 启动浏览器并打开/聚焦 Gemini 页面,返回最终状态(READY / LOGIN_REQUIRED) */
  async openGemini(): Promise<BrowserProviderStatus> {
    return this.runExclusive(async () => {
      await this.ensureContextStarted();
      return this.ensureGeminiPage();
    });
  }

  /**
   * 启动 Persistent Context(幂等):
   * 重复调用不会创建第二个 Context,也不会启动第二个 Chromium。
   */
  async start(): Promise<BrowserProviderStatus> {
    return this.runExclusive(async () => {
      await this.ensureContextStarted();
      return this.getStatus();
    });
  }

  /** 关闭 Context 并释放,回到 STOPPED */
  async stop(): Promise<void> {
    await this.runExclusive(async () => {
      if (this.state === "STOPPED" && !this.context) {
        return;
      }
      await this.closeContext("browser stop requested");
    });
  }

  /** 关闭当前 Context → 用同一个 Persistent Profile 重新启动 → 重新打开 Gemini */
  async restart(): Promise<BrowserProviderStatus> {
    return this.runExclusive(async () => {
      await this.closeContext("browser restart requested");
      await this.ensureContextStarted();
      return this.ensureGeminiPage();
    });
  }

  /** 重新检测当前 Gemini 页面登录状态(不导航,不打断用户) */
  async checkGeminiSession(): Promise<BrowserProviderStatus> {
    if (!this.context || this.context.isClosed()) {
      this.state = "STOPPED";
      return this.state;
    }
    if (!this.page || this.page.isClosed()) {
      this.logger.info("gemini page closed while checking session");
      this.page = null;
      this.state = "STOPPED";
      return this.state;
    }
    return this.refreshStatusFromPage();
  }

  /**
   * 取出当前可用的 Gemini Page(第 4 阶段 Adapter 唯一入口)。
   * 状态机是唯一真相源:非 READY 一律抛出对应错误码,调用方不得绕过。
   */
  requireGeminiPage(): BrowserPageHandle {
    const status = this.getStatus();
    if (status === "LOGIN_REQUIRED") {
      throw new AppError(ErrorCodes.PROVIDER_LOGIN_REQUIRED, "Gemini login is required", 500);
    }
    const page = this.page;
    if (!page || page.isClosed() || status !== "READY") {
      throw new AppError(ErrorCodes.PROVIDER_NOT_READY, "Gemini page is not ready", 500);
    }
    return page;
  }

  /** 第 5 阶段进入业务时置 BUSY;本阶段枚举先建立 */
  setBusy(): void {
    this.transitionTo("BUSY");
  }

  clearBusy(): void {
    if (this.state === "BUSY") {
      this.transitionTo("READY");
    }
  }

  // ---------------------------------------------------------------------------
  // 内部实现
  // ---------------------------------------------------------------------------

  private get logger(): Logger {
    return this.options.logger;
  }

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private transitionTo(next: BrowserProviderStatus, message?: string): void {
    const from = this.state;
    if (from === next) {
      return;
    }
    if (message) {
      this.logger.info({ from, to: next }, message);
    }
    this.state = next;
  }

  private async ensureContextStarted(): Promise<void> {
    if (this.context && !this.context.isClosed()) {
      return;
    }
    if (this.state === "STARTING") {
      return;
    }

    const startedAt = Date.now();
    this.transitionTo("STARTING", "browser start");
    try {
      const started = await this.options.driver.launchPersistentContext(
        this.options.profileDir,
        { headless: this.options.headless },
      );
      this.context = started;
      this.page = null;
      this.bindContextEvents(started);
      this.logger.info(
        { profileDir: this.options.profileDir, elapsedMs: Date.now() - startedAt },
        "browser ready",
      );
    } catch (err) {
      this.context = null;
      this.page = null;
      this.transitionTo("ERROR");
      if (isProfileInUseError(err)) {
        this.logger.error({ err }, "browser profile is in use by another process");
        throw new AppError(
          ErrorCodes.PROVIDER_PROFILE_IN_USE,
          "Browser profile is in use by another process",
          500,
          err,
        );
      }
      this.logger.error({ err }, "browser start failed");
      throw new AppError(
        ErrorCodes.PROVIDER_BROWSER_START_FAILED,
        "Failed to start browser",
        500,
        err,
      );
    }
  }

  private bindContextEvents(handle: BrowserContextHandle): void {
    handle.onClose(() => {
      if (this.stopping) {
        return;
      }
      this.logger.warn({ from: this.state }, "browser context closed unexpectedly");
      this.context = null;
      this.page = null;
      this.transitionTo("STOPPED");
    });
  }

  /** 确保存在可用 Gemini Page 并完成导航与登录检测 */
  private async ensureGeminiPage(): Promise<BrowserProviderStatus> {
    const context = this.context;
    if (!context || context.isClosed()) {
      throw new AppError(ErrorCodes.PROVIDER_NOT_READY, "Browser is not ready", 500);
    }

    let page = this.page;
    if (!page || page.isClosed()) {
      page = await context.newPage();
      this.bindPageEvents(page);
      this.page = page;
      this.logger.info("gemini page created");
    }

    try {
      await page.bringToFront();
      await page.goto(this.options.geminiBaseUrl);
    } catch (err) {
      this.transitionTo("ERROR", "gemini navigation failed");
      this.logger.error({ err }, "failed to open gemini page");
      throw new AppError(
        ErrorCodes.PROVIDER_NAVIGATION_FAILED,
        "Failed to open Gemini page",
        500,
        err,
      );
    }

    this.logger.info(
      { url: normalizeConversationUrl(page.url()) ?? "(unparseable)" },
      "gemini page open",
    );
    return this.refreshStatusFromPage();
  }

  private bindPageEvents(page: BrowserPageHandle): void {
    page.onClose(() => {
      if (this.stopping || this.page !== page) {
        return;
      }
      this.logger.info({ from: this.state }, "gemini page closed");
      this.page = null;
      this.transitionTo("STOPPED");
    });
    page.onCrash(() => {
      if (this.stopping || this.page !== page) {
        return;
      }
      this.logger.error(
        { code: ErrorCodes.PROVIDER_PAGE_CRASHED },
        "gemini page crashed",
      );
      this.page = null;
      this.transitionTo("ERROR");
    });
  }

  /** 用当前 page URL 检测登录状态并更新 READY / LOGIN_REQUIRED */
  private async refreshStatusFromPage(): Promise<BrowserProviderStatus> {
    const page = this.page;
    if (!page || page.isClosed()) {
      return this.state;
    }
    const loggedIn = await this.checker.checkLoggedIn(page);
    if (loggedIn) {
      this.transitionTo("READY", "gemini ready");
    } else {
      this.transitionTo("LOGIN_REQUIRED", "gemini login required");
    }
    return this.state;
  }

  private async closeContext(reason: string): Promise<void> {
    this.stopping = true;
    const handle = this.context;
    this.context = null;
    this.page = null;
    if (handle && !handle.isClosed()) {
      try {
        await handle.close();
        this.logger.info({ reason }, "browser stop");
      } catch (err) {
        this.logger.warn({ err, reason }, "error while closing browser context");
      }
    }
    this.transitionTo("STOPPED");
    this.stopping = false;
  }
}

/** Chromium profile 占用错误特征(Playwright 抛出时一般含这些字样) */
const PROFILE_IN_USE_MARKERS = [
  "already in use",
  "in use by another",
  "processsingleton",
  "singletonlock",
  "user data directory is already",
];

function isProfileInUseError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return PROFILE_IN_USE_MARKERS.some((marker) => lower.includes(marker));
}
