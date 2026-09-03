/**
 * 与 Playwright 解耦的最小浏览器抽象。
 *
 * 目的:
 * 1. 单元测试可用 Fake 实现驱动 BrowserManager 状态机,不依赖真实浏览器/Google
 * 2. 真实实现只存在于 playwright-driver.ts
 *
 * 第 4 阶段做 DOM Selector 时在此扩展(当前只暴露第 3 阶段需要的方法)。
 */

/** Browser Provider 状态(prd §第 3 阶段第六节) */
export type BrowserProviderStatus =
  | "STOPPED" // 浏览器未启动
  | "STARTING" // 正在创建 Persistent Context
  | "LOGIN_REQUIRED" // 浏览器正常,Gemini 未确认登录
  | "READY" // Gemini 页面可访问且已登录
  | "BUSY" // 正在执行业务(第 5 阶段进入,枚举先建立)
  | "ERROR"; // Browser / Context / Page 初始化失败或异常

export interface BrowserPageHandle {
  url(): string;
  /** 导航到目标地址;失败抛错(由 BrowserManager 映射 PROVIDER_NAVIGATION_FAILED) */
  goto(url: string, options?: { timeoutMs?: number }): Promise<void>;
  close(): Promise<void>;
  isClosed(): boolean;
  bringToFront(): Promise<void>;
  /** 返回匹配 selector 的当前元素数量(登录检测等轻量 DOM 判断用,不做交互) */
  countElements(selector: string): Promise<number>;
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
