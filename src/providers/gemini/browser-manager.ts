import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import type { Logger } from "../../common/logger/logger.js";
import type {
  BrowserContextHandle,
  BrowserDriver,
  BrowserPageHandle,
  BrowserProviderStatus,
} from "./browser-driver.js";
import {
  GeminiSessionChecker,
  isGeminiChatUrl,
  isGeminiOriginUrl,
} from "./session-checker.js";
import { extractConversationId } from "./gemini.selectors.js";

/**
 * P8-FIX-01/Rev3.1:导航后 Gemini SPA 会话状态稳定化窗口(数值与语义冻结见
 * 设计文档 Revision 3.1 §33;只用于 ensureGeminiPage 成功 goto 后,不用于
 * checkGeminiSession() 的单次检测)。
 * - SETTLE_TIMEOUT_MS:总 deadline,届时仍无法判定 → LOGIN_REQUIRED 或 ERROR
 * - MIN_UNAUTH_CONFIRM_ELAPSED_MS:UNAUTHENTICATED 定案最早时点(此前只累计证据)
 * - UNAUTH_STABILITY_ROUNDS:连续 signed-out 轮数门槛(约 2s;INDETERMINATE 会清零)
 */
const POST_NAV_SESSION_SETTLE_TIMEOUT_MS = 25_000;
const POST_NAV_SESSION_MIN_UNAUTH_CONFIRM_ELAPSED_MS = 20_000;
const POST_NAV_SESSION_UNAUTH_STABILITY_ROUNDS = 8;
const POST_NAV_SESSION_POLL_MS = 250;

/** 仅内部诊断串(不进 ErrorCodes / HTTP map):deadline 仍无法判定会话状态时上报用 */
const PROVIDER_SESSION_INDETERMINATE = "PROVIDER_SESSION_INDETERMINATE";

export interface BrowserManagerOptions {
  driver: BrowserDriver;
  profileDir: string;
  headless: boolean;
  geminiBaseUrl: string;
  logger: Logger;
  sessionChecker?: GeminiSessionChecker;
  /**
   * P8-FIX-01/Rev3.1 稳定化窗口覆盖(仅测试缩短用;生产保持默认
   * 25_000ms / 250ms / 20_000ms / 8 轮,不新增 env 开关)
   */
  postNavSettle?: {
    timeoutMs?: number;
    pollMs?: number;
    minUnauthConfirmElapsedMs?: number;
    unauthStabilityRounds?: number;
  };
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
  /**
   * 粘性故障码(第 8 阶段):Context/Page 崩溃时 adapter 先抛的是 pageClosed(),
   * Scheduler 用此码提升为 PROVIDER_BROWSER_CRASHED,精确对齐 §12.2。
   * takeProviderFault() 读并清;只由 bindContextEvents/bindPageEvents 写入。
   */
  private providerFault: string | null = null;
  /** 最近一次成功启动 Persistent Context 的时间;closeContext 时清空(浏览器状态 API 用) */
  private startedAt: Date | null = null;
  /** restart() 进行中:浏览器状态 API 据此报 RESTARTING */
  private restarting = false;
  /** 最近一次浏览器故障摘要(≤200 字符,不含堆栈;浏览器状态 API 展示用) */
  private lastBrowserError: { code: string; message: string } | null = null;

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

  /** 启动浏览器并强制导航到 Gemini 首页,返回最终状态(READY / LOGIN_REQUIRED) */
  async openGemini(): Promise<BrowserProviderStatus> {
    return this.runExclusive(() => this.ensureProvider("always"));
  }

  /**
   * Scheduler Provider Gate 入口:确保浏览器与 Gemini 页可用即返回最终状态。
   * 与 openGemini 唯一差异:当前页已是健康 Gemini 聊天页且确认登录时跳过导航(0 goto);
   * 页缺失/漂移/登录态不确定等其余路径与 openGemini 完全一致。
   */
  async ensureReady(): Promise<BrowserProviderStatus> {
    return this.runExclusive(() => this.ensureProvider("ifNeeded"));
  }

  private async ensureProvider(
    navigation: "always" | "ifNeeded",
  ): Promise<BrowserProviderStatus> {
    // BUSY = 有 Request 正在该页面上执行;此时导航会毁掉进行中的生成。
    // 检查放在 runExclusive 内:即使调用排在执行期间,状态落到这里时仍是实时值。
    if (this.state === "BUSY") {
      throw new AppError(
        ErrorCodes.PROVIDER_NOT_READY,
        "browser is busy executing another request",
      );
    }
    // 自愈:Chromium 僵死但 context 未 close → newPage() 永久挂住 → Scheduler 静默卡死。
    // 先 closeContext 让 ensureContextStarted 重建干净的 Chromium。
    if (this.state === "ERROR") {
      await this.closeContext("self-heal from ERROR");
    }
    await this.ensureContextStarted();
    return this.ensureGeminiPage(navigation);
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
      this.restarting = true;
      try {
        await this.closeContext("browser restart requested");
        await this.ensureContextStarted();
        return await this.ensureGeminiPage();
      } finally {
        this.restarting = false;
      }
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
   * 取出当前可用的 Gemini Page(Adapter 唯一入口)。
   * 状态机是唯一真相源:非 READY/BUSY 一律抛出对应错误码,调用方不得绕过。
   * BUSY 放行:执行中的 Request 就是页面的合法使用者(Scheduler 先 setBusy 再执行)。
   */
  requireGeminiPage(): BrowserPageHandle {
    const status = this.getStatus();
    if (status === "LOGIN_REQUIRED") {
      throw new AppError(ErrorCodes.PROVIDER_LOGIN_REQUIRED, "Gemini login is required");
    }
    const page = this.page;
    if (!page || page.isClosed() || (status !== "READY" && status !== "BUSY")) {
      throw new AppError(ErrorCodes.PROVIDER_NOT_READY, "Gemini page is not ready");
    }
    return page;
  }

  /** Scheduler 执行 Request 期间置 BUSY:阻止 openGemini 导航毁掉进行中的生成 */
  setBusy(): void {
    this.providerFault = null;
    this.transitionTo("BUSY");
  }

  clearBusy(): void {
    if (this.state === "BUSY") {
      this.transitionTo("READY");
    }
  }

  /**
   * 非抛出版取页:closed/缺失返回 null。
   * Adapter.confirmIdle 用此方法避免 requireGeminiPage 在崩溃后抛错。
   */
  peekGeminiPage(): BrowserPageHandle | null {
    const page = this.page;
    if (!page || page.isClosed()) {
      return null;
    }
    return page;
  }

  /** 读并清粘性故障码;null = 无故障 */
  takeProviderFault(): string | null {
    const fault = this.providerFault;
    this.providerFault = null;
    return fault;
  }

  // ---- 浏览器状态 API 的只读观察位(docs/browser-status-api.md) ----

  getStartedAt(): Date | null {
    return this.startedAt;
  }

  isRestarting(): boolean {
    return this.restarting;
  }

  getLastBrowserError(): { code: string; message: string } | null {
    return this.lastBrowserError;
  }

  getProfileDir(): string {
    return this.options.profileDir;
  }

  isHeadless(): boolean {
    return this.options.headless;
  }

  /**
   * 等待关闭类事件收敛(§8.8 异常分类用):onClose/onCrash 是异步事件,执行异常可能先到。
   * 短暂轮询内部状态,任一信号落地立即返回;窗口耗尽返回 "none"。
   * - "crashed":粘性故障码已写入,或 Context 已不存在/已关闭(崩溃、断开、意外关闭)
   * - "page-closed":Context 仍存活而 Gemini Page 已关闭(用户单独关页)
   * - "none":窗口内无任何信号(调用方维持原语义兜底)
   */
  async settleCloseEvents(timeoutMs: number): Promise<"crashed" | "page-closed" | "none"> {
    const stepMs = 10;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.providerFault !== null) {
        return "crashed";
      }
      if (!this.context || this.context.isClosed()) {
        return "crashed";
      }
      if (!this.page || this.page.isClosed()) {
        return "page-closed";
      }
      if (Date.now() >= deadline) {
        return "none";
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(stepMs, deadline - Date.now())),
      );
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

  /** 记录最近一次浏览器故障的可读摘要(响应里不允许出现堆栈与凭据) */
  private recordBrowserError(code: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.lastBrowserError = {
      code,
      message: message.length > 200 ? message.slice(0, 200) : message,
    };
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
      this.startedAt = new Date();
      this.lastBrowserError = null;
      this.logger.info(
        { profileDir: this.options.profileDir, elapsedMs: Date.now() - startedAt },
        "browser ready",
      );
    } catch (err) {
      this.context = null;
      this.page = null;
      this.transitionTo("ERROR");
      this.recordBrowserError(
        isProfileInUseError(err)
          ? ErrorCodes.PROVIDER_PROFILE_IN_USE
          : ErrorCodes.PROVIDER_BROWSER_START_FAILED,
        err,
      );
      if (isProfileInUseError(err)) {
        this.logger.error({ err }, "browser profile is in use by another process");
        throw new AppError(
          ErrorCodes.PROVIDER_PROFILE_IN_USE,
          "Browser profile is in use by another process",
          err,
        );
      }
      this.logger.error({ err }, "browser start failed");
      throw new AppError(
        ErrorCodes.PROVIDER_BROWSER_START_FAILED,
        "Failed to start browser",
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
      this.providerFault = ErrorCodes.PROVIDER_BROWSER_CRASHED;
      this.recordBrowserError(
        ErrorCodes.PROVIDER_BROWSER_CRASHED,
        "browser context closed unexpectedly",
      );
      this.context = null;
      this.page = null;
      this.transitionTo("STOPPED");
    });
  }

  /** 确保存在可用 Gemini Page 并完成导航与登录检测 */
  private async ensureGeminiPage(
    navigation: "always" | "ifNeeded" = "always",
  ): Promise<BrowserProviderStatus> {
    const context = this.context;
    if (!context || context.isClosed()) {
      throw new AppError(ErrorCodes.PROVIDER_NOT_READY, "Browser is not ready");
    }

    let page = this.page;
    if (!page || page.isClosed()) {
      page = await context.newPage();
      this.bindPageEvents(page);
      this.page = page;
      this.logger.info("gemini page created");
    }

    // FIX-04/Rev3.1:零导航仅在「页面健康且三态判定为 AUTHENTICATED」时短路;
    // UNAUTHENTICATED 与 INDETERMINATE 都不得在导航前定案 LOGIN_REQUIRED
    // (checker 会把 DOM/关闭族异常 catch 成 INDETERMINATE,断连竞态下 url()
    // 可能仍是旧聊天页且 isCrashed 尚未落地)→ fallback 走既有 goto+settle 流程。
    if (
      navigation === "ifNeeded" &&
      !page.isCrashed() &&
      isGeminiChatUrl(page.url(), this.options.geminiBaseUrl)
    ) {
      const sessionState = await this.checker.checkSessionState(page);
      if (sessionState === "AUTHENTICATED") {
        this.transitionTo("READY", "gemini ready (navigation skipped)");
        return this.state;
      }
      this.logger.info(
        { sessionState },
        "gemini session not authenticated on chat page, falling back to navigation",
      );
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
        err,
      );
    }

    this.logger.info(
      // prd §14 / ISSUE-02:不记未脱敏会话 URL。Gemini 可能将 /app 重定向到 /app/<id>,
      // 故只记「是否落在具体会话」的布尔信号,不记 URL / conversation id。
      { onConversation: extractConversationId(page.url()) !== null },
      "gemini page open",
    );
    return this.settleSessionAfterNavigation(page);
  }

  /**
   * P8-FIX-01/Rev3.1:成功导航后、LOGIN_REQUIRED/ERROR 定案前的三态稳定化
   * (决策表冻结见设计文档 Revision 3.1 §33):
   * - 每轮先过生命周期红线:page 被替换/关闭/crash 或 context 消失 → 立即返回
   *   现状(STOPPED/ERROR 由事件驱动),绝不把 crash 伪装成登录失效
   * - 非 Gemini origin(accounts/consent 登录流程)→ 立即 LOGIN_REQUIRED
   * - AUTHENTICATED → 立即 READY(正证据早退,不等窗口耗尽)
   * - UNAUTHENTICATED 只累计连续轮数;elapsed ≥ 20s 且连续 ≥ 8 轮才定案
   * - INDETERMINATE 清零连续计数(非连续 Tier-1 不得累加成稳定证据)
   * - deadline 仍无法判定:连续 signed-out 足够 → LOGIN_REQUIRED,
   *   否则 ERROR(PROVIDER_SESSION_INDETERMINATE 诊断;绝不 INDETERMINATE → LOGIN_REQUIRED)
   */
  private async settleSessionAfterNavigation(
    page: BrowserPageHandle,
  ): Promise<BrowserProviderStatus> {
    const settle = this.options.postNavSettle;
    const timeoutMs = settle?.timeoutMs ?? POST_NAV_SESSION_SETTLE_TIMEOUT_MS;
    const pollMs = settle?.pollMs ?? POST_NAV_SESSION_POLL_MS;
    const minUnauthElapsedMs =
      settle?.minUnauthConfirmElapsedMs ?? POST_NAV_SESSION_MIN_UNAUTH_CONFIRM_ELAPSED_MS;
    const stabilityRounds =
      settle?.unauthStabilityRounds ?? POST_NAV_SESSION_UNAUTH_STABILITY_ROUNDS;
    const context = this.context;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let consecutiveUnauthenticated = 0;
    for (;;) {
      if (
        this.page !== page ||
        !context ||
        context.isClosed() ||
        page.isClosed() ||
        page.isCrashed()
      ) {
        return this.getStatus();
      }
      if (!isGeminiOriginUrl(page.url(), this.options.geminiBaseUrl)) {
        this.transitionTo(
          "LOGIN_REQUIRED",
          "gemini login required (navigated away from gemini origin)",
        );
        return this.state;
      }
      const sessionState = await this.checker.checkSessionState(page);
      if (sessionState === "AUTHENTICATED") {
        this.transitionTo("READY", "gemini ready");
        return this.state;
      }
      if (sessionState === "UNAUTHENTICATED") {
        consecutiveUnauthenticated += 1;
        if (
          Date.now() - startedAt >= minUnauthElapsedMs &&
          consecutiveUnauthenticated >= stabilityRounds
        ) {
          this.transitionTo("LOGIN_REQUIRED", "gemini login required");
          return this.state;
        }
      } else {
        consecutiveUnauthenticated = 0;
      }
      if (Date.now() >= deadline) {
        break;
      }
      await sleep(pollMs);
    }
    if (consecutiveUnauthenticated >= stabilityRounds) {
      this.transitionTo("LOGIN_REQUIRED", "gemini login required");
      return this.state;
    }
    this.transitionTo("ERROR", "gemini session state indeterminate after navigation");
    this.recordBrowserError(
      PROVIDER_SESSION_INDETERMINATE,
      "Gemini session state remained indeterminate after navigation",
    );
    return this.state;
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
        { code: ErrorCodes.PROVIDER_BROWSER_CRASHED, fault: "page-crash" },
        "gemini page crashed",
      );
      this.providerFault = ErrorCodes.PROVIDER_BROWSER_CRASHED;
      this.recordBrowserError(ErrorCodes.PROVIDER_BROWSER_CRASHED, "gemini page crashed");
      this.page = null;
      this.transitionTo("ERROR");
    });
  }

  /**
   * 用当前 page 三态检测并更新状态:AUTHENTICATED → READY;
   * UNAUTHENTICATED → LOGIN_REQUIRED;INDETERMINATE 不翻转当前状态。
   */
  private async refreshStatusFromPage(): Promise<BrowserProviderStatus> {
    const page = this.page;
    if (!page || page.isClosed()) {
      return this.state;
    }
    const sessionState = await this.checker.checkSessionState(page);
    if (sessionState === "AUTHENTICATED") {
      this.transitionTo("READY", "gemini ready");
    } else if (sessionState === "UNAUTHENTICATED") {
      this.transitionTo("LOGIN_REQUIRED", "gemini login required");
    }
    return this.state;
  }

  private async closeContext(reason: string): Promise<void> {
    this.stopping = true;
    const handle = this.context;
    this.context = null;
    this.page = null;
    this.startedAt = null;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
