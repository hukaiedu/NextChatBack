/**
 * 与 Playwright 解耦的最小浏览器抽象。
 *
 * 目的:
 * 1. 单元测试可用 Fake 实现驱动 BrowserManager 状态机,不依赖真实浏览器/Google
 * 2. 真实实现只存在于 playwright-driver.ts
 *
 * DOM 能力覆盖到第 4 阶段 Gemini Adapter 所需:计数、写入输入框、按键、读末条回答文本。
 * 等待/超时策略不在此层(GeminiAdapter 自己轮询),避免把业务节奏漏进驱动层。
 */

/** Browser Provider 状态(prd §第 3 阶段第六节) */
export type BrowserProviderStatus =
  | "STOPPED" // 浏览器未启动
  | "STARTING" // 正在创建 Persistent Context
  | "LOGIN_REQUIRED" // 浏览器正常,Gemini 未确认登录
  | "READY" // Gemini 页面可访问且已登录
  | "BUSY" // 正在执行业务(第 5 阶段进入,枚举先建立)
  | "ERROR"; // Browser / Context / Page 初始化失败或异常

/** M2:单个元素的可读快照(text = innerText;attrs 仅含调用方请求的属性) */
export interface BrowserElementSnapshot {
  text: string | null;
  attrs: Record<string, string | null>;
}

export interface BrowserPageHandle {
  url(): string;
  /** 导航到目标地址;失败抛错(由 BrowserManager 映射 PROVIDER_NAVIGATION_FAILED) */
  goto(url: string, options?: { timeoutMs?: number }): Promise<void>;
  close(): Promise<void>;
  isClosed(): boolean;
  bringToFront(): Promise<void>;
  /** 返回匹配 selector 的当前元素数量(登录检测等轻量 DOM 判断用,不做交互) */
  countElements(selector: string): Promise<number>;
  /**
   * M2:读取所有匹配元素的文本与白名单属性(模型菜单逐项读取用)。
   * text = innerText;attrs 只含 options.attrs 里请求的键,元素上不存在的属性为 null。
   * 页面已死(关闭/崩溃)时抛错由调用方按故障语义分类;单个元素读取失败只影响该元素字段。
   */
  readAll(selector: string, options?: { attrs?: string[] }): Promise<BrowserElementSnapshot[]>;
  /** 写入输入框;目标不存在或不可编辑时抛错(由调用方映射 PROVIDER_DOM_CHANGED) */
  fill(selector: string, value: string): Promise<void>;
  /** 在目标元素上按下按键(如 Enter 提交) */
  press(selector: string, key: string): Promise<void>;
  /** 取最后一个匹配元素的渲染文本;无匹配返回 null */
  lastInnerText(selector: string): Promise<string | null>;
  /** 点击第一个匹配元素;目标不存在时抛错(由调用方映射 PROVIDER_DOM_CHANGED) */
  click(selector: string, options?: { timeoutMs?: number }): Promise<void>;
  /**
   * M2:点击第 index 个匹配元素。调用方必须先 readAll 枚举再按 index 定位,
   * 禁止把 opaque key(data-mode-id)拼进 selector。
   */
  clickNth(selector: string, index: number, options?: { timeoutMs?: number }): Promise<void>;
  /** renderer 是否已崩溃(与 isClosed 语义独立:crash 后 page 可能仍未 close) */
  isCrashed(): boolean;
  /** 页面被关闭(用户手动关闭 / 导航替换等) */
  onClose(listener: () => void): void;
  /** 页面崩溃(renderer crash) */
  onCrash(listener: () => void): void;
}

export interface BrowserContextHandle {
  isClosed(): boolean;
  close(): Promise<void>;
  newPage(): Promise<BrowserPageHandle>;
  /** Context 被关闭(主动 stop 或外部关闭/崩溃) */
  onClose(listener: () => void): void;
}

export interface BrowserDriver {
  /**
   * 启动 Persistent Context。
   * 如果 userDataDir 已被其他 Chromium/Playwright 实例占用,必须抛错
   * (BrowserManager 按错误特征映射 PROVIDER_PROFILE_IN_USE)。
   */
  launchPersistentContext(
    userDataDir: string,
    options: { headless: boolean },
  ): Promise<BrowserContextHandle>;
}
