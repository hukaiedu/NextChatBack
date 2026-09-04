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
  /** 指向 Google 账号域的链接(只作未登录补判据:已登录页的头像菜单里也有) */
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
