/**
 * FIX-01(M2 Review):PlaywrightBrowserDriver.readAll 的元素读取阶段错误处理。
 *
 * 只覆盖 readAll 中「locator.all() 已成功 → 逐元素 innerText/getAttribute」这一段:
 *  - 页面关闭 / Browser 崩溃族异常必须原样上抛(isContextClosedError 判定,与
 *    Scheduler §8.8 共用同一套识别,不另造规则);
 *  - 普通元素级瞬态失败仍降级 null,由上层判据兜底。
 *
 * 用最小 Fake Page 直接构造 PlaywrightPageHandle,不启动真实 Chromium。
 */
import { describe, expect, it } from "vitest";
import type { Page } from "playwright";

import { PlaywrightPageHandle } from "../../src/providers/gemini/playwright-driver.js";

const CLOSED_MESSAGE = "Target page, context or browser has been closed";
const CRASHED_MESSAGE = "Target crashed";
const TRANSIENT_MESSAGE = "Execution context was destroyed, most likely because of a navigation";

interface FakeElement {
  innerText: () => Promise<string>;
  getAttribute: (name: string) => Promise<string | null>;
}

function fakeElement(overrides: Partial<FakeElement> = {}): FakeElement {
  return {
    innerText: async () => "3.6 Flash",
    getAttribute: async (name: string) => (name === "data-mode-id" ? "k-flash" : null),
    ...overrides,
  };
}

function makeHandle(elements: FakeElement[]): PlaywrightPageHandle {
  const page = {
    on: () => undefined,
    locator: () => ({
      all: async () => elements,
    }),
  } as unknown as Page;
  return new PlaywrightPageHandle(page);
}

describe("PlaywrightBrowserDriver.readAll 元素读取阶段(FIX-01)", () => {
  it("元素读取阶段页面关闭:innerText 抛关闭族异常 → 原样上抛,不降级 null", async () => {
    const handle = makeHandle([
      fakeElement(),
      fakeElement({ innerText: async () => Promise.reject(new Error(CLOSED_MESSAGE)) }),
    ]);

    await expect(handle.readAll("sel", { attrs: ["data-mode-id"] })).rejects.toThrow(
      CLOSED_MESSAGE,
    );
  });

  it("元素读取阶段 Browser 崩溃:getAttribute 抛 Target crashed → 原样上抛", async () => {
    const handle = makeHandle([
      fakeElement({
        getAttribute: async () => Promise.reject(new Error(CRASHED_MESSAGE)),
      }),
    ]);

    await expect(handle.readAll("sel", { attrs: ["data-mode-id"] })).rejects.toThrow(
      CRASHED_MESSAGE,
    );
  });

  it("普通瞬态读取失败:该字段降级 null,其余元素字段不受影响", async () => {
    const handle = makeHandle([
      fakeElement({ innerText: async () => Promise.reject(new Error(TRANSIENT_MESSAGE)) }),
      fakeElement({ innerText: async () => "3.1 Pro" }),
    ]);

    const snapshots = await handle.readAll("sel", { attrs: ["data-mode-id", "class"] });

    expect(snapshots).toEqual([
      { text: null, attrs: { "data-mode-id": "k-flash", class: null } },
      { text: "3.1 Pro", attrs: { "data-mode-id": "k-flash", class: null } },
    ]);
  });
});

/**
 * FIX-05(M2 Review 第三轮):countElements 与 readAll 同一错误语义 ——
 * 关闭族异常原样上抛(Adapter 收敛为页面生命周期错误码),普通瞬态失败仍降级 0。
 */
describe("PlaywrightBrowserDriver.countElements(FIX-05)", () => {
  function makeCountHandle(count: () => Promise<number>): PlaywrightPageHandle {
    const page = {
      on: () => undefined,
      locator: () => ({
        count,
      }),
    } as unknown as Page;
    return new PlaywrightPageHandle(page);
  }

  it("count() 抛关闭族异常(browser has disconnected)→ 原样上抛,不降级 0", async () => {
    const handle = makeCountHandle(async () => {
      throw new Error("browser has disconnected");
    });

    await expect(handle.countElements("sel")).rejects.toThrow("browser has disconnected");
  });

  it("count() 抛普通瞬态失败 → 降级 0(原有语义保留)", async () => {
    const handle = makeCountHandle(async () => {
      throw new Error(TRANSIENT_MESSAGE);
    });

    await expect(handle.countElements("sel")).resolves.toBe(0);
  });
});

/**
 * V1.3 富文本(F1):lastInnerHtml 与 readAll 同一异常语义 ——
 * 无匹配/普通瞬态失败 → null;关闭族异常(页面关闭、Browser 断连)原样上抛,
 * 绝不允许复制 lastInnerText 的 catch-all(否则上层把页面故障误判成「暂无回答」)。
 */
describe("PlaywrightBrowserDriver.lastInnerHtml(V1.3 DRV-HTML)", () => {
  function makeHtmlHandle(
    last: { count: () => Promise<number>; innerHTML: () => Promise<string> },
  ): PlaywrightPageHandle {
    const page = {
      on: () => undefined,
      locator: () => ({ last: () => last }),
    } as unknown as Page;
    return new PlaywrightPageHandle(page);
  }

  it("DRV-HTML-01 有匹配元素 → 返回 innerHTML", async () => {
    const handle = makeHtmlHandle({
      count: async () => 1,
      innerHTML: async () => "<p>hello <b>world</b></p>",
    });

    await expect(handle.lastInnerHtml("sel")).resolves.toBe("<p>hello <b>world</b></p>");
  });

  it("DRV-HTML-02 无匹配元素 → null", async () => {
    const handle = makeHtmlHandle({
      count: async () => 0,
      innerHTML: async () => "<p>should not be read</p>",
    });

    await expect(handle.lastInnerHtml("sel")).resolves.toBeNull();
  });

  it("DRV-HTML-03 普通瞬态读取失败 → null", async () => {
    const handle = makeHtmlHandle({
      count: async () => 1,
      innerHTML: async () => Promise.reject(new Error(TRANSIENT_MESSAGE)),
    });

    await expect(handle.lastInnerHtml("sel")).resolves.toBeNull();
  });

  it("DRV-HTML-04 关闭族异常(页面关闭)→ 原样上抛,不降级 null", async () => {
    const handle = makeHtmlHandle({
      count: async () => 1,
      innerHTML: async () => Promise.reject(new Error(CLOSED_MESSAGE)),
    });

    await expect(handle.lastInnerHtml("sel")).rejects.toThrow(CLOSED_MESSAGE);
  });

  it("DRV-HTML-05 关闭族异常(browser has disconnected,含 count 阶段)→ 原样上抛", async () => {
    const handle = makeHtmlHandle({
      count: async () => {
        throw new Error("browser has disconnected");
      },
      innerHTML: async () => "<p>unreachable</p>",
    });

    await expect(handle.lastInnerHtml("sel")).rejects.toThrow("browser has disconnected");
  });
});

/**
 * FINAL-FIX-01:lastInnerText 与 readAll/lastInnerHtml 收口到同一异常语义 ——
 * 它是 readAnswerContent 的 fallback 读取路径,catch-all 吞掉关闭族异常会把
 * PAGE_CLOSED/BROWSER_CRASHED 伪造成「暂无回答」(null)。
 */
describe("PlaywrightBrowserDriver.lastInnerText(FINAL-FIX-01 DRV-TEXT)", () => {
  function makeTextHandle(
    last: { count: () => Promise<number>; innerText: () => Promise<string> },
  ): PlaywrightPageHandle {
    const page = {
      on: () => undefined,
      locator: () => ({ last: () => last }),
    } as unknown as Page;
    return new PlaywrightPageHandle(page);
  }

  it("DRV-TEXT-01 有匹配元素 → 返回 innerText", async () => {
    const handle = makeTextHandle({
      count: async () => 1,
      innerText: async () => "纯文本回答",
    });

    await expect(handle.lastInnerText("sel")).resolves.toBe("纯文本回答");
  });

  it("DRV-TEXT-02 无匹配元素 → null", async () => {
    const handle = makeTextHandle({
      count: async () => 0,
      innerText: async () => "should not be read",
    });

    await expect(handle.lastInnerText("sel")).resolves.toBeNull();
  });

  it("DRV-TEXT-03 普通瞬态读取失败 → null", async () => {
    const handle = makeTextHandle({
      count: async () => 1,
      innerText: async () => Promise.reject(new Error(TRANSIENT_MESSAGE)),
    });

    await expect(handle.lastInnerText("sel")).resolves.toBeNull();
  });

  it("DRV-TEXT-04 关闭族异常(页面关闭)→ 原样上抛,不降级 null", async () => {
    const handle = makeTextHandle({
      count: async () => 1,
      innerText: async () => Promise.reject(new Error(CLOSED_MESSAGE)),
    });

    await expect(handle.lastInnerText("sel")).rejects.toThrow(CLOSED_MESSAGE);
  });
});
