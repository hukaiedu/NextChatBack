import type { BrowserPageHandle } from "./browser-driver.js";
import { extractConversationId, GEMINI_SELECTORS } from "./gemini.selectors.js";

/**
 * Gemini 登录状态三态(Revision 3.1 §33 冻结,2026-09-09 真实 DOM 校准):
 *
 * - AUTHENTICATED:Tier-1 signed-out 证据缺席 ∧ composer 存在 ∧ rail 存在。
 *   rail(new-chat-button ∪ search-chats-button)是唯一进入判据的账号域证据;
 *   avatar/img[alt]/accounts 链接/conversation history 一律不参与判定。
 * - UNAUTHENTICATED:URL 非 Gemini origin(accounts/consent 等登录流程),或
 *   Tier-1 signed-out 证据(mavatar-sign-in-button ∪ ...-icon-button ∪
 *   signed-out-disclaimer)任一出现 —— Tier-1 压过 composer。
 * - INDETERMINATE:证据不足(SPA 水合中/中间态),不得折叠成 UNAUTHENTICATED。
 */
export type GeminiSessionState = "AUTHENTICATED" | "UNAUTHENTICATED" | "INDETERMINATE";

/**
 * 三态判定决策表(Revision 3.1 §33):
 * 1. URL 非 Gemini origin → UNAUTHENTICATED
 * 2. Gemini origin ∧ Tier-1 count > 0 → UNAUTHENTICATED
 * 3. Tier-1 = 0 ∧ composer > 0 ∧ rail > 0 → AUTHENTICATED
 * 4. 其他 → INDETERMINATE
 * 5. DOM 查询异常 → INDETERMINATE(绝不 UNAUTHENTICATED)
 */
export class GeminiSessionChecker {
  constructor(private readonly geminiBaseUrl: string) {}

  /** 兼容壳(旧的布尔登录判据已废除,不再维护第二套逻辑) */
  async checkLoggedIn(page: BrowserPageHandle): Promise<boolean> {
    return (await this.checkSessionState(page)) === "AUTHENTICATED";
  }

  async checkSessionState(page: BrowserPageHandle): Promise<GeminiSessionState> {
    if (!isGeminiOriginUrl(page.url(), this.geminiBaseUrl)) {
      return "UNAUTHENTICATED";
    }
    try {
      const signedOut = await page.countElements(GEMINI_SELECTORS.sessionSignedOut);
      if (signedOut > 0) {
        return "UNAUTHENTICATED";
      }
      const composers = await page.countElements(GEMINI_SELECTORS.composer);
      const rails = await page.countElements(GEMINI_SELECTORS.sessionAuthenticatedRail);
      if (composers > 0 && rails > 0) {
        return "AUTHENTICATED";
      }
      return "INDETERMINATE";
    } catch {
      return "INDETERMINATE";
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

/**
 * 判断 URL 是否落在 Gemini 聊天页(/app 或 /app/<conversationId>)。
 *
 * 比 isGeminiOriginUrl 收窄一层:裸同 origin 还包括 /gems 等非聊天路由,
 * 直接拿来当「健康页可跳过导航」判据会把非聊天页误判成已就绪。
 * 会话 id 判定刻意复用 extractConversationId,不另写正则;
 * 不支持 /u/N/app... 多账号形态(否则引入两套 URL 语义),将来支持需统一改。
 */
export function isGeminiChatUrl(currentUrl: string, geminiBaseUrl: string): boolean {
  if (!isGeminiOriginUrl(currentUrl, geminiBaseUrl)) {
    return false;
  }
  try {
    const pathname = new URL(currentUrl).pathname.replace(/\/+$/, "");
    return pathname === "/app" || extractConversationId(currentUrl) !== null;
  } catch {
    return false;
  }
}
