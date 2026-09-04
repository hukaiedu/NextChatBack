import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";

import type {
  BrowserContextHandle,
  BrowserDriver,
  BrowserPageHandle,
} from "./browser-driver.js";

const DEFAULT_NAVIGATION_TIMEOUT_MS = 45_000;

/** 真实 Playwright 实现(BrowserManager 的生产依赖) */
export class PlaywrightBrowserDriver implements BrowserDriver {
  async launchPersistentContext(
    userDataDir: string,
    options: { headless: boolean },
  ): Promise<BrowserContextHandle> {
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: options.headless,
    });
    return new PlaywrightContextHandle(context);
  }
}

class PlaywrightContextHandle implements BrowserContextHandle {
  /** context 没有 isConnected(Browser 才有),用 close 事件维护 */
  private closed = false;

  constructor(private readonly context: BrowserContext) {
    context.on("close", () => {
      this.closed = true;
    });
  }

  isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    await this.context.close();
  }

  async newPage(): Promise<BrowserPageHandle> {
    const page = await this.context.newPage();
    return new PlaywrightPageHandle(page);
  }

  onClose(listener: () => void): void {
    this.context.on("close", listener);
  }
}

class PlaywrightPageHandle implements BrowserPageHandle {
  private crashed = false;

  constructor(private readonly page: Page) {
    page.on("crash", () => {
      this.crashed = true;
    });
  }

  url(): string {
    return this.page.url();
  }

  async goto(url: string, options?: { timeoutMs?: number }): Promise<void> {
    await this.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: options?.timeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
    });
  }

  async close(): Promise<void> {
    await this.page.close();
  }

  isClosed(): boolean {
    return this.page.isClosed();
  }

  isCrashed(): boolean {
    return this.crashed;
  }

  async countElements(selector: string): Promise<number> {
    try {
      return await this.page.locator(selector).count();
    } catch {
      return 0;
    }
  }

  /** Playwright fill 会派发 input 事件,可驱动 Angular/Quill 内容变更 */
  async fill(selector: string, value: string): Promise<void> {
    await this.page.locator(selector).first().fill(value);
  }

  /** 先聚焦再按键盘:与真实键盘事件路径一致 */
  async press(selector: string, key: string): Promise<void> {
    await this.page.locator(selector).first().focus();
    await this.page.keyboard.press(key);
  }

  async lastInnerText(selector: string): Promise<string | null> {
    try {
      const last = this.page.locator(selector).last();
      if ((await last.count()) === 0) {
        return null;
      }
      return await last.innerText();
    } catch {
      return null;
    }
  }

  async click(selector: string, options?: { timeoutMs?: number }): Promise<void> {
    await this.page.locator(selector).first().click({
      timeout: options?.timeoutMs,
    });
  }

  async bringToFront(): Promise<void> {
    await this.page.bringToFront();
  }

  onClose(listener: () => void): void {
    this.page.on("close", listener);
  }

  onCrash(listener: () => void): void {
    this.page.on("crash", listener);
  }
}
