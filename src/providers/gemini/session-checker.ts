import type { BrowserPageHandle } from "./browser-driver.js";
import { GEMINI_SELECTORS } from "./gemini.selectors.js";

/**
 * Gemini 登录状态检测(第 3 阶段:URL + 页面特征,不依赖真实 Google 账号)。
 *
 * 规则(2026-09-03 按真实 DOM 修正):
 * 1. URL 不在 GEMINI_BASE_URL 同 origin(被重定向到 accounts/consent 等)→ 未登录
 * 2. 同 origin 时按"已登录正判据 → 未登录补判据"顺序:
 *    - 存在聊天输入区(composer 选择器)→ 已登录(Gemini 登录后必渲染)
 *    - 无输入区且存在指向 accounts.google.com 的链接 → 未登录
 *      (未登录时页面停留在本站但显示登录入口,不会总是跳转 accounts)
 *    - 两者都无(SPA 渲染未完成等)→ 保守判未登录
 *
 * 注意:已登录页面长得完全不同 — 真实 DOM 里输入框在页面加载约 3 秒后会从临时
 * `<textarea>` 升级为 Quill 编辑器(`rich-textarea > .ql-editor[contenteditable=true]`),
 * 升级后 textarea 消失,所以判据必须用两者的并集,只查 textarea 会随检测时机漂移。
 * 另外已登录页仍存在 accounts.google.com 链接(头像菜单的 SignOutOptions),
 * 所以 accounts 链接不能作未登录的单独判据,必须先确认"无输入框"再说。
 */
export class GeminiSessionChecker {
  constructor(private readonly geminiBaseUrl: string) {}

  /** 返回 true = 已登录(READY);false = 未登录(LOGIN_REQUIRED) */
  async checkLoggedIn(page: BrowserPageHandle): Promise<boolean> {
    if (!isGeminiOriginUrl(page.url(), this.geminiBaseUrl)) {
      return false;
    }
    try {
      // 正判据:聊天输入区(textarea 或已升级的 Quill,登录后必有)
      const composers = await page.countElements(GEMINI_SELECTORS.composer);
      if (composers > 0) {
        return true;
      }
      // 无输入区:存在 accounts 链接 → 页面在显示登录入口
      const signInLinks = await page.countElements(GEMINI_SELECTORS.signInLink);
      if (signInLinks > 0) {
        return false;
      }
      // 两者都无(SPA 渲染未完成/中间页)→ 保守判未登录
      return false;
    } catch {
      return false;
    }
  }
}

export function isGeminiOriginUrl(currentUrl: string, geminiBaseUrl: string): boolean {
  try {
    const base = new URL(geminiBaseUrl);
    const current = new URL(currentUrl);
    return current.origin === base.origin;
  } catch {
    return false;
  }
}
