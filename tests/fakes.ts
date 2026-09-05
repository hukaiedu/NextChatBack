import type { Logger } from "pino";

import { createLogger } from "../src/common/logger/logger.js";
import { BrowserManager } from "../src/providers/gemini/browser-manager.js";
import type {
  BrowserContextHandle,
  BrowserDriver,
  BrowserElementSnapshot,
  BrowserPageHandle,
} from "../src/providers/gemini/browser-driver.js";
import type {
  GeminiAdapter,
  GeminiModelCatalog,
  GeminiPromptResult,
  GeminiPromptRunInput,
  ResolvedGeminiModel,
} from "../src/providers/gemini/gemini.types.js";
import { GEMINI_MODEL_SELECTORS, GEMINI_SELECTORS } from "../src/providers/gemini/gemini.selectors.js";

const GEMINI_BASE_URL = "https://gemini.google.com/app";
const LOGIN_URL = "https://accounts.google.com/signin/v2";

/** M2:单个模型菜单项剧本(数组顺序即菜单 DOM 顺序) */
export interface FakeModelOptionScript {
  /** data-mode-id(Provider 不透明键,可含任意字符);省略 = 元素缺失该属性(读回 null) */
  key?: string;
  /** innerText(可含多行;Adapter 只取首个非空行作 label) */
  label: string;
  selected?: boolean;
  /** aria-disabled="true"(缺省 = "false",非禁用) */
  ariaDisabled?: boolean;
  /** disabled 布尔属性存在(getAttribute 读到 "") */
  disabledAttr?: boolean;
  /** 追加到 class 的 token(如 "disabled";selected 恒在) */
  classTokens?: string[];
  /** 额外属性(如 data-active),仅当被请求时返回 */
  extraAttrs?: Record<string, string>;
}

/** M2:模型选择菜单剧本(未配置 = 页面没有模型选择器,trigger 点击无效) */
export interface FakeModelPickerScript {
  options: FakeModelOptionScript[];
  /** 初始即打开(默认关闭) */
  initiallyOpen?: boolean;
  /** 点 trigger 能否打开菜单(默认 true;false 模拟「trigger 在但菜单打不开」) */
  opensOnClick?: boolean;
  /**
   * 点击选项后的结果(默认 "switch" = 菜单自动关闭并切换选中态,M0 实测语义):
   * - "close-only":菜单关闭但选中态不变(切换未生效,靠重开验证发现)
   * - "noop":什么都不发生(菜单保持打开 → 等不可见超时)
   * - "throw":点击抛错(模拟元素不可点)
   * - "disconnect"(FIX-05):点击瞬间 Browser 断连,抛 "browser has disconnected"
   *   且不置任何页面标志(连接先死、flags 未落地竞态)
   */
  onClickOption?: "switch" | "close-only" | "noop" | "throw" | "disconnect";
  /** 点击选项时同步调用(测试在此 abort,构造「点击后取消」时序) */
  onOptionClick?: () => void;
  /** readAll 时同步调用(测试在此 abort,构造「打开菜单/读取后、点击前取消」时序) */
  onReadAll?: () => void;
  /**
   * FIX-02:前 N 次 countElements(modeOption) 返回 0(模拟容器先出现、选项后渲染);
   * 不配置 = 选项随容器即时出现
   */
  optionLagReads?: number;
  /** FIX-02:每次 countElements(modeOption) 时同步调用(测试在此关闭/崩溃页面) */
  onOptionCount?: () => void;
  /**
   * FIX-01:readAll 在菜单打开且命中 modeOption 时,于元素映射阶段模拟页面死亡并
   * 抛 Playwright 关闭族异常(locator.all() 已成功 → 元素读取时页面关闭/崩溃);
   * "disconnected" 为 FIX-04 边界:抛 Browser 断连关闭族异常但不置页面关闭/崩溃
   * 标志(连接先死、页面状态尚未落地的竞态)
   */
  failElementRead?: "closed" | "crash" | "disconnected";
  /** FIX-05:点 modeTrigger 时抛 "browser has disconnected"(不置页面标志,菜单不打开) */
  failTriggerClick?: "disconnected";
  /** FIX-05:countElements(modeOption) 时抛 "browser has disconnected"(不置页面标志) */
  failOptionCount?: "disconnected";
}

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
  /** click 时对这些选择器(完整串精确匹配)抛错,模拟元素存在但不可点 */
  throwOnClickSelectors?: string[];
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
  /** 点击停止按钮后生效的页面变化(第 8 阶段取消测试用) */
  afterStopClick?: {
    domCounts?: Record<string, number>;
    answerTexts?: string[];
  };
  /** M2:模型选择菜单剧本 */
  modelPicker?: FakeModelPickerScript;
}

/** Fake Page:goto 可模拟"重定向到 Google 登录页"或"同域未登录(显示 Sign in)" */
export class FakePage implements BrowserPageHandle {
  currentUrl = "about:blank";
  private closedFlag = false;
  private crashedFlag = false;
  private closeListeners: (() => void)[] = [];
  private crashListeners: (() => void)[] = [];
  /** 同域但页面显示 Sign in 链接(未登录的 Gemini 首页) */
  showSignInLink: boolean;
  domCounts: Record<string, number>;
  answerTexts: string[];
  neverStable: boolean;
  throwOnFill: boolean;
  throwOnClickSelectors: string[];
  navLandsUrl: string | null;
  private turnSamples: number[];
  private afterSend: FakePageScript["afterSend"];
  private afterStopClick: FakePageScript["afterStopClick"];
  /** M2:模型菜单状态(由 modelPicker 剧本驱动) */
  private readonly modelPicker: FakeModelPickerScript | null;
  private modelMenuOpen = false;
  private modelOptions: FakeModelOptionScript[] = [];
  /** FIX-02:剩余的「选项未渲染」读数次数 */
  private optionLagRemaining = 0;
  /** 断言用调用记录 */
  gotoCalls: string[] = [];
  fillCalls: { selector: string; value: string }[] = [];
  pressCalls: { selector: string; key: string }[] = [];
  clickCalls: string[] = [];
  /** M2 调用记录:readAll / clickNth 依次记下 selector 与参数 */
  readAllCalls: Array<{ selector: string; attrs: string[] | undefined }> = [];
  clickNthCalls: Array<{ selector: string; index: number }> = [];
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
    this.throwOnClickSelectors = [...(script.throwOnClickSelectors ?? [])];
    this.navLandsUrl = script.navLandsUrl ?? null;
    this.turnSamples = [...(script.turnSamples ?? [])];
    this.afterSend = script.afterSend;
    this.afterStopClick = script.afterStopClick;
    this.modelPicker = script.modelPicker ?? null;
    this.modelMenuOpen = script.modelPicker?.initiallyOpen ?? false;
    // 深拷贝选项:clickNth 会改写 selected,不能污染共享的剧本对象
    this.modelOptions = (script.modelPicker?.options ?? []).map((option) => ({ ...option }));
    this.optionLagRemaining = script.modelPicker?.optionLagReads ?? 0;
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
    if (selector === GEMINI_MODEL_SELECTORS.modeMenu) {
      return this.modelMenuOpen ? 1 : 0;
    }
    if (selector === GEMINI_MODEL_SELECTORS.modeOption) {
      if (this.modelPicker?.failOptionCount !== undefined) {
        // FIX-05:连接先死、flags 未落地——不置任何标志,直接抛断连文案
        throw new Error("browser has disconnected");
      }
      this.modelPicker?.onOptionCount?.();
      // 钩子若在本次计数中关闭/崩溃页面,真实 Playwright 的 count 会失败(driver 降级 0)
      if (this.closedFlag || this.crashedFlag) {
        return 0;
      }
      if (!this.modelMenuOpen) {
        return 0;
      }
      if (this.optionLagRemaining > 0) {
        this.optionLagRemaining -= 1;
        return 0;
      }
      return this.modelOptions.length;
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

  async click(selector: string, _options?: { timeoutMs?: number }): Promise<void> {
    // 记录的是「尝试过的选择器」:失败的候选也会留下痕迹,供轮换断言用
    this.clickCalls.push(selector);
    if (this.throwOnClickSelectors.includes(selector)) {
      throw new Error(`element '${selector}' is not clickable`);
    }
    if (selector === GEMINI_MODEL_SELECTORS.modeTrigger && this.modelPicker !== null) {
      if (this.modelPicker.failTriggerClick !== undefined) {
        // FIX-05:点击瞬间断连,flags 未落地,菜单也不打开
        throw new Error("browser has disconnected");
      }
      // trigger 是开关:开→关、关→开(M0 实测);opensOnClick=false 时点击无效
      if (this.modelMenuOpen) {
        this.modelMenuOpen = false;
      } else if (this.modelPicker.opensOnClick !== false) {
        this.modelMenuOpen = true;
      }
      return;
    }
    const stop = this.afterStopClick;
    if (stop) {
      if (stop.domCounts) {
        this.domCounts = { ...this.domCounts, ...stop.domCounts };
      }
      if (stop.answerTexts) {
        this.answerTexts = [...stop.answerTexts];
      }
    }
  }

  async readAll(
    selector: string,
    options?: { attrs?: string[] },
  ): Promise<BrowserElementSnapshot[]> {
    this.readAllCalls.push({ selector, attrs: options?.attrs });
    this.modelPicker?.onReadAll?.();
    if (selector !== GEMINI_MODEL_SELECTORS.modeOption || !this.modelMenuOpen) {
      return [];
    }
    if (this.modelPicker?.failElementRead !== undefined) {
      // FIX-01:locator.all() 已成功,元素读取阶段页面才死亡——真实 Playwright
      // 对已关/已崩页面的 innerText/getAttribute 抛关闭族异常,不得降级成 null
      const mode = this.modelPicker.failElementRead;
      if (mode === "closed") {
        this.emitClosed();
      } else if (mode === "crash") {
        this.emitCrashed();
      }
      // "disconnected":不置任何页面标志——连接先死、页面状态未落地(FIX-04 边界)
      throw new Error(
        mode === "disconnected" ? "browser has disconnected" : "Target page, context or browser has been closed",
      );
    }
    return this.modelOptions.map((option) => ({
      text: option.label,
      attrs: this.modelOptionAttrs(option, options?.attrs ?? []),
    }));
  }

  /** 只回请求的属性;元素上不存在的属性为 null(真实 getAttribute 语义) */
  private modelOptionAttrs(
    option: FakeModelOptionScript,
    requested: string[],
  ): Record<string, string | null> {
    const available: Record<string, string | null> = {
      "data-mode-id": option.key ?? null,
      class: ["gem-menu-item", option.selected ? "selected" : null, ...(option.classTokens ?? [])]
        .filter(Boolean)
        .join(" "),
      "aria-disabled": option.ariaDisabled === true ? "true" : "false",
      disabled: option.disabledAttr === true ? "" : null,
      ...option.extraAttrs,
    };
    const record: Record<string, string | null> = {};
    for (const name of requested) {
      record[name] = Object.hasOwn(available, name) ? (available[name] ?? null) : null;
    }
    return record;
  }

  async clickNth(selector: string, index: number, _options?: { timeoutMs?: number }): Promise<void> {
    if (this.closedFlag || this.crashedFlag) {
      // 真实 Playwright 对已关/已崩页面点击会抛关闭族异常
      throw new Error("Target page, context or browser has been closed");
    }
    this.clickNthCalls.push({ selector, index });
    if (selector !== GEMINI_MODEL_SELECTORS.modeOption) {
      return;
    }
    if (!this.modelMenuOpen) {
      throw new Error(`model menu is not open; cannot click option index ${index}`);
    }
    const option = this.modelOptions[index];
    if (!option) {
      throw new Error(`no model option at index ${index}`);
    }
    this.modelPicker?.onOptionClick?.();
    switch (this.modelPicker?.onClickOption ?? "switch") {
      case "throw":
        throw new Error(`element '${selector}' [${index}] is not clickable`);
      case "disconnect":
        // FIX-05:点击瞬间断连,flags 未落地(菜单/选中态都不变,但主流程已中断)
        throw new Error("browser has disconnected");
      case "noop":
        return;
      case "close-only":
        this.modelMenuOpen = false;
        return;
      case "switch":
        // M0:点击选项后菜单自动关闭,选中态即时切到被点项
        this.modelMenuOpen = false;
        for (const candidate of this.modelOptions) {
          candidate.selected = candidate.key === option.key;
        }
        return;
    }
  }

  isCrashed(): boolean {
    return this.crashedFlag;
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
    this.crashedFlag = true;
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
  /** 按调用次序给每次执行分配会话 URL(多会话用例必须各自不同,@unique);超出列表 = null */
  conversationUrls?: string[];
  answer?: string;
  openError?: unknown;
  runError?: unknown;
  /** 抛 runError 前一拍触发(测试在此编排「close/crash 事件晚于异常落地」的竞态时序) */
  beforeRunError?: () => void;
  /** 落库钩子 await 完成之后、返回回答之前执行(测试在此读库取顺序证据) */
  beforeAnswer?: () => Promise<void>;
  /** 落库之后永不返回(模拟执行器挂死):用于验证 Scheduler 的 execution watchdog */
  hang?: boolean;
  /**
   * 流式剧本(第 6 阶段):依次通过 Adapter 的 onText 钩子吐出的**当前完整文本**,
   * 与真实 Adapter 一样是「越读越长的前缀」,增量由业务层推导。
   */
  streamTexts?: string[];
  /** 每推完一段文本后 await(测试据此控制节奏:确认 SSE 已收到才推下一段) */
  onStreamText?: (text: string, index: number) => Promise<void>;
  /**
   * 取消剧本(第 8 阶段):signal 被 abort 时的行为。
   * "cancelled" = 返回 {cancelled:true};"unconfirmed" = 抛 cancellationUnconfirmed();
   * 省略 = signal abort 时直接返回 {cancelled:false}(按钮已不在 DOM)。
   */
  cancelBehaviour?: "cancelled" | "unconfirmed";
  /** 取消时返回的部分回答内容 */
  partialAnswer?: string;
  /** confirmIdle 返回值;省略 = true */
  confirmIdle?: boolean;
  /** signal 被 abort 时通知测试(断言用) */
  abortObserver?: () => void;
  /** listModels 返回的目录;省略 = A/B/C 三模型、当前 A(M1 §十 Fake 默认目录) */
  modelCatalog?: GeminiModelCatalog;
  /** listModels 抛出的错误;优先于 modelCatalog */
  listModelsError?: unknown;
  /** ensureModel 抛出的错误(signal 未 abort 时);省略 = 从目录查 label 直接返回 */
  ensureModelError?: unknown;
}

export const FAKE_CONVERSATION_URL = "https://gemini.google.com/app/f1e2d3c4b5a69788";

/** M1 §十:Fake 默认模型目录(A/B/C 三个不透明键,当前选中 A) */
export const FAKE_MODEL_CATALOG: GeminiModelCatalog = {
  models: [
    { key: "model-a", label: "Model A", selected: true, disabled: false },
    { key: "model-b", label: "Model B", selected: false, disabled: false },
    { key: "model-c", label: "Model C", selected: false, disabled: false },
  ],
  currentModelKey: "model-a",
};

/** 无浏览器版 Gemini Adapter:让 Provider 端点的集成测试跑真 SQLite */
export class FakeGeminiAdapter implements GeminiAdapter {
  readonly openCalls: Array<string | null> = [];
  readonly runCalls: Array<{ prompt: string; existingUrl: string | null }> = [];
  readonly hookUrls: string[] = [];
  /** 已推给 onText 的完整文本序列(流式用例断言用) */
  readonly streamedTexts: string[] = [];
  /** listModels 被调用的次数(测试断言用) */
  listModelsCalls = 0;
  /** ensureModel 收到的模型键序列(测试断言用) */
  readonly ensureModelCalls: string[] = [];

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
      this.behavior.beforeRunError?.();
      throw this.behavior.runError;
    }
    const callIndex = this.runCalls.length - 1;
    const url = this.behavior.conversationUrls
      ? this.behavior.conversationUrls[callIndex] ?? null
      : this.behavior.conversationUrl === undefined
        ? FAKE_CONVERSATION_URL
        : this.behavior.conversationUrl;
    if (url !== null) {
      await input.onConversationUrl(url);
      this.hookUrls.push(url);
    }
    const streamTexts = this.behavior.streamTexts ?? [];
    for (const [index, text] of streamTexts.entries()) {
      // 取消信号检查:模拟真实 Adapter 在每轮 poll 开头检查 signal
      if (input.signal?.aborted) {
        this.behavior.abortObserver?.();
        if (this.behavior.cancelBehaviour === "unconfirmed") {
          const { cancellationUnconfirmed } = await import(
            "../src/providers/gemini/gemini.errors.js"
          );
          throw cancellationUnconfirmed();
        }
        return {
          answer: this.behavior.partialAnswer ?? streamTexts.at(-1) ?? "",
          conversationUrl: url ?? "",
          urlDetectedElapsedMs: url === null ? null : 5,
          answerElapsedMs: 10,
          cancelled: this.behavior.cancelBehaviour === "cancelled",
        };
      }
      this.streamedTexts.push(text);
      await input.onText?.(text);
      // 测试在这里等待,确认 SSE 已经收到这一帧才推下一段
      await this.behavior.onStreamText?.(text, index);
    }
    if (this.behavior.hang) {
      // 永不 settle:只有 Scheduler 的 watchdog 能把这条 Request 收尾
      // 但如果 signal 被 abort,也要响应
      if (input.signal) {
        await new Promise<void>((resolve) => {
          if (input.signal!.aborted) {
            resolve();
          } else {
            input.signal!.addEventListener("abort", () => resolve(), { once: true });
          }
        });
        this.behavior.abortObserver?.();
        if (this.behavior.cancelBehaviour === "unconfirmed") {
          const { cancellationUnconfirmed } = await import(
            "../src/providers/gemini/gemini.errors.js"
          );
          throw cancellationUnconfirmed();
        }
        return {
          answer: this.behavior.partialAnswer ?? streamTexts.at(-1) ?? "",
          conversationUrl: url ?? "",
          urlDetectedElapsedMs: url === null ? null : 5,
          answerElapsedMs: 10,
          cancelled: this.behavior.cancelBehaviour === "cancelled",
        };
      }
      return new Promise<GeminiPromptResult>(() => undefined);
    }
    await this.behavior.beforeAnswer?.();
    return {
      answer: this.behavior.answer ?? streamTexts.at(-1) ?? "fake answer",
      conversationUrl: url ?? "",
      urlDetectedElapsedMs: url === null ? null : 5,
      answerElapsedMs: 10,
    };
  }

  async confirmIdle(): Promise<boolean> {
    return this.behavior.confirmIdle ?? true;
  }

  async listModels(): Promise<GeminiModelCatalog> {
    this.listModelsCalls += 1;
    if (this.behavior.listModelsError !== undefined) {
      throw this.behavior.listModelsError;
    }
    return this.behavior.modelCatalog ?? FAKE_MODEL_CATALOG;
  }

  async ensureModel(requestedModelKey: string, signal?: AbortSignal): Promise<ResolvedGeminiModel> {
    this.ensureModelCalls.push(requestedModelKey);
    // 与真实 Adapter 相同的取消语义:abort 后立即停止,抛出 signal.reason
    signal?.throwIfAborted();
    if (this.behavior.ensureModelError !== undefined) {
      throw this.behavior.ensureModelError;
    }
    const catalog = this.behavior.modelCatalog ?? FAKE_MODEL_CATALOG;
    const found = catalog.models.find((model) => model.key === requestedModelKey);
    return { key: requestedModelKey, label: found?.label ?? requestedModelKey };
  }
}
