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

/**
 * I2-B:composer 附件与入口 UI 的一次性快照。
 *
 * 语义化接口而非通用 evaluate:上层拿不到任意 JS 执行能力,判据固定为
 * `input-area-v2` 内的**有尺寸**计数(I2-A §7 定案),历史气泡不参与。
 */
export interface AttachmentUiState {
  /** composer 草稿区附件数(有尺寸 `.gem-attachment-content` 计数;唯一生产判据) */
  attachmentCount: number;
  /** 页面内 accept 含 image 的 file input 数(就绪恒为 1) */
  imageInputCount: number;
  /** `+` 按钮存在(无论有无尺寸) */
  plusExists: boolean;
  /** 有尺寸的 `+` 按钮存在(= 此刻有可点的盒子;不表示附件有无) */
  plusSized: boolean;
  /** 有尺寸 `+` 在全部 `+` 中的下标(-1 = 无);点击只用它,不做 `.first()` */
  plusSizedIndex: number;
  /** 有尺寸 `+` 的 `aria-expanded` 三态:缺失占位 / "false" 已武装 / "true" 已展开 */
  expanded: "true" | "false" | null;
  /** 生成中(`stop` 图标在场;此时 `+` 点不动) */
  generating: boolean;
  /** 上传中(`.gem-attachment-loading-container` 在场) */
  uploading: boolean;
  /** 附件上传失败(error 图标在场;真机实测为终局) */
  hasError: boolean;
  /** Google Picker iframe 遮挡(只检测;处置未验证) */
  pickerOverlay: boolean;
}

/** I2-B:注入 file input 的文件(内存字节,不落盘;driver 层不校验业务限额) */
export interface BrowserUploadFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export interface BrowserPageHandle {
  url(): string;
  /** 导航到目标地址;失败抛错(由 BrowserManager 映射 PROVIDER_NAVIGATION_FAILED) */
  goto(url: string, options?: { timeoutMs?: number }): Promise<void>;
  /**
   * I2-B:重载当前地址(composer 残留复位的唯一已验证手段)。
   * 失败语义与 goto 相同,由调用方映射。
   */
  reload(options?: { timeoutMs?: number }): Promise<void>;
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
  /**
   * 取最后一个匹配元素的渲染文本。与 readAll/lastInnerHtml 同一异常语义:
   * 无匹配返回 null;普通瞬态读取失败(读取间隙 DOM 变动等)降级 null;
   * 页面/Context 关闭、Browser 断连等关闭族异常原样上抛,不得降级成 null
   * (readAnswerContent 的 fallback 复用本方法,吞掉生命周期异常会把
   * PAGE_CLOSED/BROWSER_CRASHED 伪造成「暂无回答」)。
   */
  lastInnerText(selector: string): Promise<string | null>;
  /**
   * V1.3 富文本:取最后一个匹配元素的 innerHTML(回答结构化读取用)。
   * 无匹配返回 null;普通瞬态读取失败(读取间隙 DOM 变动等)降级 null;
   * 页面/Context 关闭、Browser 断连等关闭族异常原样上抛(与 readAll 同一语义,
   * 禁止降级成 null —— 否则上层会把 PAGE_CLOSED/BROWSER_CRASHED 误判成「暂无回答」)。
   */
  lastInnerHtml(selector: string): Promise<string | null>;
  /** 点击第一个匹配元素;目标不存在时抛错(由调用方映射 PROVIDER_DOM_CHANGED) */
  click(selector: string, options?: { timeoutMs?: number }): Promise<void>;
  /**
   * M2:点击第 index 个匹配元素。调用方必须先 readAll 枚举再按 index 定位,
   * 禁止把 opaque key(data-mode-id)拼进 selector。
   */
  clickNth(selector: string, index: number, options?: { timeoutMs?: number }): Promise<void>;
  /** renderer 是否已崩溃(与 isClosed 语义独立:crash 后 page 可能仍未 close) */
  isCrashed(): boolean;
  /**
   * I2-B:读取 composer 附件/入口 UI 快照。实现内部读 DOM(Playwright 侧),
   * 上层只能拿到本结构,不能传任意脚本;页面/Context 关闭、断连等关闭族异常原样上抛。
   */
  getAttachmentUiState(): Promise<AttachmentUiState>;
  /**
   * I2-B:把文件一次性写入目标 file input(隐藏 input 也可写)。
   * 一次传完整数组 —— 生产上限 4 图共用一次注入,不逐图开合面板。
   */
  setInputFiles(selector: string, files: BrowserUploadFile[]): Promise<void>;
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
