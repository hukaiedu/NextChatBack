import { afterEach, describe, expect, it } from "vitest";

import { createLogger } from "../../src/common/logger/logger.js";
import { GeminiWebAdapter } from "../../src/providers/gemini/gemini.adapter.js";
import type { BrowserManager } from "../../src/providers/gemini/browser-manager.js";
import { GEMINI_SELECTORS } from "../../src/providers/gemini/gemini.selectors.js";
import type { GeminiAdapterOptions } from "../../src/providers/gemini/gemini.types.js";
import { FakeDriver, createFakeManager } from "../fakes.js";
import type { FakePage } from "../fakes.js";
import { createConversation, sendMessage, setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

const BASE_URL = "https://gemini.google.com/app";
const CONV_A_URL = `${BASE_URL}/nav0000conv0001`;
const CONV_B_URL = `${BASE_URL}/nav0000conv0002`;

/** 单测节奏压到毫秒级;真实默认值见 gemini.adapter.ts 的 DEFAULTS */
const NAV_FAST: GeminiAdapterOptions = {
  responseTimeoutMs: 3000,
  composerReadyTimeoutMs: 800,
  sendAckTimeoutMs: 1500,
  urlGraceMs: 10,
  historySettleTimeoutMs: 1000,
  pollIntervalMs: 10,
  stableWindowMs: 40,
};

const logger = createLogger("silent");

function lastPage(driver: FakeDriver): FakePage {
  const page = driver.latestContext?.lastPage;
  if (!page) {
    throw new Error("fake page was not created");
  }
  return page;
}

/**
 * 每次按 Enter = 一轮新回答:轮次计数相对上一轮 +1(send-ack 判据是「本轮新增」),
 * URL 按按下次数从 urls 取 —— providerConversationUrl 是 @unique,不同会话必须报
 * 不同 URL;同一会话必须始终报它已绑定的 URL(服务层拒绝把已绑定会话改绑到别的 URL)。
 */
function wireTurns(driver: FakeDriver, urls: string[]): void {
  const launch = driver.launchPersistentContext.bind(driver);
  driver.launchPersistentContext = async () => {
    const context = await launch();
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = (await newPage()) as FakePage;
      let turn = 0;
      const press = page.press.bind(page);
      page.press = async (selector, key) => {
        await press(selector, key);
        turn += 1;
        page.currentUrl = urls[Math.min(turn, urls.length) - 1];
        page.domCounts = {
          ...page.domCounts,
          [GEMINI_SELECTORS.userTurn]: turn,
          [GEMINI_SELECTORS.turnShell]: turn,
          [GEMINI_SELECTORS.answer]: turn,
        };
      };
      return page;
    };
    return context;
  };
}

interface NavContext {
  ctx: TestContext;
  driver: FakeDriver;
}

/** 真 GeminiWebAdapter + 真 Scheduler(手动 runOnce 驱动)+ 真 SQLite */
async function setupNav(urls: string[] = [CONV_A_URL, CONV_B_URL]): Promise<NavContext> {
  const driver = new FakeDriver();
  wireTurns(driver, urls);
  const manager: BrowserManager = createFakeManager(driver, {
    domCounts: {
      [GEMINI_SELECTORS.composer]: 1,
      [GEMINI_SELECTORS.quillComposer]: 1,
      [GEMINI_SELECTORS.userTurn]: 0,
      [GEMINI_SELECTORS.turnShell]: 0,
      [GEMINI_SELECTORS.answer]: 0,
    },
    answerTexts: ["收到"],
  });
  const adapter = new GeminiWebAdapter({ manager, baseUrl: BASE_URL, options: NAV_FAST, logger });
  const ctx = await setupTestContext({
    browserManager: manager,
    geminiAdapter: adapter,
    scheduler: { autoStart: false },
  });
  // providerConversationUrl 是 @unique,用例之间必须清库
  await ctx.reset();
  return { ctx, driver };
}

async function sendAndRun(
  ctx: TestContext,
  conversationId: string,
  key: string,
): Promise<{ requestId: string; status: string; errorCode: string | null }> {
  const res = await sendMessage(ctx.baseUrl, conversationId, `nav case ${key}`, key);
  expect(res.status).toBe(202);
  const body = (await res.json()) as { data: { request: { id: string } } };
  await ctx.scheduler!.runOnce();
  const row = await ctx.prisma.modelRequest.findUniqueOrThrow({
    where: { id: body.data.request.id },
  });
  return { requestId: body.data.request.id, status: row.status, errorCode: row.errorCode };
}

describe("导航复用(端到端:gate ensureReady + openConversation 短路,真 GeminiWebAdapter + 真 SQLite)", () => {
  let nav: NavContext;

  afterEach(async () => {
    await nav.ctx.close();
  });

  it("NAV-01 同会话连发两条:第二条起 0 goto,gotoCalls 恰为 [BASE_URL]", async () => {
    nav = await setupNav([CONV_A_URL, CONV_A_URL]);
    const convA = await createConversation(nav.ctx.baseUrl, "nav-conv-a");

    expect((await sendAndRun(nav.ctx, convA.id, "nav-01-1")).status).toBe("SUCCESS");
    expect((await sendAndRun(nav.ctx, convA.id, "nav-01-2")).status).toBe("SUCCESS");

    // 第 1 条:gate 冷启动 1 次 goto,openConversation 停在 /app 短路;
    // 第 2 条:gate 健康页短路 + SAME_CONVERSATION 短路,合计 0 goto
    expect(lastPage(nav.driver).gotoCalls).toEqual([BASE_URL]);
  });

  it("NAV-02 会话 A 已停留在旧会话页时创建新会话 B:回首页导航恰一次", async () => {
    nav = await setupNav();
    const convA = await createConversation(nav.ctx.baseUrl, "nav-conv-a");
    const convB = await createConversation(nav.ctx.baseUrl, "nav-conv-b");

    expect((await sendAndRun(nav.ctx, convA.id, "nav-02-1")).status).toBe("SUCCESS");
    expect((await sendAndRun(nav.ctx, convB.id, "nav-02-2")).status).toBe("SUCCESS");

    // 硬边界:current=/app/<id> 而 existingUrl=null 绝不复用,必须 goto 首页防串会话
    expect(lastPage(nav.driver).gotoCalls).toEqual([BASE_URL, BASE_URL]);
  });

  it("NAV-03 页面被漂到其他会话后向原会话发送:恰一次目标会话导航且成功", async () => {
    nav = await setupNav([CONV_A_URL, CONV_A_URL]);
    const convA = await createConversation(nav.ctx.baseUrl, "nav-conv-a");

    expect((await sendAndRun(nav.ctx, convA.id, "nav-03-1")).status).toBe("SUCCESS");

    const page = lastPage(nav.driver);
    page.currentUrl = CONV_B_URL; // 模拟用户在浏览器里漂到了别的会话

    expect((await sendAndRun(nav.ctx, convA.id, "nav-03-2")).status).toBe("SUCCESS");
    expect(page.gotoCalls).toEqual([BASE_URL, CONV_A_URL]);
  });

  it("NAV-04 已在 /app 新会话首页时创建新会话:0 goto(场景 E)", async () => {
    nav = await setupNav();
    const convA = await createConversation(nav.ctx.baseUrl, "nav-conv-a");
    const convB = await createConversation(nav.ctx.baseUrl, "nav-conv-b");

    expect((await sendAndRun(nav.ctx, convA.id, "nav-04-1")).status).toBe("SUCCESS");

    const page = lastPage(nav.driver);
    page.currentUrl = BASE_URL; // 模拟用户已手动回到新会话首页

    expect((await sendAndRun(nav.ctx, convB.id, "nav-04-2")).status).toBe("SUCCESS");
    // gate 健康页短路 + NEW_CONVERSATION_HOME 短路,全程无新增导航
    expect(page.gotoCalls).toEqual([BASE_URL]);
  });

  it("NAV-05 两条连续 PENDING 一次排空:gate 仅贡献 1 次导航,两请求均 SUCCESS", async () => {
    nav = await setupNav();
    const convA = await createConversation(nav.ctx.baseUrl, "nav-conv-a");
    const convB = await createConversation(nav.ctx.baseUrl, "nav-conv-b");

    // 两条先入队,再一次 runOnce 排空:第一条 gate 冷启动 1 次 goto,
    // 第二条 gate 健康页短路(0 goto)+ 新会话回首页 1 次 goto
    const resA = await sendMessage(nav.ctx.baseUrl, convA.id, "nav-05-a", "nav-05-1");
    const resB = await sendMessage(nav.ctx.baseUrl, convB.id, "nav-05-b", "nav-05-2");
    expect(resA.status).toBe(202);
    expect(resB.status).toBe(202);

    await nav.ctx.scheduler!.runOnce();

    const rows = await nav.ctx.prisma.modelRequest.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.map((row) => row.status)).toEqual(["SUCCESS", "SUCCESS"]);
    // 优化前同一场景 gate 2 次 + openConversation 2 次 = 4 goto
    expect(lastPage(nav.driver).gotoCalls).toEqual([BASE_URL, BASE_URL]);
  });
});
