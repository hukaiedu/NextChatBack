import type { Logger } from "pino";

import { createLogger } from "../src/common/logger/logger.js";
import { BrowserManager } from "../src/providers/gemini/browser-manager.js";
import type {
  BrowserContextHandle,
  BrowserDriver,
  BrowserPageHandle,
} from "../src/providers/gemini/browser-driver.js";
import type {
  GeminiAdapter,
  GeminiPromptResult,
  GeminiPromptRunInput,
} from "../src/providers/gemini/gemini.types.js";
import { GEMINI_SELECTORS } from "../src/providers/gemini/gemini.selectors.js";

const GEMINI_BASE_URL = "https://gemini.google.com/app";
const LOGIN_URL = "https://accounts.google.com/signin/v2";

/** FakePage 的可编程页面状态(第 4 阶段 Adapter 测试用) */
export interface FakePageScript {
  /** countElements 覆盖表:先按完整选择器精确匹配,再按关键字片段最长匹配 */
  domCounts?: Record<string, number>;
  /** lastInnerText 依次返回的文本;读尽后重复最后一条,空队列返回 null */
  answerTexts?: string[];
  /** lastInnerText 每次都返回不同文本(模拟持续流式输出,永不停稳) */
  neverStable?: boolean;
  /** 模拟输入框存在但不可写(Playwright fill 会抛错) */
  throwOnFill?: boolean;
  /** goto 之后页面实际落到的 URL(模拟无效会话被重定向回 /app) */
  navLandsUrl?: string;
  /**
   * 复用会话的历史水合剧本:每次采样 userTurn 依次吐出数组中的计数,
   * 只剩最后一个值时停止变化(模拟历史轮次逐步渲染完成)。
   */
  turnSamples?: number[];
  /** 按下提交键之后生效的页面变化 */
  afterSend?: {
    url?: string;
    domCounts?: Record<string, number>;
    answerTexts?: string[];
  };
}

/** Fake Page:goto 可模拟"重定向到 Google 登录页"或"同域未登录(显示 Sign in)" */
export class FakePage implements BrowserPageHandle {
  currentUrl = "about:blank";
  private closedFlag = false;
  private closeListeners: (() => void)[] = [];
  private crashListeners: (() => void)[] = [];
  /** 同域但页面显示 Sign in 链接(未登录的 Gemini 首页) */
  showSignInLink: boolean;
  domCounts: Record<string, number>;
  answerTexts: string[];
  neverStable: boolean;
  throwOnFill: boolean;
  navLandsUrl: string | null;
  private turnSamples: number[];
  private afterSend: FakePageScript["afterSend"];
  /** 断言用调用记录 */
  gotoCalls: string[] = [];
  fillCalls: { selector: string; value: string }[] = [];
  pressCalls: { selector: string; key: string }[] = [];
  /** fill 时水合剧本尚未吐出的计数个数(null = 未配置水合剧本) */
  rampPendingAtFill: number | null = null;
  lastInnerTextCalls = 0;
  private textTick = 0;

  constructor(
    private readonly redirectToLogin: boolean,
    showSignInLink = false,
    script: FakePageScript = {},
  ) {
    this.showSignInLink = showSignInLink;
    this.domCounts = { ...script.domCounts };
    this.answerTexts = [...(script.answerTexts ?? [])];
    this.neverStable = script.neverStable ?? false;
    this.throwOnFill = script.throwOnFill ?? false;
    this.navLandsUrl = script.navLandsUrl ?? null;
    this.turnSamples = [...(script.turnSamples ?? [])];
    this.afterSend = script.afterSend;
  }

  url(): string {
    return this.currentUrl;
  }

  async goto(url: string): Promise<void> {
    this.gotoCalls.push(url);
    if (this.redirectToLogin) {
      this.currentUrl = LOGIN_URL;
    } else if (this.navLandsUrl) {
      this.currentUrl = this.navLandsUrl;
    } else {
      this.currentUrl = url;
    }
  }

  async countElements(selector: string): Promise<number> {
    if (this.closedFlag) {
      return 0;
    }
    if (selector === GEMINI_SELECTORS.userTurn && this.turnSamples.length > 0) {
      // 最后一条不消费:重复返回,让调用方观察到轮次计数停止变化
      return this.turnSamples.length > 1
        ? (this.turnSamples.shift() ?? 0)
        : (this.turnSamples[0] ?? 0);
    }
    const scripted = this.matchScriptedCount(selector);
    if (scripted !== undefined) {
      return scripted;
    }
    // 模拟真实 Gemini DOM(2026-09-03 实测):
    // - 已登录页:输入区存在(textarea 或升级后的 rich-textarea .ql-editor),
    //   并存在 accounts 链接(头像 SignOutOptions)
    // - 未登录页:无输入区,存在 accounts 链接(登录 CTA)
    if (selector.includes("textarea")) {
      return this.showSignInLink ? 0 : 1;
    }
    if (selector.includes("accounts.google.com")) {
      return 1; // 登录和未登录页都存在 accounts 链接,不作判据
    }
    return 0;
  }

  /** domCounts 先精确匹配完整选择器,再按 key 最长子串匹配 */
  private matchScriptedCount(selector: string): number | undefined {
    const exact = this.domCounts[selector];
    if (exact !== undefined) {
      return exact;
    }
    let bestKey = "";
    let bestValue: number | undefined;
    for (const [key, value] of Object.entries(this.domCounts)) {
      if (selector.includes(key) && key.length > bestKey.length) {
        bestKey = key;
        bestValue = value;
      }
    }
    return bestValue;
  }

  async fill(selector: string, value: string): Promise<void> {
    this.rampPendingAtFill = this.turnSamples.length > 0 ? this.turnSamples.length - 1 : null;
    if (this.throwOnFill) {
      throw new Error(`element '${selector}' is not editable`);
    }
    this.fillCalls.push({ selector, value });
  }

  async press(selector: string, key: string): Promise<void> {
    this.pressCalls.push({ selector, key });
    const send = this.afterSend;
    if (!send) {
      return;
    }
    // 发送之后的页面变化由 afterSend 剧本描述,水合剧本只负责发送前的历史渲染
    this.turnSamples = [];
    if (send.url) {
      this.currentUrl = send.url;
    }
    if (send.domCounts) {
      this.domCounts = { ...this.domCounts, ...send.domCounts };
    }
    if (send.answerTexts) {
      this.answerTexts = [...send.answerTexts];
    }
  }

  async lastInnerText(selector: string): Promise<string | null> {
    this.lastInnerTextCalls++;
    if (this.neverStable) {
      this.textTick++;
      return `streaming ${this.textTick}`;
    }
    const queue = this.answerTexts;
    if (queue.length === 0) {
      return null;
    }
    if (queue.length > 1) {
      return queue.shift() ?? null;
    }
    // 最后一条不消费:重复返回,让调用方能观察到文本稳定
    return queue[0] ?? null;
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
    private readonly script: FakePageScript = {},
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
    const page = new FakePage(this.redirectToLogin, this.showSignInLink, this.script);
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
  /** 交给每个 FakePage 的剧本(第 4 阶段 Adapter 测试) */
  pageScript: FakePageScript = {};

  async launchPersistentContext(): Promise<BrowserContextHandle> {
    this.launchCount++;
    if (this.throwOnLaunch) {
      throw this.throwOnLaunch;
    }
    const context = new FakeContext(
      this.redirectToLogin,
      this.sameOriginNotLoggedIn,
      this.pageScript,
    );
    this.contexts.push(context);
    return context;
  }

  get latestContext(): FakeContext | null {
    return this.contexts[this.contexts.length - 1] ?? null;
  }
}

const silentLogger: Logger = createLogger("silent");

export function createFakeManager(driver: FakeDriver, script?: FakePageScript): BrowserManager {
  if (script) {
    driver.pageScript = script;
  }
  return new BrowserManager({
    driver,
    profileDir: "./data/browser-profile",
    headless: true,
    geminiBaseUrl: GEMINI_BASE_URL,
    logger: silentLogger,
  });
}

/** FakeGeminiAdapter 的行为剧本 */
export interface FakeAdapterBehavior {
  /** 报给落库钩子的会话 URL;显式 null = 整个执行没检测到 URL */
  conversationUrl?: string | null;
  answer?: string;
  openError?: unknown;
  runError?: unknown;
  /** 落库钩子 await 完成之后、返回回答之前执行(测试在此读库取顺序证据) */
  beforeAnswer?: () => Promise<void>;
}

export const FAKE_CONVERSATION_URL = "https://gemini.google.com/app/f1e2d3c4b5a69788";

/** 无浏览器版 Gemini Adapter:让 Provider 端点的集成测试跑真 SQLite */
export class FakeGeminiAdapter implements GeminiAdapter {
  readonly openCalls: Array<string | null> = [];
  readonly runCalls: Array<{ prompt: string; existingUrl: string | null }> = [];
  readonly hookUrls: string[] = [];

  constructor(private readonly behavior: FakeAdapterBehavior = {}) {}

  async openConversation(existingUrl: string | null): Promise<void> {
    this.openCalls.push(existingUrl);
    if (this.behavior.openError !== undefined) {
      throw this.behavior.openError;
    }
  }

  async runPrompt(input: GeminiPromptRunInput): Promise<GeminiPromptResult> {
    this.runCalls.push({ prompt: input.prompt, existingUrl: input.existingUrl });
    if (this.behavior.runError !== undefined) {
      throw this.behavior.runError;
    }
    const url = this.behavior.conversationUrl === undefined
      ? FAKE_CONVERSATION_URL
      : this.behavior.conversationUrl;
    if (url !== null) {
      await input.onConversationUrl(url);
      this.hookUrls.push(url);
    }
    await this.behavior.beforeAnswer?.();
    return {
      answer: this.behavior.answer ?? "fake answer",
      conversationUrl: url ?? "",
      urlDetectedElapsedMs: url === null ? null : 5,
      answerElapsedMs: 10,
    };
  }
}
