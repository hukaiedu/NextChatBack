import type { Logger } from "pino";

import { createLogger } from "../src/common/logger/logger.js";
import { BrowserManager } from "../src/providers/gemini/browser-manager.js";
import type {
  BrowserContextHandle,
  BrowserDriver,
  BrowserPageHandle,
} from "../src/providers/gemini/browser-driver.js";

const GEMINI_BASE_URL = "https://gemini.google.com/app";
const LOGIN_URL = "https://accounts.google.com/signin/v2";

/** Fake Page:goto 可模拟"重定向到 Google 登录页"或"同域未登录(显示 Sign in)" */
export class FakePage implements BrowserPageHandle {
  currentUrl = "about:blank";
  private closedFlag = false;
  private closeListeners: (() => void)[] = [];
  private crashListeners: (() => void)[] = [];
  /** 同域但页面显示 Sign in 链接(未登录的 Gemini 首页) */
  showSignInLink: boolean;

  constructor(
    private readonly redirectToLogin: boolean,
    showSignInLink = false,
  ) {
    this.showSignInLink = showSignInLink;
  }

  url(): string {
    return this.currentUrl;
  }

  async goto(url: string): Promise<void> {
    this.currentUrl = this.redirectToLogin ? LOGIN_URL : url;
  }

  async countElements(selector: string): Promise<number> {
    if (this.closedFlag) {
      return 0;
    }
    // 模拟真实 Gemini DOM(2026-09-03 实测):
    // - 已登录页:聊天输入框是 <textarea>,并存在 accounts 链接(头像 SignOutOptions)
    // - 未登录页:无 textarea,存在 accounts 链接(登录 CTA)
    if (selector.includes("textarea")) {
      return this.showSignInLink ? 0 : 1;
    }
    if (selector.includes("accounts.google.com")) {
      return 1; // 登录和未登录页都存在 accounts 链接,不作判据
    }
    return 0;
  }

  async close(): Promise<void> {
    if (!this.closedFlag) {
      this.emitClosed();
    }
  }

  isClosed(): boolean {
    return this.closedFlag;
  }

  async bringToFront(): Promise<void> {}

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  onCrash(listener: () => void): void {
    this.crashListeners.push(listener);
  }

  /** 测试触发:模拟用户关闭页面 */
  emitClosed(): void {
    if (this.closedFlag) {
      return;
    }
    this.closedFlag = true;
    for (const listener of this.closeListeners) {
      listener();
    }
  }

  /** 测试触发:模拟 renderer crash */
  emitCrashed(): void {
    for (const listener of this.crashListeners) {
      listener();
    }
  }
}

export class FakeContext implements BrowserContextHandle {
  closed = false;
  lastPage: FakePage | null = null;
  private closeListeners: (() => void)[] = [];

  constructor(
    private readonly redirectToLogin: boolean,
    private readonly showSignInLink: boolean,
  ) {}

  isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.emitClosed();
    }
  }

  async newPage(): Promise<BrowserPageHandle> {
    const page = new FakePage(this.redirectToLogin, this.showSignInLink);
    this.lastPage = page;
    return page;
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  /** 测试触发:模拟 Context 意外关闭 */
  emitClosed(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const listener of this.closeListeners) {
      listener();
    }
  }
}

export class FakeDriver implements BrowserDriver {
  launchCount = 0;
  contexts: FakeContext[] = [];
  /** launch 时抛出的错误(模拟启动失败 / profile 占用) */
  throwOnLaunch: Error | null = null;
  /** 新 page 导航后落在 Google 登录页(模拟重定向未登录) */
  redirectToLogin = false;
  /** 新 page 停留在 Gemini 同域但显示 Sign in 链接(模拟同域未登录) */
  sameOriginNotLoggedIn = false;

  async launchPersistentContext(): Promise<BrowserContextHandle> {
    this.launchCount++;
    if (this.throwOnLaunch) {
      throw this.throwOnLaunch;
    }
    const context = new FakeContext(this.redirectToLogin, this.sameOriginNotLoggedIn);
    this.contexts.push(context);
    return context;
  }

  get latestContext(): FakeContext | null {
    return this.contexts[this.contexts.length - 1] ?? null;
  }
}

const silentLogger: Logger = createLogger("silent");

export function createFakeManager(driver: FakeDriver): BrowserManager {
  return new BrowserManager({
    driver,
    profileDir: "./data/browser-profile",
    headless: true,
    geminiBaseUrl: GEMINI_BASE_URL,
    logger: silentLogger,
  });
}
