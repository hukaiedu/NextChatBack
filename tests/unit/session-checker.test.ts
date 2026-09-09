/**
 * Rev3.1 §33:三态 checkSessionState 决策表(生产 GeminiSessionChecker 直测)。
 * P8-AUTH-01..03 冻结矩阵 + DOM 异常降级 + 非 Gemini origin;
 * 证据按真实 DOM 校准(gemini.selectors.ts sessionSignedOut / sessionAuthenticatedRail)。
 */
import { describe, expect, it } from "vitest";

import { GEMINI_SELECTORS } from "../../src/providers/gemini/gemini.selectors.js";
import { GeminiSessionChecker } from "../../src/providers/gemini/session-checker.js";
import type { FakePageScript } from "../fakes.js";
import { FakePage } from "../fakes.js";

const BASE_URL = "https://gemini.google.com/app";
const ACCOUNTS_URL = "https://accounts.google.com/signin/v2/identifier";

const S = {
  signedOut: GEMINI_SELECTORS.sessionSignedOut,
  composer: GEMINI_SELECTORS.composer,
  rail: GEMINI_SELECTORS.sessionAuthenticatedRail,
};

function makePage(
  domCounts: Record<string, number>,
  url: string = BASE_URL,
): FakePage {
  const page = new FakePage(false, false, { domCounts } satisfies FakePageScript);
  page.currentUrl = url;
  return page;
}

describe("GeminiSessionChecker.checkSessionState(Rev3.1 §33 三态)", () => {
  const checker = new GeminiSessionChecker(BASE_URL);

  it("P8-AUTH-01 Tier-1 signed-out 证据压过 composer → UNAUTHENTICATED(rail 有无均可)", async () => {
    // guest 页:composer 与 signed-out CTA 同现(DOM 水合交错),Tier-1 必须优先
    const withRail = makePage({
      [S.signedOut]: 1,
      [S.composer]: 1,
      [S.rail]: 1,
    });
    await expect(checker.checkSessionState(withRail)).resolves.toBe("UNAUTHENTICATED");

    const withoutRail = makePage({
      [S.signedOut]: 1,
      [S.composer]: 1,
    });
    await expect(checker.checkSessionState(withoutRail)).resolves.toBe("UNAUTHENTICATED");
  });

  it("P8-AUTH-02 zero-history 账号:composer + rail、无任何会话历史 → AUTHENTICATED", async () => {
    // 生产判据不要求 conversation history;零历史新账号只靠 rail chrome 即可判定
    const page = makePage({
      [S.composer]: 1,
      [S.rail]: 1,
    });
    await expect(checker.checkSessionState(page)).resolves.toBe("AUTHENTICATED");
  });

  it("P8-AUTH-02b search-chats-button 单独构成 rail → AUTHENTICATED", async () => {
    // 只给 search 臂一个子串计数(不设 rail 并集整键,避免精确匹配压制子串)
    const page = makePage({
      [S.composer]: 1,
      '[data-test-id="search-chats-button"]': 1,
    });
    await expect(checker.checkSessionState(page)).resolves.toBe("AUTHENTICATED");
  });

  it("P8-AUTH-03 证据全缺(SPA 水合早期)→ INDETERMINATE,不折叠 UNAUTHENTICATED", async () => {
    // FakePage 空剧本的模拟 DOM 默认=已登录页,必须显式清零三路证据
    const page = makePage({
      [S.signedOut]: 0,
      [S.composer]: 0,
      [S.rail]: 0,
    });
    await expect(checker.checkSessionState(page)).resolves.toBe("INDETERMINATE");
  });

  it("P8-AUTH-03b generic avatar 不参与判据:composer + 头像类元素、无 rail → INDETERMINATE", async () => {
    // avatar/img[alt]/user-profile-picture 一律不作登录正判据(guest 也存在)
    const page = makePage({
      [S.composer]: 1,
      [S.rail]: 0,
      "user-profile-picture": 1,
      'img[alt]:not([alt=""])': 1,
    });
    await expect(checker.checkSessionState(page)).resolves.toBe("INDETERMINATE");
  });

  it("DOM/countElements 抛异常 → INDETERMINATE,绝不 UNAUTHENTICATED", async () => {
    const page = makePage({});
    page.countElements = async () => {
      throw new Error("Target page, context or browser has been closed");
    };
    await expect(checker.checkSessionState(page)).resolves.toBe("INDETERMINATE");
  });

  it("非 Gemini origin(accounts.google.com)→ UNAUTHENTICATED(单次判定语义)", async () => {
    const page = makePage({ [S.composer]: 1, [S.rail]: 1 }, ACCOUNTS_URL);
    await expect(checker.checkSessionState(page)).resolves.toBe("UNAUTHENTICATED");
  });

  it("checkLoggedIn 兼容壳 = 三态判定的 AUTHENTICATED 布尔映射,不再维护第二套判据", async () => {
    const authenticated = makePage({ [S.composer]: 1, [S.rail]: 1 });
    await expect(checker.checkLoggedIn(authenticated)).resolves.toBe(true);

    const guest = makePage({ [S.signedOut]: 1, [S.composer]: 1 });
    await expect(checker.checkLoggedIn(guest)).resolves.toBe(false);

    const indeterminate = makePage({ [S.signedOut]: 0, [S.composer]: 0, [S.rail]: 0 });
    await expect(checker.checkLoggedIn(indeterminate)).resolves.toBe(false);
  });
});
