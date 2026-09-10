import type { Logger } from "pino";

import { createLogger } from "../src/common/logger/logger.js";
import { BrowserManager } from "../src/providers/gemini/browser-manager.js";
import { GeminiSessionChecker } from "../src/providers/gemini/session-checker.js";
import type { GeminiSessionState } from "../src/providers/gemini/session-checker.js";
import type {
  AttachmentUiState,
  BrowserContextHandle,
  BrowserDriver,
  BrowserElementSnapshot,
  BrowserPageHandle,
  BrowserUploadFile,
} from "../src/providers/gemini/browser-driver.js";
import type {
  GeminiAdapter,
  GeminiModelCatalog,
  GeminiPromptResult,
  GeminiPromptRunInput,
  ResolvedGeminiModel,
} from "../src/providers/gemini/gemini.types.js";
import {
  GEMINI_ATTACHMENT_SELECTORS,
  GEMINI_MODEL_SELECTORS,
  GEMINI_SELECTORS,
} from "../src/providers/gemini/gemini.selectors.js";

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
  /**
   * FIX-06:每次点 modeTrigger 时同步调用(attempt 从 1 起)。抛错即模拟该次点击
   * 失败 —— 普通 Playwright timeout 文案 = 冷启动水合未就绪的瞬时失败,
   * "browser has disconnected" = 断连竞态;不抛错则继续正常开合逻辑。
   */
  onTriggerClick?: (attempt: number) => void;
  /** FIX-05:countElements(modeOption) 时抛 "browser has disconnected"(不置页面标志) */
  failOptionCount?: "disconnected";
}

/** FakePage 的可编程页面状态(第 4 阶段 Adapter 测试用) */
export interface FakePageScript {
  /** countElements 覆盖表:先按完整选择器精确匹配,再按关键字片段最长匹配 */
  domCounts?: Record<string, number>;
  /** lastInnerText 依次返回的文本;读尽后重复最后一条,空队列返回 null */
  answerTexts?: string[];
  /** V1.3:lastInnerHtml 依次返回的 HTML;读尽后重复最后一条,空队列返回 null */
  answerHtmls?: string[];
  /**
   * V1.3:lastInnerHtml 异常剧本。"closed"/"disconnected" 抛关闭族异常但不置页面
   * 标志(连接先死、状态未落地的竞态,与 modelPicker.failElementRead 同构),
   * Adapter 不得将其降级成 fallback;"generic" 抛普通瞬态异常(应降级 null/fallback)。
   */
  throwOnLastInnerHtml?: "closed" | "disconnected" | "generic";
  /**
   * FINAL-FIX-01:lastInnerText 异常剧本,语义与 throwOnLastInnerHtml 相同 ——
   * "closed"/"disconnected" 抛关闭族异常但不置页面标志,"generic" 抛普通瞬态异常。
   * fallback 路径复用 lastInnerText,关闭族异常必须原样上抛。
   */
  throwOnLastInnerText?: "closed" | "disconnected" | "generic";
  /** lastInnerText 每次都返回不同文本(模拟持续流式输出,永不停稳) */
  neverStable?: boolean;
  /** 模拟输入框存在但不可写(Playwright fill 会抛错) */
  throwOnFill?: boolean;
  /** goto 时抛错(模拟导航失败,如连接拒绝;浏览器状态 API 重启失败分类用) */
  throwOnGoto?: boolean;
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
    answerHtmls?: string[];
  };
  /** 点击停止按钮后生效的页面变化(第 8 阶段取消测试用) */
  afterStopClick?: {
    domCounts?: Record<string, number>;
    answerTexts?: string[];
    answerHtmls?: string[];
  };
  /** M2:模型选择菜单剧本 */
  modelPicker?: FakeModelPickerScript;
  /** I2-B:composer 附件/面板剧本(未配置 = 干净页面:0 附件、无面板、无 input) */
  attachment?: FakeAttachmentScript;
}

/**
 * I2-B:附件面板剧本(只描述状态迁移,不承载任何真实图片内容)。
 *
 * 状态字段与生产 `AttachmentUiState` 同构;`onPlusClick` / `onUpload` 是**按序消费**的
 * 状态补丁:每次动作取一步,用尽后不迁移(STUCK 剧本即「连续补丁都不改变状态」)。
 */
export interface FakeAttachmentScript {
  attachmentCount?: number;
  imageInputCount?: number;
  expanded?: "true" | "false" | null;
  plusExists?: boolean;
  plusSized?: boolean;
  plusSizedIndex?: number;
  generating?: boolean;
  uploading?: boolean;
  hasError?: boolean;
  pickerOverlay?: boolean;
  /** 每次点击 `+` 之后应用的状态补丁(按序;空 = 状态不变) */
  onPlusClick?: Array<Partial<AttachmentUiState>>;
  /** 每次 setInputFiles 之后应用的状态补丁(按序);默认 `{ attachmentCount: files.length }` */
  onUpload?: Array<Partial<AttachmentUiState>>;
  /** setInputFiles 抛普通错误(非关闭族) */
  failUpload?: boolean;
  /** setInputFiles 抛关闭族错误(页面在注入瞬间被关闭,分类必须走浏览器错误) */
  failUploadClosed?: boolean;
  /**
   * 面板展开(state 变 "true")后,经过 N ms 让 image input 出现(模拟 ~0.9s 水合窗口)。
   * 不配 = input 永远不会自己出现(只能靠补丁显式给)。
   */
  hydrateInputAfterMs?: number;
  /** 上传后经过 N ms 自动清 uploading(模拟上传完成;不配 = 一直保持) */
  uploadingClearAfterMs?: number;
  /** 生成中经过 N ms 自动清 generating(模拟 wait-idle) */
  generatingClearAfterMs?: number;
  /** reload 之后的页面状态(默认干净复位:面板收起、附件清零、无错误) */
  afterReload?: Partial<AttachmentUiState>;
  /**
   * I2-B Final Fix:快照读取抛普通(非关闭族)异常。true = 每次读取都抛,
   * 用来证明「读取失败 ≠ 空 composer」——生产必须 FAILED 而不是继续发送。
   */
  failSnapshotRead?: boolean;
  /**
   * 首次 setInputFiles 成功后再放过 N 次成功读取,之后的读取抛普通异常
   * (用来把读取失败精确打在 Enter 前断言上)
   */
  failSnapshotAfterUpload?: number;
  /** 快照读取抛关闭族异常(必须保持 PROVIDER_PAGE_CLOSED/BROWSER_CRASHED 分类,不被附件错误覆盖) */
  failSnapshotClosed?: boolean;
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
  answerHtmls: string[];
  throwOnLastInnerHtml: FakePageScript["throwOnLastInnerHtml"];
  throwOnLastInnerText: FakePageScript["throwOnLastInnerText"];
  neverStable: boolean;
  throwOnFill: boolean;
  throwOnGoto: boolean;
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
  /** FIX-06:click 的 timeoutMs 参数记录(供 deadline 封顶断言),与 clickCalls 同序 */
  clickTimeoutCalls: Array<{ selector: string; timeoutMs: number | undefined }> = [];
  /** FIX-06:modeTrigger 已尝试的点击次数(onTriggerClick 的 attempt 基数) */
  private triggerClickAttempts = 0;
  /** M2 调用记录:readAll / clickNth 依次记下 selector 与参数 */
  readAllCalls: Array<{ selector: string; attrs: string[] | undefined }> = [];
  clickNthCalls: Array<{ selector: string; index: number }> = [];
  /** I2-B:countElements 调用记录(断言生产代码没有去读作废判据) */
  countElementsCalls: string[] = [];
  /** I2-B:reload 调用次数(残留复位证据) */
  reloadCalls: number[] = [];
  /** I2-B:setInputFiles 调用记录 —— 只记 name/mimeType/byteLength/selector,不存字节 */
  uploadCalls: Array<{
    selector: string;
    files: Array<{ name: string; mimeType: string; byteLength: number }>;
  }> = [];
  /** I2-B:当前附件面板状态(断言用) */
  attachment: AttachmentUiState;
  /**
   * I2-B:关键动作的事件序列(只记事件名),用于断言协议顺序
   * (reload → attach → upload → fill → press;§17/§18/§28)。
   */
  events: string[] = [];
  private readonly attachmentScript: FakeAttachmentScript | null;
  private plusClickPatchIndex = 0;
  private uploadPatchIndex = 0;
  private uploadingDeadline: number | null = null;
  private generatingDeadline: number | null = null;
  private hydrateDeadline: number | null = null;
  /** I2-B Final Fix:快照读取计数与「已经发生过一次真实注入」标记(读失败剧本用) */
  snapshotReadCount = 0;
  private uploadHappened = false;
  private postUploadReads = 0;
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
    this.answerHtmls = [...(script.answerHtmls ?? [])];
    this.throwOnLastInnerHtml = script.throwOnLastInnerHtml;
    this.throwOnLastInnerText = script.throwOnLastInnerText;
    this.neverStable = script.neverStable ?? false;
    this.throwOnFill = script.throwOnFill ?? false;
    this.throwOnGoto = script.throwOnGoto ?? false;
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
    this.attachmentScript = script.attachment ?? null;
    this.attachment = {
      attachmentCount: script.attachment?.attachmentCount ?? 0,
      imageInputCount: script.attachment?.imageInputCount ?? 0,
      plusExists: script.attachment?.plusExists ?? true,
      plusSized: script.attachment?.plusSized ?? true,
      plusSizedIndex: script.attachment?.plusSizedIndex ?? 0,
      expanded: script.attachment?.expanded ?? null,
      generating: script.attachment?.generating ?? false,
      uploading: script.attachment?.uploading ?? false,
      hasError: script.attachment?.hasError ?? false,
      pickerOverlay: script.attachment?.pickerOverlay ?? false,
    };
    this.uploadingDeadline =
      script.attachment?.uploading && script.attachment.uploadingClearAfterMs !== undefined
        ? Date.now() + script.attachment.uploadingClearAfterMs
        : null;
    this.generatingDeadline =
      script.attachment?.generating && script.attachment.generatingClearAfterMs !== undefined
        ? Date.now() + script.attachment.generatingClearAfterMs
        : null;
  }

  url(): string {
    return this.currentUrl;
  }

  async goto(url: string): Promise<void> {
    this.gotoCalls.push(url);
    if (this.throwOnGoto) {
      throw new Error("net::ERR_CONNECTION_REFUSED");
    }
    if (this.redirectToLogin) {
      this.currentUrl = LOGIN_URL;
    } else if (this.navLandsUrl) {
      this.currentUrl = this.navLandsUrl;
    } else {
      this.currentUrl = url;
    }
  }

  /**
   * I2-B:重载。默认把 composer 复位成干净状态(真机 reload 语义);
   * `attachment.afterReload` 可以覆盖成「复位失败仍残留」的剧本。
   */
  async reload(): Promise<void> {
    this.reloadCalls.push(Date.now());
    this.events.push("reload");
    if (this.throwOnGoto) {
      throw new Error("net::ERR_CONNECTION_REFUSED");
    }
    const patch = this.attachmentScript?.afterReload ?? {};
    this.attachment = {
      attachmentCount: patch.attachmentCount ?? 0,
      imageInputCount: patch.imageInputCount ?? 0,
      plusExists: patch.plusExists ?? true,
      plusSized: patch.plusSized ?? true,
      plusSizedIndex: patch.plusSizedIndex ?? 0,
      expanded: patch.expanded ?? null,
      generating: patch.generating ?? false,
      uploading: patch.uploading ?? false,
      hasError: patch.hasError ?? false,
      pickerOverlay: patch.pickerOverlay ?? false,
    };
    this.uploadingDeadline = null;
    this.generatingDeadline = null;
    this.plusClickPatchIndex = 0;
    this.uploadPatchIndex = 0;
    this.hydrateDeadline = null;
    this.uploadHappened = false;
    this.postUploadReads = 0;
  }

  /** I2-B:附件/入口状态快照(生产的唯一判据来源;不暴露任何 DOM 细节) */
  async getAttachmentUiState(): Promise<AttachmentUiState> {
    if (this.closedFlag) {
      throw new Error("Target page, context or browser has been closed");
    }
    const script = this.attachmentScript;
    this.snapshotReadCount += 1;
    // I2-B Final Fix:快照读取失败 = 真异常,绝不能等价于「空 composer」
    if (script?.failSnapshotClosed) {
      throw new Error("Target page, context or browser has been closed");
    }
    if (script?.failSnapshotRead) {
      throw new Error("Execution context was destroyed, most likely because of a navigation");
    }
    if (this.uploadHappened && script?.failSnapshotAfterUpload !== undefined) {
      if (this.postUploadReads >= script.failSnapshotAfterUpload) {
        throw new Error("Execution context was destroyed, most likely because of a navigation");
      }
      this.postUploadReads += 1;
    }
    const now = Date.now();
    const generating =
      this.attachment.generating &&
      !(this.generatingDeadline !== null && now >= this.generatingDeadline);
    if (this.attachment.generating && !generating) {
      // 只记一次「stop 消失」迁移,便于断言点击是否晚于 idle
      this.attachment = { ...this.attachment, generating: false };
      this.events.push("generating-idle");
    }
    const uploading =
      this.attachment.uploading &&
      !(this.uploadingDeadline !== null && now >= this.uploadingDeadline);
    // 面板展开后按剧本水合出 image input(读取驱动,无需真实定时器)
    let imageInputCount = this.attachment.imageInputCount;
    const hydrateMs = this.attachmentScript?.hydrateInputAfterMs;
    if (this.attachment.expanded === "true" && imageInputCount === 0 && hydrateMs !== undefined) {
      if (this.hydrateDeadline === null) {
        this.hydrateDeadline = now + hydrateMs;
      }
      if (now >= this.hydrateDeadline) {
        imageInputCount = 1;
      }
    }
    return { ...this.attachment, generating, uploading, imageInputCount };
  }

  /** I2-B:一次注入完整文件数组;只记录 name/mimeType/byteLength,不保存字节 */
  async setInputFiles(selector: string, files: BrowserUploadFile[]): Promise<void> {
    this.events.push("upload");
    this.uploadCalls.push({
      selector,
      files: files.map((file) => ({
        name: file.name,
        mimeType: file.mimeType,
        byteLength: file.buffer.length,
      })),
    });
    const script = this.attachmentScript;
    if (script?.failUploadClosed) {
      throw new Error("Target page, context or browser has been closed");
    }
    if (script?.failUpload) {
      throw new Error("File chooser was not intercepted");
    }
    const patch = script?.onUpload?.[this.uploadPatchIndex] ?? { attachmentCount: files.length };
    this.uploadPatchIndex += 1;
    this.uploadHappened = true;
    this.attachment = { ...this.attachment, ...patch };
    if (this.attachment.uploading) {
      this.uploadingDeadline =
        script?.uploadingClearAfterMs !== undefined ? Date.now() + script.uploadingClearAfterMs : null;
    }
  }

  async countElements(selector: string): Promise<number> {
    this.countElementsCalls.push(selector);
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
    // 模拟真实 Gemini DOM(2026-09-03 实测 + Rev3.1 §33 三态判据):
    // - 已登录页:输入区存在(textarea 或升级后的 rich-textarea .ql-editor),
    //   并存在 accounts 链接(头像 SignOutOptions)与 rail chrome(new-chat/search-chats)
    // - 未登录页:无输入区、无 rail,存在 accounts 链接(登录 CTA)与
    //   Tier-1 signed-out 证据(mavatar-sign-in-* / signed-out-disclaimer)
    if (selector.includes("textarea")) {
      return this.showSignInLink ? 0 : 1;
    }
    if (selector.includes("accounts.google.com")) {
      return 1; // 登录和未登录页都存在 accounts 链接,不作判据
    }
    if (
      selector.includes('data-test-id="new-chat-button"') ||
      selector.includes('data-test-id="search-chats-button"')
    ) {
      return this.showSignInLink ? 0 : 1;
    }
    if (
      selector.includes('data-test-id="mavatar-sign-in-button"') ||
      selector.includes('data-test-id="mavatar-sign-in-icon-button"') ||
      selector.includes('data-test-id="signed-out-disclaimer"')
    ) {
      return this.showSignInLink ? 1 : 0;
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
    // I2-B 协议守卫:上传中/附件报错时绝不允许写入输入框(生产不得提前 fill)
    const state = await this.getAttachmentUiState();
    if (state.uploading) {
      throw new Error("fake protocol guard: fill() called while attachments are uploading");
    }
    if (state.hasError) {
      throw new Error("fake protocol guard: fill() called while attachment error is shown");
    }
    this.events.push("fill");
    this.fillCalls.push({ selector, value });
  }

  async press(selector: string, key: string): Promise<void> {
    // I2-B 协议守卫:上传未结束/附件报错时绝不发送(Enter 前必须已就绪)
    const state = await this.getAttachmentUiState();
    if (state.uploading) {
      throw new Error("fake protocol guard: Enter pressed while attachments are uploading");
    }
    if (state.hasError) {
      throw new Error("fake protocol guard: Enter pressed while attachment error is shown");
    }
    this.events.push(`press:${key}`);
    this.pressCalls.push({ selector, key });
    // I2-B:发送后 composer 附件清零(真机实测:发送后页面已无 composer 附件节点)
    if (key === "Enter" && selector === GEMINI_SELECTORS.quillComposer) {
      this.attachment = { ...this.attachment, attachmentCount: 0, imageInputCount: 0, expanded: null };
    }
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
    if (send.answerHtmls) {
      this.answerHtmls = [...send.answerHtmls];
    }
  }

  async lastInnerText(selector: string): Promise<string | null> {
    this.lastInnerTextCalls++;
    switch (this.throwOnLastInnerText) {
      case "closed":
        // FINAL-FIX-01:关闭族异常但 flags 未落地,不得被降级 null
        throw new Error("Target page, context or browser has been closed");
      case "disconnected":
        throw new Error("browser has disconnected");
      case "generic":
        throw new Error("element is detached");
    }
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

  lastInnerHtmlCalls = 0;

  async lastInnerHtml(selector: string): Promise<string | null> {
    this.lastInnerHtmlCalls++;
    switch (this.throwOnLastInnerHtml) {
      case "closed":
        // 关闭族异常但 flags 未落地(真实 Playwright 竞态形态),不得被降级 null
        throw new Error("Target page, context or browser has been closed");
      case "disconnected":
        throw new Error("browser has disconnected");
      case "generic":
        throw new Error("element is detached");
    }
    // V1.3:主读路径是 lastInnerHtml(HTML → Markdown)。未配置 answerHtmls 时,
    // 从 answerTexts 消费同一帧合成 <p>(innerText 与 innerHTML 是同一 DOM 节点的
    // 两种视图,不允许两套队列各自前进导致帧错位)——既有 answerTexts 剧本自动获得
    // 与旧 lastInnerText 时代等价的回答内容。
    const htmlQueue = this.answerHtmls;
    if (htmlQueue.length > 0) {
      if (htmlQueue.length > 1) {
        return htmlQueue.shift() ?? null;
      }
      // 最后一条不消费:重复返回,让调用方能观察到稳定
      return htmlQueue[0] ?? null;
    }
    if (this.neverStable) {
      this.textTick += 1;
      return `<p>streaming ${this.textTick}</p>`;
    }
    const textQueue = this.answerTexts;
    if (textQueue.length === 0) {
      return null;
    }
    if (textQueue.length > 1) {
      return `<p>${escapeHtmlText(textQueue.shift() ?? "")}</p>`;
    }
    return `<p>${escapeHtmlText(textQueue[0] ?? "")}</p>`;
  }

  /** I2-B:clickNth 命中面板 `+` 时按剧本应用状态迁移(点击的真实副作用) */
  private applyPlusClickPatch(selector: string): void {
    if (selector !== GEMINI_ATTACHMENT_SELECTORS.plus) {
      return;
    }
    this.events.push("plus-click");
    if (this.attachmentScript === null) {
      return;
    }
    const patch = this.attachmentScript.onPlusClick?.[this.plusClickPatchIndex];
    this.plusClickPatchIndex += 1;
    if (patch) {
      this.attachment = { ...this.attachment, ...patch };
    }
  }

  async click(selector: string, options?: { timeoutMs?: number }): Promise<void> {
    // 记录的是「尝试过的选择器」:失败的候选也会留下痕迹,供轮换断言用
    this.clickCalls.push(selector);
    this.clickTimeoutCalls.push({ selector, timeoutMs: options?.timeoutMs });
    this.applyPlusClickPatch(selector);
    if (this.throwOnClickSelectors.includes(selector)) {
      throw new Error(`element '${selector}' is not clickable`);
    }
    if (selector === GEMINI_MODEL_SELECTORS.modeTrigger && this.modelPicker !== null) {
      this.triggerClickAttempts++;
      // FIX-06:剧本钩子先于开合逻辑,抛错即该次点击失败
      this.modelPicker.onTriggerClick?.(this.triggerClickAttempts);
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
      if (stop.answerHtmls) {
        this.answerHtmls = [...stop.answerHtmls];
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
    this.applyPlusClickPatch(selector);
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
  /** launch 前的人为延迟(ms);构造「重启进行中」的观察窗口用 */
  launchDelayMs = 0;
  /** 新 page 导航后落在 Google 登录页(模拟重定向未登录) */
  redirectToLogin = false;
  /** 新 page 停留在 Gemini 同域但显示 Sign in 链接(模拟同域未登录) */
  sameOriginNotLoggedIn = false;
  /** 交给每个 FakePage 的剧本(第 4 阶段 Adapter 测试) */
  pageScript: FakePageScript = {};

  async launchPersistentContext(): Promise<BrowserContextHandle> {
    this.launchCount++;
    if (this.launchDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.launchDelayMs));
    }
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

/**
 * P8/Rev3.1:脚本化三态登录检测 —— checkSessionState 按三态剧本依次返回,
 * 读尽后重复最后一个值(空数组 = 恒 AUTHENTICATED)。calls 计数与 onCheck
 * 回调供会话测试插桩(如 settle 中途关闭页面)。与生产 GeminiSessionChecker
 * 同构(extends);旧布尔 checkLoggedIn 壳由基类路由到本 override,语义由
 * 剧本负责(水合暂态 = INDETERMINATE,稳定未登录 = UNAUTHENTICATED)。
 */
export class ScriptedSessionChecker extends GeminiSessionChecker {
  calls = 0;
  private readonly queue: GeminiSessionState[];
  private readonly onCheck: ((call: number) => void) | undefined;

  constructor(
    geminiBaseUrl: string,
    results: GeminiSessionState[],
    onCheck?: (call: number) => void,
  ) {
    super(geminiBaseUrl);
    this.queue = [...results];
    this.onCheck = onCheck;
  }

  override async checkSessionState(_page: BrowserPageHandle): Promise<GeminiSessionState> {
    this.calls += 1;
    this.onCheck?.(this.calls);
    const last = this.queue[this.queue.length - 1] ?? "AUTHENTICATED";
    if (this.queue.length > 1) {
      return this.queue.shift() ?? last;
    }
    return last;
  }
}

/** 合成 <p> 前的文本转义:保证 answerTexts 含 < > & 时合成 HTML 仍可被解析还原 */
function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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
    // P8-FIX-01:单测不真实等 8s 生产窗口;未登录判定测试用短稳定化窗口
    postNavSettle: { timeoutMs: 120, pollMs: 10 },
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
  /** FIX-06:listModels 人为延迟(ms),用于锁竞态测试 */
  listModelsDelayMs?: number;
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
  /** I2-B:附件只记元数据(name/mimeType/byteLength),不保存字节;纯文本时无该键 */
  readonly runCalls: Array<{
    prompt: string;
    existingUrl: string | null;
    attachments?: Array<{ name: string; mimeType: string; byteLength: number }>;
  }> = [];
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
    this.runCalls.push({
      prompt: input.prompt,
      existingUrl: input.existingUrl,
      ...(input.attachments
        ? {
            attachments: input.attachments.map((file) => ({
              name: file.name,
              mimeType: file.mimeType,
              byteLength: file.buffer.length,
            })),
          }
        : {}),
    });
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
    if (this.behavior.listModelsDelayMs) {
      await new Promise((r) => setTimeout(r, this.behavior.listModelsDelayMs));
    }
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
