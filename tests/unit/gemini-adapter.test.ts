import { describe, expect, it } from "vitest";

import { AppError } from "../../src/common/errors/app-error.js";
import { createLogger } from "../../src/common/logger/logger.js";
import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import type { BrowserManager } from "../../src/providers/gemini/browser-manager.js";
import { GeminiWebAdapter } from "../../src/providers/gemini/gemini.adapter.js";
import { GEMINI_MODEL_SELECTORS, GEMINI_SELECTORS } from "../../src/providers/gemini/gemini.selectors.js";
import type { GeminiAdapterOptions } from "../../src/providers/gemini/gemini.types.js";
import { FakeDriver, createFakeManager } from "../fakes.js";
import type { FakeModelPickerScript, FakePage, FakePageScript } from "../fakes.js";

const BASE_URL = "https://gemini.google.com/app";
const CONVERSATION_URL = "https://gemini.google.com/app/b386795e14915155";
const OTHER_CONVERSATION_URL = "https://gemini.google.com/app/7f21c9ab04de6612";
const LOGIN_URL = "https://accounts.google.com/signin/v2";

/** 单测把节奏压到毫秒级;真实默认值见 gemini.adapter.ts 的 DEFAULTS */
const FAST: GeminiAdapterOptions = {
  responseTimeoutMs: 400,
  composerReadyTimeoutMs: 60,
  sendAckTimeoutMs: 60,
  urlGraceMs: 5,
  historySettleTimeoutMs: 120,
  pollIntervalMs: 2,
  stableWindowMs: 6,
};

/**
 * 已登录新会话首页的结构快照。
 * 用完整选择器作精确 key:登录检测查的是 composer 并集,
 * 若只给 quillComposer 赋值,并集会按子串匹配拿到同一个值,场景就造不出来。
 */
const FRESH_DOM: Record<string, number> = {
  [GEMINI_SELECTORS.composer]: 1,
  [GEMINI_SELECTORS.quillComposer]: 1,
  [GEMINI_SELECTORS.signInLink]: 1,
  [GEMINI_SELECTORS.userTurn]: 0,
  [GEMINI_SELECTORS.turnShell]: 0,
  [GEMINI_SELECTORS.answer]: 0,
};

/** 第一轮发送后被页面接受的结构:外壳数 == 回答数 表示已生成完 */
const FIRST_TURN_DOM: Record<string, number> = {
  [GEMINI_SELECTORS.userTurn]: 1,
  [GEMINI_SELECTORS.turnShell]: 1,
  [GEMINI_SELECTORS.answer]: 1,
};

const logger = createLogger("silent");

/** 构造一个已 openGemini 到 READY 的 Adapter + 它正在驱动的 FakePage */
async function setup(
  script: FakePageScript = {},
  options: Partial<GeminiAdapterOptions> = {},
): Promise<{
  adapter: GeminiWebAdapter;
  page: FakePage;
  manager: BrowserManager;
}> {
  const driver = new FakeDriver();
  const manager = createFakeManager(driver, {
    ...script,
    domCounts: { ...FRESH_DOM, ...(script.domCounts ?? {}) },
  });
  await manager.openGemini();
  const page = driver.latestContext?.lastPage;
  if (!page) {
    throw new Error("fake page was not created");
  }
  const adapter = new GeminiWebAdapter({
    manager,
    baseUrl: BASE_URL,
    options: { ...FAST, ...options },
    logger,
  });
  return { adapter, page, manager };
}

type RunInput = Parameters<GeminiWebAdapter["runPrompt"]>[0];

function runInput(overrides: Partial<RunInput> = {}): RunInput {
  return {
    prompt: "只回复:收到",
    existingUrl: null,
    onConversationUrl: async () => {},
    ...overrides,
  };
}

describe("GeminiWebAdapter(FakePage 剧本,不依赖真实浏览器)", () => {
  it("未登录时两个入口都抛 PROVIDER_LOGIN_REQUIRED,且不碰页面", async () => {
    const driver = new FakeDriver();
    driver.redirectToLogin = true;
    const manager = createFakeManager(driver, { domCounts: FRESH_DOM });
    expect(await manager.openGemini()).toBe("LOGIN_REQUIRED");
    const page = driver.latestContext?.lastPage;
    if (!page) {
      throw new Error("fake page was not created");
    }
    const adapter = new GeminiWebAdapter({
      manager,
      baseUrl: BASE_URL,
      options: FAST,
      logger,
    });

    await expect(adapter.openConversation(null)).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_LOGIN_REQUIRED,
    });
    await expect(adapter.runPrompt(runInput())).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_LOGIN_REQUIRED,
    });
    // 只有 BrowserManager 自己那一次导航,Adapter 没有额外动作
    expect(page.gotoCalls).toEqual([BASE_URL]);
    expect(page.fillCalls).toEqual([]);
  });

  it("新会话入口 = 直接 goto 首页,不点侧栏按钮", async () => {
    const { adapter, page } = await setup();

    await adapter.openConversation(null);

    expect(page.gotoCalls).toEqual([BASE_URL, BASE_URL]);
  });

  it("输入框存在但不可写 → PROVIDER_DOM_CHANGED,且不按 Enter", async () => {
    const { adapter, page } = await setup({ throwOnFill: true });

    await expect(adapter.runPrompt(runInput())).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_DOM_CHANGED,
      message: expect.stringContaining("not editable"),
    });
    expect(page.pressCalls).toEqual([]);
  });

  it("输入框始终没有升级为 Quill → PROVIDER_DOM_CHANGED,且不发送", async () => {
    const { adapter, page } = await setup({
      domCounts: { [GEMINI_SELECTORS.quillComposer]: 0 },
    });

    await expect(adapter.runPrompt(runInput())).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_DOM_CHANGED,
      message: expect.stringContaining("composer is missing"),
    });
    expect(page.fillCalls).toEqual([]);
  });

  it("Enter 后页面没有接受 Prompt → PROVIDER_DOM_CHANGED", async () => {
    const { adapter, page } = await setup();

    await expect(adapter.runPrompt(runInput())).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_DOM_CHANGED,
      message: expect.stringContaining("not accepted"),
    });
    expect(page.pressCalls).toEqual([{ selector: GEMINI_SELECTORS.quillComposer, key: "Enter" }]);
  });

  it("回答稳定 → 先 await URL 落库钩子,再返回末条回答", async () => {
    const seen: string[] = [];
    const { adapter, page } = await setup({
      afterSend: {
        url: `${CONVERSATION_URL}?m=xyz#tab=history`,
        domCounts: FIRST_TURN_DOM,
        answerTexts: ["正在", "收到", "收到"],
      },
    });

    const result = await adapter.runPrompt(
      runInput({
        onConversationUrl: async (url) => {
          seen.push(url);
        },
      }),
    );

    // 钩子拿到的是规范化 URL:query/hash 不入库(prd §6.3)
    expect(seen).toEqual([CONVERSATION_URL]);
    expect(result.answer).toBe("收到");
    expect(result.conversationUrl).toBe(CONVERSATION_URL);
    expect(result.urlDetectedElapsedMs).not.toBeNull();
    expect(result.answerElapsedMs).toBeGreaterThanOrEqual(result.urlDetectedElapsedMs ?? 0);
    // 发送用 Enter 提交,不点发送按钮(aria-label 会被本地化)
    expect(page.fillCalls).toEqual([
      { selector: GEMINI_SELECTORS.quillComposer, value: "只回复:收到" },
    ]);
    expect(page.pressCalls).toHaveLength(1);
  });

  it("流式读取:onText 逐段收到增长的完整文本,重复读取不重推", async () => {
    const texts: string[] = [];
    const { adapter, page } = await setup({
      afterSend: {
        url: CONVERSATION_URL,
        domCounts: FIRST_TURN_DOM,
        answerTexts: ["正在", "正在处理", "正在处理完成", "正在处理完成"],
      },
    });

    const result = await adapter.runPrompt(
      runInput({ onText: async (text) => void texts.push(text) }),
    );

    expect(texts).toEqual(["正在", "正在处理", "正在处理完成"]);
    expect(result.answer).toBe("正在处理完成");
    // 生成期间就在读文本(不再是「完成后只读一次」)
    expect(page.lastInnerTextCalls).toBeGreaterThan(3);
  });

  it("onText 抛错(流式落库失败)→ 整次执行失败,绝不继续读回答", async () => {
    const { adapter } = await setup({
      afterSend: { url: CONVERSATION_URL, domCounts: FIRST_TURN_DOM, answerTexts: ["正在", "正在"] },
    });

    await expect(
      adapter.runPrompt(
        runInput({
          onText: async () => {
            throw new AppError(ErrorCodes.STREAMING_UPDATE_FAILED, "streaming update failed");
          },
        }),
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.STREAMING_UPDATE_FAILED });
  });

  it("落库钩子抛错 → 整次执行失败且从不读回答(prd §6.3)", async () => {
    const { adapter, page } = await setup({
      afterSend: { url: CONVERSATION_URL, domCounts: FIRST_TURN_DOM, answerTexts: ["收到"] },
    });

    await expect(
      adapter.runPrompt(
        runInput({
          onConversationUrl: async () => {
            throw new Error("db write failed");
          },
        }),
      ),
    ).rejects.toThrow("db write failed");
    expect(page.lastInnerTextCalls).toBe(0);
  });

  it("回答完成但始终没有会话 URL → PROVIDER_DOM_CHANGED", async () => {
    const { adapter } = await setup({
      afterSend: { domCounts: FIRST_TURN_DOM, answerTexts: ["收到", "收到"] },
    });

    await expect(adapter.runPrompt(runInput())).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_DOM_CHANGED,
      message: expect.stringContaining("conversation url"),
    });
  });

  it("回答文本永不停稳 → PROVIDER_RESPONSE_TIMEOUT 且全程不自动重试", async () => {
    const { adapter, page } = await setup({
      neverStable: true,
      afterSend: { url: CONVERSATION_URL, domCounts: FIRST_TURN_DOM },
    });

    await expect(adapter.runPrompt(runInput())).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_RESPONSE_TIMEOUT,
    });
    expect(page.fillCalls).toHaveLength(1);
    expect(page.pressCalls).toHaveLength(1);
    expect(page.gotoCalls).toEqual([BASE_URL]); // 没有重新导航重试
  });

  it("执行途中页面被关闭 → PROVIDER_PAGE_CLOSED", async () => {
    const { adapter, page } = await setup({
      afterSend: { url: CONVERSATION_URL, domCounts: FIRST_TURN_DOM, answerTexts: ["收到"] },
    });

    await expect(
      adapter.runPrompt(
        runInput({
          onConversationUrl: async () => {
            page.emitClosed();
          },
        }),
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.PROVIDER_PAGE_CLOSED });
    expect(page.lastInnerTextCalls).toBe(0);
  });

  it("已存会话被踢回 /app → PROVIDER_CONVERSATION_UNAVAILABLE 且不新建会话", async () => {
    const { adapter, page } = await setup();
    page.navLandsUrl = BASE_URL;

    await expect(adapter.openConversation(CONVERSATION_URL)).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_CONVERSATION_UNAVAILABLE,
    });
    // 只有那一次目标导航,失败后没有再 goto 首页
    expect(page.gotoCalls).toEqual([BASE_URL, CONVERSATION_URL]);
  });

  it("已存会话跳到了别的会话 id → PROVIDER_CONVERSATION_UNAVAILABLE", async () => {
    const { adapter, page } = await setup();
    page.navLandsUrl = OTHER_CONVERSATION_URL;

    await expect(adapter.openConversation(CONVERSATION_URL)).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_CONVERSATION_UNAVAILABLE,
    });
  });

  it("已存会话被跳离 Gemini 域(登录失效)→ PROVIDER_LOGIN_REQUIRED", async () => {
    const { adapter, page } = await setup();
    page.navLandsUrl = LOGIN_URL;

    await expect(adapter.openConversation(CONVERSATION_URL)).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_LOGIN_REQUIRED,
    });
  });

  it("复用已存会话:校验通过后在原会话发送,URL 只 goto 不新建", async () => {
    const seen: string[] = [];
    const { adapter, page } = await setup({
      domCounts: {
        [GEMINI_SELECTORS.userTurn]: 1,
        [GEMINI_SELECTORS.turnShell]: 1,
        [GEMINI_SELECTORS.answer]: 1,
      },
      afterSend: {
        domCounts: {
          [GEMINI_SELECTORS.userTurn]: 2,
          [GEMINI_SELECTORS.turnShell]: 2,
          [GEMINI_SELECTORS.answer]: 2,
        },
        answerTexts: ["收到", "收到"],
      },
    });

    await adapter.openConversation(CONVERSATION_URL);
    const result = await adapter.runPrompt(
      runInput({ existingUrl: CONVERSATION_URL, onConversationUrl: async (u) => void seen.push(u) }),
    );

    expect(page.gotoCalls).toEqual([BASE_URL, CONVERSATION_URL]);
    expect(seen).toEqual([CONVERSATION_URL]);
    expect(result.answer).toBe("收到");
  });

  it("上一条回答已存在时,必须等新回答出现才算完成(防读到自己)", async () => {
    const { adapter, page } = await setup({
      domCounts: {
        [GEMINI_SELECTORS.userTurn]: 1,
        [GEMINI_SELECTORS.turnShell]: 1,
        [GEMINI_SELECTORS.answer]: 1,
      },
      answerTexts: ["上一条", "上一条"],
      afterSend: {
        domCounts: {
          [GEMINI_SELECTORS.userTurn]: 2,
          [GEMINI_SELECTORS.turnShell]: 2,
          [GEMINI_SELECTORS.answer]: 2,
        },
        answerTexts: ["新一条", "新一条"],
      },
    });

    await adapter.openConversation(CONVERSATION_URL);
    const result = await adapter.runPrompt(runInput({ existingUrl: CONVERSATION_URL }));

    expect(result.answer).toBe("新一条");
    expect(page.lastInnerTextCalls).toBeGreaterThan(0);
  });

  // 实测(2026-09-03 人工验收 2):历史未渲染完就发送,Gemini 客户端会在缺少上文时提交 Prompt
  it("复用会话:等历史轮次停止变化后才发送", async () => {
    const { adapter, page } = await setup({
      turnSamples: [0, 1, 2, 3],
      domCounts: {
        [GEMINI_SELECTORS.turnShell]: 3,
        [GEMINI_SELECTORS.answer]: 3,
      },
      afterSend: {
        domCounts: {
          [GEMINI_SELECTORS.userTurn]: 4,
          [GEMINI_SELECTORS.turnShell]: 4,
          [GEMINI_SELECTORS.answer]: 4,
        },
        answerTexts: ["青瓷9527", "青瓷9527"],
      },
    });

    await adapter.openConversation(CONVERSATION_URL);
    const result = await adapter.runPrompt(runInput({ existingUrl: CONVERSATION_URL }));

    expect(page.rampPendingAtFill).toBe(0); // 水合剧本吐完才 fill
    expect(result.answer).toBe("青瓷9527");
  });

  it("复用会话:历史轮次一直变化 → PROVIDER_DOM_CHANGED 且从不发送", async () => {
    const ramp = Array.from({ length: 400 }, (_, i) => i);
    const { adapter, page } = await setup(
      { turnSamples: ramp },
      { historySettleTimeoutMs: 30 },
    );

    await expect(adapter.openConversation(CONVERSATION_URL)).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_DOM_CHANGED,
    });
    expect(page.fillCalls).toHaveLength(0);
    expect(page.pressCalls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 停止按钮多候选(第 9 阶段 §二):遍历 stopButtonSelectors → click → 三条件确认
  // ---------------------------------------------------------------------------

  const STOP_SEL = GEMINI_SELECTORS.stopButtonSelectors;

  /** abort 信号在 URL 落库钩子里触发:保证进入 waitForAnswer 轮询后才取消 */
  function abortOnUrl(controller: AbortController) {
    return async () => {
      controller.abort();
    };
  }

  it("停止按钮只在第二候选命中 → 跳过第一候选,点击第二候选并确认取消", async () => {
    const controller = new AbortController();
    const { adapter, page } = await setup({
      afterSend: {
        url: CONVERSATION_URL,
        domCounts: { ...FIRST_TURN_DOM, [STOP_SEL[0]]: 0, [STOP_SEL[1]]: 1 },
        answerTexts: ["生成中", "生成中"],
      },
      afterStopClick: {
        domCounts: { [STOP_SEL[0]]: 0, [STOP_SEL[1]]: 0 },
        answerTexts: ["部分", "部分"],
      },
    });

    const result = await adapter.runPrompt(
      runInput({ signal: controller.signal, onConversationUrl: abortOnUrl(controller) }),
    );

    expect(result.cancelled).toBe(true);
    expect(result.answer).toBe("部分");
    // 第一候选计数为 0 直接跳过(clickCalls 只记录实际尝试),点击落在第二候选
    expect(page.clickCalls).toEqual([STOP_SEL[1]]);
  });

  it("第一候选点击抛错 → 依次换下一个候选,不重试整轮", async () => {
    const controller = new AbortController();
    const { adapter, page } = await setup({
      throwOnClickSelectors: [STOP_SEL[0]],
      afterSend: {
        url: CONVERSATION_URL,
        domCounts: { ...FIRST_TURN_DOM, [STOP_SEL[0]]: 1, [STOP_SEL[1]]: 1 },
        answerTexts: ["生成中", "生成中"],
      },
      afterStopClick: {
        domCounts: { [STOP_SEL[0]]: 0, [STOP_SEL[1]]: 0 },
        answerTexts: ["部分", "部分"],
      },
    });

    const result = await adapter.runPrompt(
      runInput({ signal: controller.signal, onConversationUrl: abortOnUrl(controller) }),
    );

    expect(result.cancelled).toBe(true);
    // 候选 1 失败后换候选 2 成功;总长 2 = 只遍历了一轮,没有整轮重试
    expect(page.clickCalls).toEqual([STOP_SEL[0], STOP_SEL[1]]);
  });

  it("abort 时页面已无停止按钮 → cancelled:false 走 SUCCESS 判定,不发点击", async () => {
    const controller = new AbortController();
    const { adapter, page } = await setup({
      afterSend: { url: CONVERSATION_URL, domCounts: FIRST_TURN_DOM, answerTexts: ["收到", "收到"] },
    });

    const result = await adapter.runPrompt(
      runInput({ signal: controller.signal, onConversationUrl: abortOnUrl(controller) }),
    );

    expect(result.cancelled).toBe(false);
    expect(result.answer).toBe("收到");
    expect(page.clickCalls).toEqual([]);
  });

  it("点击后按钮仍在且文本不停 → 确认窗口耗尽 PROVIDER_CANCELLATION_UNCONFIRMED", async () => {
    const controller = new AbortController();
    const { adapter, page } = await setup(
      {
        neverStable: true,
        afterSend: {
          url: CONVERSATION_URL,
          domCounts: { ...FIRST_TURN_DOM, [STOP_SEL[0]]: 1 },
        },
        // 不配 afterStopClick:按钮留在页面上 = 停止始终未被确认
      },
      { stopConfirmTimeoutMs: 40 },
    );

    await expect(
      adapter.runPrompt(
        runInput({ signal: controller.signal, onConversationUrl: abortOnUrl(controller) }),
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.PROVIDER_CANCELLATION_UNCONFIRMED });
    // 只遍历一轮候选,没有整轮重试
    expect(page.clickCalls).toEqual([STOP_SEL[0]]);
  });

  // ---------------------------------------------------------------------------
  // 模型目录读取 + 模型切换(M2 §二十六~§二十八)
  // ---------------------------------------------------------------------------

  const MODEL_SEL = GEMINI_MODEL_SELECTORS;
  /** 菜单开合/确认窗口压到毫秒级(生产默认 5s,见 gemini.adapter.ts DEFAULTS) */
  const MENU_FAST: GeminiAdapterOptions = { ...FAST, modelMenuTimeoutMs: 40 };

  /** M0 实测形态:三模型目录,Raciocínio 选中;键用可读伪 key,opaque key 由专项测试覆盖 */
  function pickerScript(overrides: Partial<FakeModelPickerScript> = {}): FakeModelPickerScript {
    return {
      options: [
        { key: "k-flash", label: "3.6 Flash" },
        { key: "k-raciocinio", label: "3.6 Raciocínio", selected: true },
        { key: "k-pro", label: "3.1 Pro" },
      ],
      ...overrides,
    };
  }

  describe("listModels(M2 §二十六)", () => {
    it("LM-01 正常三模型:catalog 完整,退出后菜单恢复关闭", async () => {
      const { adapter, page } = await setup({ modelPicker: pickerScript() }, MENU_FAST);

      const catalog = await adapter.listModels();

      expect(catalog.models).toEqual([
        { key: "k-flash", label: "3.6 Flash", selected: false, disabled: false },
        { key: "k-raciocinio", label: "3.6 Raciocínio", selected: true, disabled: false },
        { key: "k-pro", label: "3.1 Pro", selected: false, disabled: false },
      ]);
      expect(catalog.currentModelKey).toBe("k-raciocinio");
      expect(await page.countElements(MODEL_SEL.modeMenu)).toBe(0);
    });

    it("LM-02 selected 判定:选中态来自 class token,currentModelKey 指向它", async () => {
      const { adapter } = await setup(
        {
          modelPicker: pickerScript({
            options: [
              { key: "a", label: "A" },
              { key: "b", label: "B" },
              { key: "c", label: "C", selected: true },
            ],
          }),
        },
        MENU_FAST,
      );

      const catalog = await adapter.listModels();

      expect(catalog.models.map((model) => model.selected)).toEqual([false, false, true]);
      expect(catalog.currentModelKey).toBe("c");
    });

    it("LM-03 data-active 是焦点高亮不是选中:不影响 selected,且从不读取该属性", async () => {
      const { adapter, page } = await setup(
        {
          modelPicker: pickerScript({
            options: [
              { key: "k-flash", label: "3.6 Flash", extraAttrs: { "data-active": "true" } },
              { key: "k-pro", label: "3.1 Pro", selected: true },
            ],
          }),
        },
        MENU_FAST,
      );

      const catalog = await adapter.listModels();

      expect(catalog.currentModelKey).toBe("k-pro");
      expect(catalog.models[0]).toMatchObject({ key: "k-flash", selected: false });
      // Adapter 只请求四个判据属性,data-active 永远不进入判定
      expect(page.readAllCalls[0]?.selector).toBe(MODEL_SEL.modeOption);
      expect(page.readAllCalls[0]?.attrs).toEqual([
        "data-mode-id",
        "class",
        "aria-disabled",
        "disabled",
      ]);
    });

    it("LM-04 disabled 解析:三种判据各自命中;aria-disabled=false 不算禁用", async () => {
      const { adapter } = await setup(
        {
          modelPicker: pickerScript({
            options: [
              { key: "d1", label: "D1", ariaDisabled: true },
              { key: "d2", label: "D2", disabledAttr: true },
              { key: "d3", label: "D3", classTokens: ["disabled"] },
              { key: "ok", label: "OK" },
            ],
          }),
        },
        MENU_FAST,
      );

      const catalog = await adapter.listModels();

      expect(catalog.models.map((model) => model.disabled)).toEqual([true, true, true, false]);
    });

    it("LM-05 缺 data-mode-id → PROVIDER_DOM_CHANGED,失败路径也恢复页面", async () => {
      const { adapter, page } = await setup(
        {
          modelPicker: pickerScript({
            options: [{ label: "NoKey" }, { key: "b", label: "B" }],
          }),
        },
        MENU_FAST,
      );

      await expect(adapter.listModels()).rejects.toMatchObject({
        code: ErrorCodes.PROVIDER_DOM_CHANGED,
        message: expect.stringContaining("data-mode-id"),
      });
      expect(await page.countElements(MODEL_SEL.modeMenu)).toBe(0);
    });

    it("LM-06 重复 mode-id → PROVIDER_DOM_CHANGED(禁止猜测)", async () => {
      const { adapter } = await setup(
        {
          modelPicker: pickerScript({
            options: [
              { key: "dup", label: "A" },
              { key: "dup", label: "B" },
            ],
          }),
        },
        MENU_FAST,
      );

      await expect(adapter.listModels()).rejects.toMatchObject({
        code: ErrorCodes.PROVIDER_DOM_CHANGED,
        message: expect.stringContaining("duplicate"),
      });
    });

    it("LM-07 label 取首个非空行:多行菜单项不拼描述", async () => {
      const { adapter } = await setup(
        {
          modelPicker: pickerScript({
            options: [
              { key: "pro", label: "3.1 Pro\nRaciocínio avançado" },
              { key: "flash", label: "\n  3.6 Flash  \nAjuda para tudo" },
            ],
          }),
        },
        MENU_FAST,
      );

      const catalog = await adapter.listModels();

      expect(catalog.models.map((model) => model.label)).toEqual(["3.1 Pro", "3.6 Flash"]);
    });

    it("LM-08 多个 selected → PROVIDER_DOM_CHANGED", async () => {
      const { adapter } = await setup(
        {
          modelPicker: pickerScript({
            options: [
              { key: "a", label: "A", selected: true },
              { key: "b", label: "B", selected: true },
            ],
          }),
        },
        MENU_FAST,
      );

      await expect(adapter.listModels()).rejects.toMatchObject({
        code: ErrorCodes.PROVIDER_DOM_CHANGED,
        message: expect.stringContaining("multiple selected"),
      });
    });

    it("LM-09 无 selected → currentModelKey = null(目录类型允许)", async () => {
      const { adapter } = await setup(
        {
          modelPicker: pickerScript({
            options: [
              { key: "a", label: "A" },
              { key: "b", label: "B" },
            ],
          }),
        },
        MENU_FAST,
      );

      const catalog = await adapter.listModels();

      expect(catalog.models.map((model) => model.selected)).toEqual([false, false]);
      expect(catalog.currentModelKey).toBeNull();
    });

    it("LM-10 菜单初始关闭:打开 → 读取 → 关闭(两次 trigger 点击)", async () => {
      const { adapter, page } = await setup({ modelPicker: pickerScript() }, MENU_FAST);

      await adapter.listModels();

      expect(page.clickCalls).toEqual([MODEL_SEL.modeTrigger, MODEL_SEL.modeTrigger]);
      expect(page.readAllCalls).toEqual([
        { selector: MODEL_SEL.modeOption, attrs: ["data-mode-id", "class", "aria-disabled", "disabled"] },
      ]);
    });

    it("LM-11 菜单初始已打开:不重复点开,读取后关闭", async () => {
      const { adapter, page } = await setup(
        { modelPicker: pickerScript({ initiallyOpen: true }) },
        MENU_FAST,
      );

      const catalog = await adapter.listModels();

      expect(catalog.currentModelKey).toBe("k-raciocinio");
      // 只有关闭那一次 trigger 点击
      expect(page.clickCalls).toEqual([MODEL_SEL.modeTrigger]);
      expect(page.readAllCalls).toHaveLength(1);
      expect(await page.countElements(MODEL_SEL.modeMenu)).toBe(0);
    });

    it("LM-12 读取后页面被关闭 → PROVIDER_PAGE_CLOSED", async () => {
      const { adapter, page } = await setup(
        { modelPicker: pickerScript({ onReadAll: () => page.emitClosed() }) },
        MENU_FAST,
      );

      await expect(adapter.listModels()).rejects.toMatchObject({
        code: ErrorCodes.PROVIDER_PAGE_CLOSED,
      });
    });

    it("LM-13 读取后 renderer 崩溃 → PROVIDER_BROWSER_CRASHED", async () => {
      const { adapter, page } = await setup(
        { modelPicker: pickerScript({ onReadAll: () => page.emitCrashed() }) },
        MENU_FAST,
      );

      await expect(adapter.listModels()).rejects.toMatchObject({
        code: ErrorCodes.PROVIDER_BROWSER_CRASHED,
      });
    });

    // FIX-01(Review):真正覆盖「locator.all() 成功 → 元素读取阶段页面死亡」时间点
    it("FIX-01 元素读取阶段页面关闭:all() 已成功 → PROVIDER_PAGE_CLOSED,不降级 DOM_CHANGED", async () => {
      const { adapter, page } = await setup(
        { modelPicker: pickerScript({ failElementRead: "closed" }) },
        MENU_FAST,
      );

      await expect(adapter.listModels()).rejects.toMatchObject({
        code: ErrorCodes.PROVIDER_PAGE_CLOSED,
      });
      // readAll 已真实发生(不是在读取前就失败)
      expect(page.readAllCalls).toHaveLength(1);
    });

    it("FIX-01 元素读取阶段崩溃:all() 已成功 → PROVIDER_BROWSER_CRASHED", async () => {
      const { adapter, page } = await setup(
        { modelPicker: pickerScript({ failElementRead: "crash" }) },
        MENU_FAST,
      );

      await expect(adapter.listModels()).rejects.toMatchObject({
        code: ErrorCodes.PROVIDER_BROWSER_CRASHED,
      });
      expect(page.readAllCalls).toHaveLength(1);
    });

    it("FIX-04 元素读取阶段 Browser 断连(页面状态未落地)→ PROVIDER_BROWSER_CRASHED,不裸抛", async () => {
      const { adapter, page } = await setup(
        { modelPicker: pickerScript({ failElementRead: "disconnected" }) },
        MENU_FAST,
      );

      await expect(adapter.listModels()).rejects.toMatchObject({
        code: ErrorCodes.PROVIDER_BROWSER_CRASHED,
      });
      expect(page.readAllCalls).toHaveLength(1);
    });

    // FIX-02(Review):菜单容器先可见、选项后渲染的正常时序
    it("FIX-02 选项延迟出现:容器先可见,选项稍后渲染 → listModels 成功且 readAll 只调一次", async () => {
      const { adapter, page } = await setup(
        { modelPicker: pickerScript({ optionLagReads: 2 }) },
        MENU_FAST,
      );

      const catalog = await adapter.listModels();

      expect(catalog.currentModelKey).toBe("k-raciocinio");
      expect(page.readAllCalls).toHaveLength(1);
      expect(page.clickCalls).toEqual([MODEL_SEL.modeTrigger, MODEL_SEL.modeTrigger]);
    });

    it("FIX-02 选项始终不出现:容器已开但超时无选项 → PROVIDER_DOM_CHANGED,从不 readAll", async () => {
      const { adapter, page } = await setup(
        { modelPicker: pickerScript({ optionLagReads: 1000 }) },
        MENU_FAST,
      );

      await expect(adapter.listModels()).rejects.toMatchObject({
        code: ErrorCodes.PROVIDER_DOM_CHANGED,
        message: expect.stringContaining("contains no model options"),
      });
      expect(page.readAllCalls).toEqual([]);
    });

    it("FIX-02 等待选项时页面被关闭 → PROVIDER_PAGE_CLOSED(等待循环逐轮消歧)", async () => {
      const { adapter, page } = await setup(
        { modelPicker: pickerScript({ onOptionCount: () => page.emitClosed() }) },
        MENU_FAST,
      );

      await expect(adapter.listModels()).rejects.toMatchObject({
        code: ErrorCodes.PROVIDER_PAGE_CLOSED,
      });
      // 关闭发生在选项等待期,还没走到 readAll
      expect(page.readAllCalls).toEqual([]);
    });

    // FIX-05(Review 第三轮):断连竞态 —— Playwright 先抛 "browser has disconnected",
    // 页面 isClosed/isCrashed 均未落地;生命周期故障不得包装成 DOM_CHANGED
    it("FIX-05 打开菜单时 trigger click 断连(页面状态未落地)→ PROVIDER_BROWSER_CRASHED,不降级 DOM_CHANGED", async () => {
      const { adapter, page } = await setup(
        { modelPicker: pickerScript({ failTriggerClick: "disconnected" }) },
        MENU_FAST,
      );

      await expect(adapter.listModels()).rejects.toMatchObject({
        code: ErrorCodes.PROVIDER_BROWSER_CRASHED,
      });
      expect(page.clickCalls).toEqual([MODEL_SEL.modeTrigger]);
      expect(page.readAllCalls).toEqual([]);
    });

    it("FIX-05 等待选项时 count 断连(页面状态未落地)→ PROVIDER_BROWSER_CRASHED,不降级成 DOM_CHANGED", async () => {
      const { adapter, page } = await setup(
        {
          modelPicker: pickerScript({ initiallyOpen: true, failOptionCount: "disconnected" }),
        },
        MENU_FAST,
      );

      await expect(adapter.listModels()).rejects.toMatchObject({
        code: ErrorCodes.PROVIDER_BROWSER_CRASHED,
      });
      // 断连发生在选项等待期(菜单 fast path 已开,不点 trigger),从未 readAll
      expect(page.clickCalls).toEqual([]);
      expect(page.readAllCalls).toEqual([]);
    });
  });

  describe("ensureModel(M2 §二十七)", () => {
    it("EM-01 当前模型已是目标:不点击选项,开合菜单后返回", async () => {
      const { adapter, page } = await setup({ modelPicker: pickerScript() }, MENU_FAST);

      const resolved = await adapter.ensureModel("k-raciocinio");

      expect(resolved).toEqual({ key: "k-raciocinio", label: "3.6 Raciocínio" });
      expect(page.clickNthCalls).toEqual([]);
      // 开 + 关
      expect(page.clickCalls).toEqual([MODEL_SEL.modeTrigger, MODEL_SEL.modeTrigger]);
      expect(await page.countElements(MODEL_SEL.modeMenu)).toBe(0);
    });

    it("EM-02 切换 A→B:按目录 index 点击,重开菜单验证后返回 B", async () => {
      const { adapter, page } = await setup({ modelPicker: pickerScript() }, MENU_FAST);

      const resolved = await adapter.ensureModel("k-pro");

      expect(resolved).toEqual({ key: "k-pro", label: "3.1 Pro" });
      expect(page.clickNthCalls).toEqual([{ selector: MODEL_SEL.modeOption, index: 2 }]);
      // 打开 → 点击(自动关)→ 重开验证 → 关闭:共 3 次 trigger 点击
      expect(page.clickCalls).toEqual([
        MODEL_SEL.modeTrigger,
        MODEL_SEL.modeTrigger,
        MODEL_SEL.modeTrigger,
      ]);
      expect(page.readAllCalls).toHaveLength(2);
      // Fake 页面状态里选中态真的切过去了
      const after = await adapter.listModels();
      expect(after.currentModelKey).toBe("k-pro");
    });

    it("EM-03 目标不存在 → PROVIDER_MODEL_UNAVAILABLE,不点击任何选项", async () => {
      const { adapter, page } = await setup({ modelPicker: pickerScript() }, MENU_FAST);

      await expect(adapter.ensureModel("missing-key")).rejects.toMatchObject({
        code: ErrorCodes.PROVIDER_MODEL_UNAVAILABLE,
      });
      expect(page.clickNthCalls).toEqual([]);
      expect(await page.countElements(MODEL_SEL.modeMenu)).toBe(0);
    });

    it("EM-04 目标明确 disabled → PROVIDER_MODEL_UNAVAILABLE,不点击", async () => {
      const { adapter, page } = await setup(
        {
          modelPicker: pickerScript({
            options: [
              { key: "k-flash", label: "3.6 Flash" },
              { key: "k-raciocinio", label: "3.6 Raciocínio", selected: true },
              { key: "k-pro", label: "3.1 Pro", classTokens: ["disabled"] },
            ],
          }),
        },
        MENU_FAST,
      );

      await expect(adapter.ensureModel("k-pro")).rejects.toMatchObject({
        code: ErrorCodes.PROVIDER_MODEL_UNAVAILABLE,
      });
      expect(page.clickNthCalls).toEqual([]);
    });

    it("EM-05 点击后选中态未变(菜单已关)→ PROVIDER_MODEL_SWITCH_FAILED", async () => {
      const { adapter, page } = await setup(
        { modelPicker: pickerScript({ onClickOption: "close-only" }) },
        MENU_FAST,
      );

      await expect(adapter.ensureModel("k-pro")).rejects.toMatchObject({
        code: ErrorCodes.PROVIDER_MODEL_SWITCH_FAILED,
      });
      expect(page.clickNthCalls).toEqual([{ selector: MODEL_SEL.modeOption, index: 2 }]);
      // 重开菜单重读验证过一次,失败路径仍恢复页面
      expect(page.readAllCalls).toHaveLength(2);
      expect(await page.countElements(MODEL_SEL.modeMenu)).toBe(0);
    });

    it("EM-05b 点击后菜单不自动关闭 → PROVIDER_MODEL_SWITCH_FAILED,收尾恢复页面", async () => {
      const { adapter, page } = await setup(
        { modelPicker: pickerScript({ onClickOption: "noop" }) },
        MENU_FAST,
      );

      await expect(adapter.ensureModel("k-pro")).rejects.toMatchObject({
        code: ErrorCodes.PROVIDER_MODEL_SWITCH_FAILED,
        message: expect.stringContaining("did not close"),
      });
      expect(page.clickNthCalls).toHaveLength(1);
      expect(page.readAllCalls).toHaveLength(1); // 没有进入重开验证
      expect(await page.countElements(MODEL_SEL.modeMenu)).toBe(0);
    });

    it("EM-06 trigger 在但菜单打不开 → PROVIDER_DOM_CHANGED(不是 SWITCH_FAILED)", async () => {
      const { adapter } = await setup(
        { modelPicker: pickerScript({ opensOnClick: false }) },
        MENU_FAST,
      );

      await expect(adapter.ensureModel("k-pro")).rejects.toMatchObject({
        code: ErrorCodes.PROVIDER_DOM_CHANGED,
        message: expect.stringContaining("did not open"),
      });
    });

    it("EM-07 点击时页面已关闭 → PROVIDER_PAGE_CLOSED(不包装成 SWITCH_FAILED)", async () => {
      const { adapter, page } = await setup(
        { modelPicker: pickerScript({ onReadAll: () => page.emitClosed() }) },
        MENU_FAST,
      );

      await expect(adapter.ensureModel("k-pro")).rejects.toMatchObject({
        code: ErrorCodes.PROVIDER_PAGE_CLOSED,
      });
      // Fake 对已关页面的点击直接抛关闭族异常,不会留下点击记录
      expect(page.clickNthCalls).toEqual([]);
    });

    it("EM-08 点击时 renderer 已崩溃 → PROVIDER_BROWSER_CRASHED", async () => {
      const { adapter, page } = await setup(
        { modelPicker: pickerScript({ onReadAll: () => page.emitCrashed() }) },
        MENU_FAST,
      );

      await expect(adapter.ensureModel("k-pro")).rejects.toMatchObject({
        code: ErrorCodes.PROVIDER_BROWSER_CRASHED,
      });
      expect(page.clickNthCalls).toEqual([]);
    });

    it("EM-09 打开菜单读取后、点击前 abort → 不点击不关菜单,抛 signal.reason", async () => {
      const controller = new AbortController();
      let reads = 0;
      const { adapter, page } = await setup(
        {
          modelPicker: pickerScript({
            onReadAll: () => {
              reads += 1;
              if (reads === 1) {
                controller.abort();
              }
            },
          }),
        },
        MENU_FAST,
      );

      await expect(adapter.ensureModel("k-pro", controller.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(page.clickNthCalls).toEqual([]);
      // 只有打开菜单那一次 trigger 点击;「立即停止」连关闭菜单都不做
      expect(page.clickCalls).toEqual([MODEL_SEL.modeTrigger]);
      expect(page.readAllCalls).toHaveLength(1);
    });

    it("EM-09b 进入前已 abort → 一个 DOM 操作都不做", async () => {
      const controller = new AbortController();
      controller.abort();
      const { adapter, page } = await setup({ modelPicker: pickerScript() }, MENU_FAST);

      await expect(adapter.ensureModel("k-pro", controller.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(page.clickCalls).toEqual([]);
      expect(page.clickNthCalls).toEqual([]);
      expect(page.readAllCalls).toEqual([]);
    });

    it("EM-10 点击后 abort → 不等菜单、不重开验证,立即停止", async () => {
      const controller = new AbortController();
      const { adapter, page } = await setup(
        { modelPicker: pickerScript({ onOptionClick: () => controller.abort() }) },
        MENU_FAST,
      );

      await expect(adapter.ensureModel("k-pro", controller.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(page.clickNthCalls).toEqual([{ selector: MODEL_SEL.modeOption, index: 2 }]);
      expect(page.clickCalls).toEqual([MODEL_SEL.modeTrigger]);
      expect(page.readAllCalls).toHaveLength(1);
    });

    it("FIX-05 点击目标模型时断连(页面状态未落地)→ PROVIDER_BROWSER_CRASHED,不包装成 MODEL_SWITCH_FAILED", async () => {
      const { adapter, page } = await setup(
        { modelPicker: pickerScript({ onClickOption: "disconnect" }) },
        MENU_FAST,
      );

      await expect(adapter.ensureModel("k-flash")).rejects.toMatchObject({
        code: ErrorCodes.PROVIDER_BROWSER_CRASHED,
      });
      expect(page.clickNthCalls).toHaveLength(1);
    });

    it("opaque key(model:key/with+special?chars):按 index 定位,selector 全程不含 key", async () => {
      const opaque = "model:key/with+special?chars";
      const { adapter, page } = await setup(
        {
          modelPicker: pickerScript({
            options: [
              { key: opaque, label: "Opaque" },
              { key: "k-pro", label: "3.1 Pro", selected: true },
            ],
          }),
        },
        MENU_FAST,
      );

      const catalog = await adapter.listModels();
      expect(catalog.models[0]?.key).toBe(opaque);
      expect(catalog.currentModelKey).toBe("k-pro");

      const resolved = await adapter.ensureModel(opaque);
      expect(resolved).toEqual({ key: opaque, label: "Opaque" });
      expect(page.clickNthCalls).toEqual([{ selector: MODEL_SEL.modeOption, index: 0 }]);
      // 证明实现没有把 modelKey 拼进 CSS selector:所有调用都是固定 selector
      for (const call of page.readAllCalls) {
        expect(call.selector).toBe(MODEL_SEL.modeOption);
      }
      for (const selector of page.clickCalls) {
        expect(selector).toBe(MODEL_SEL.modeTrigger);
      }
    });
  });
});
