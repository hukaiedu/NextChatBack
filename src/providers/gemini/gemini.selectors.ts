/**
 * Gemini 页面 Selector 集中定义(prd §3.1「Gemini Selector 禁止散落在其他模块」、原则 26)。
 *
 * 全部选择器与 URL 判据来自 2026-09-03 真实 Chromium 采样(已登录 profile,pt-BR 界面)。
 * 采样结论见 docs/GEMINI_AUTOMATION.md。
 *
 * 注意:界面 aria-label 会被本地化(实测为葡萄牙语,如 "Insira um comando para o Gemini"),
 * 因此这里禁止使用 aria-label / 按钮文案作为判据,只用自定义元素名与结构类名。
 */
export const GEMINI_SELECTORS = {
  /**
   * 输入框。真实页面加载后约 3s 内输入框会从临时 `<textarea>` 升级为 Quill
   * (`rich-textarea > .ql-editor[contenteditable=true]`),升级后 textarea 消失。
   * 登录检测用并集(任一存在即视为已渲染输入区);可交互输入必须用 quillComposer。
   */
  composer: "rich-textarea .ql-editor, textarea",
  /** 可输入的编辑器(注意:`[contenteditable="true"]` 会额外命中隐藏的 .ql-clipboard,不能用) */
  quillComposer: "rich-textarea .ql-editor",
  /**
   * Tier-1 signed-out 证据(Revision 3.1 §33 冻结,guest 实测三种形态 run-to-run 漂移)。
   * 任一命中即 UNAUTHENTICATED,优先级压过 composer。
   */
  sessionSignedOut:
    '[data-test-id="mavatar-sign-in-button"], ' +
    '[data-test-id="mavatar-sign-in-icon-button"], ' +
    '[data-test-id="signed-out-disclaimer"]',
  /**
   * Tier-2 authenticated rail 证据(Revision 3.1 CALIB 冻结:guest 0/20、auth 28/28)。
   * account-scoped 页面 chrome,非本地化;与 composer 同现才构成 AUTHENTICATED。
   * 零历史新账号不依赖 conversation history,rail 是唯一进入生产判据的账号域证据。
   */
  sessionAuthenticatedRail:
    '[data-test-id="new-chat-button"], ' +
    '[data-test-id="search-chats-button"]',
  /** 指向 Google 账号域的链接(已退出会话状态判据:登录/未登录页都存在;仅测试夹具引用故保留) */
  signInLink: 'a[href*="accounts.google.com"], a[href*="ServiceLogin"]',
  /** 一轮提问的用户气泡(每发送一次 +1;含无障碍播报前缀,不用于读内容) */
  userTurn: "user-query",
  /** 一轮回答的容器(每轮回答一个) */
  answer: "model-response",
  /** 回答正文(取最后一个 = 最新一条) */
  answerText: "model-response .model-response-text",
  /** 轮次外壳:先建外壳再出回答,故「外壳数 > 回答数」即表示仍在生成 */
  turnShell: "response-container",
  /**
   * 停止生成按钮(第 9 阶段改为多候选,按序遍历)。全部候选都命中失败时,
   * 取消流程降级为 FAILED + PROVIDER_CANCELLATION_UNCONFIRMED(§二)。
   *
   * 基于结构属性而非 aria-label —— aria-label 会被本地化(实测 pt-BR "Parar resposta"),不可作为判据。
   * 候选 1:2026-09-03 真机采样确认的主选择器;
   * 候选 2:icon 本体(不在按钮内时独立出现;点 icon 事件冒泡到按钮同样生效);
   * 候选 3:data-test-id 通配(容 Gemini 改用测试 id 的形态)。
   * Playwright locator 可穿透 open shadow root。
   */
  stopButtonSelectors: [
    'button:has(mat-icon[data-mat-icon-name="stop"])',
    'mat-icon[data-mat-icon-name="stop"]',
    'button[data-test-id*="stop" i]',
  ] as const,
} as const;

/**
 * I2-B:图片附件相关的 selector(全部来自 2026-09-10 I2-A 真机采样与 Final Fix ③;
 * 见 docs/PERSONCHAT_V12_IMAGE_UPLOAD_I2A_REPORT.md)。
 *
 * 全部非本地化 —— 只用自定义元素名、fonticon 属性、结构类名与 input 的 accept 属性。
 * 明确作废、禁止重新引入的旧判据:`images-files-uploader img`、`img[src^="blob:"]`、
 * `progress_activity`(493 个样本 0 次出现)、`arrow_upward` 当就绪判据、
 * aria-label 文案、Angular 动态 class、DOM index。
 */
export const GEMINI_ATTACHMENT_SELECTORS = {
  /**
   * 图片注入 input:懒创建,`+` 面板展开后约 0.9s 才水合;命中数必须恰好 1
   * (另两个 file input 属于文档/Drive 上传器,accept 不是 image/*)。
   * 该 input 自身没有 data-test-id,只能按 accept 定位;隐藏也可写(不需要可见性)。
   */
  imageInput: 'input[type="file"][accept="image/*"]',
  /**
   * 面板触发按钮。**唯一合法读法**是有尺寸那个的 `aria-expanded` 三态
   * (缺失占位 / "false" 已武装 / "true" 已展开);不得按固定次数点击。
   */
  plus: 'input-area-v2 button:has(mat-icon[fonticon="plus"])',
  /**
   * ★ composer 附件存在判据(唯一生产定义)= 该 selector 在 input-area-v2 内的
   * **有尺寸计数**,计数即附件数。历史气泡不产生此节点(I2-B U-10 实测)。
   */
  composerAttachment: "input-area-v2 .gem-attachment-content",
  /** 上传中标记:每个附件上传期存在、完成即消失(progress_activity 不是判据) */
  uploading: "input-area-v2 .gem-attachment-loading-container",
  /** 附件上传失败标记(0 字节图实测:出现后常驻,是终局) */
  attachmentError: 'input-area-v2 mat-icon[fonticon="error"]',
  /** 生成中(此时 `+` 点不动,必须先等 idle) */
  generating: 'input-area-v2 mat-icon[fonticon="stop"]',
  /**
   * 附件移除按钮:仅登记备用 —— I2-B V1 复位默认走 reload(I2-A:paste 注入的 chip
   * 命中测试不放行、2 附件时首个 close 也不放行),不做 close 快路径。
   */
  attachmentClose: 'input-area-v2 button:has(mat-icon[fonticon="close"])',
  /**
   * Google Picker iframe 遮挡(误 force click 打到菜单 Drive 条目会产生)。
   * **只检测不处置**:Escape 撤销未获真机证据(§7 U-3),生产遇到即失败或走 reload。
   */
  pickerOverlay: ".picker-iframe-container, .picker-api-container, google-picker",
} as const;

/**
 * 模型选择器 selector(M2,全部来自 2026-09-05 真机采样,见 docs/GEMINI_MODEL_DOM_REPORT.md)。
 *
 * 机器 key 是 `gem-menu-item` 上的 `data-mode-id`(不透明 hash,禁止硬编码进代码/种子,
 * 也禁止把 key 拼进 CSS selector —— 正确流程是 readAll 枚举后按 index clickNth)。
 * 选中判据 = class token 含 `selected`;`data-active` 是键盘焦点/悬停高亮,绝不能当选中判据。
 * `gem-menu` 的动态 id(如 ng-menu-a30681-0)不可用;aria-label 本地化,不可用。
 */
export const GEMINI_MODEL_SELECTORS = {
  /** 选择器触发按钮(composer 右下,浅色 DOM,登录/新会话/旧会话页面均存在) */
  modeTrigger: 'button[data-test-id="bard-mode-menu-button"]',
  /** 打开中的模式菜单(data-visible=true 才算打开;点击选项后菜单自动关闭) */
  modeMenu: 'gem-menu[data-test-id="gem-mode-menu"][data-visible="true"]',
  /** 单个选项;machine key 在 data-mode-id,展示标题在首个非空文本行 */
  modeOption: 'gem-menu[data-test-id="gem-mode-menu"] gem-menu-item[role="menuitem"]',
  /** 选中项(备查的结构判据;catalog 以 readAll 的 class token 计算为准) */
  modeOptionSelected:
    'gem-menu[data-test-id="gem-mode-menu"] gem-menu-item.selected[role="menuitem"]',
} as const;

/**
 * 会话 id 形态(实测 16 位十六进制,如 /app/b386795e14915155)。
 * 放宽到 [0-9a-z_-]{8,64} 以容纳 Gemini 侧格式变化。
 */
const CONVERSATION_PATH = /^\/app\/([0-9a-zA-Z_-]{8,64})\/?$/;

/** 解析 URL 里的会话 id;不是具体会话(如 /app 新会话首页)返回 null */
export function extractConversationId(url: string): string | null {
  try {
    const match = CONVERSATION_PATH.exec(new URL(url).pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * 规范化 Provider Conversation URL:只保留 origin + pathname,
 * 剥掉全部 query/hash(`?m=`、`udm=`、`hl=` 等一次性参数不入库存,也不参与判等)。
 * 非法 URL 返回 null。
 */
export function normalizeConversationUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${pathname}`;
  } catch {
    return null;
  }
}

/** 两个 Provider Conversation URL 是否指向同一个会话(按规范化后的会话 id 判等) */
export function isSameConversation(a: string, b: string): boolean {
  const idA = extractConversationId(normalizeConversationUrl(a) ?? "");
  const idB = extractConversationId(normalizeConversationUrl(b) ?? "");
  return idA !== null && idA === idB;
}
