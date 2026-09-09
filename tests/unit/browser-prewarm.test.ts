import { afterEach, describe, expect, it } from "vitest";

import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { createLogger } from "../../src/common/logger/logger.js";
import type { BrowserContextHandle } from "../../src/providers/gemini/browser-driver.js";
import type { BrowserManager } from "../../src/providers/gemini/browser-manager.js";
import { runBrowserPrewarm } from "../../src/providers/gemini/browser-prewarm.js";
import { FakeDriver, FakeGeminiAdapter, createFakeManager } from "../fakes.js";
import { createConversation, sendMessage, setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

const logger = createLogger("silent");
const BASE_URL = "https://gemini.google.com/app";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 第一次 launchPersistentContext 失败(可先挂起 firstLaunchDelayMs 再抛),之后与
 * 普通 FakeDriver 无异。P7 用例用它模拟「prewarm 首次启动失败 + 后续可恢复」。
 */
class FailFirstLaunchDriver extends FakeDriver {
  constructor(private readonly firstLaunchDelayMs = 0) {
    super();
  }

  override async launchPersistentContext(): Promise<BrowserContextHandle> {
    if (this.launchCount === 0) {
      // 第一次尝试:计入一次失败的 launch(launchCount = launchPersistentContext 调用次数)
      if (this.firstLaunchDelayMs > 0) {
        await sleep(this.firstLaunchDelayMs);
      }
      this.launchCount++;
      throw new Error("boom: transient chromium launch failure");
    }
    return super.launchPersistentContext();
  }
}

describe("P7 Browser Context Prewarm(runBrowserPrewarm;Fake Driver;06/06A 走真 SQLite + Scheduler)", () => {
  /** 06/06A 的 TestContext,其余用例不建;afterEach 统一收尾 */
  let ctx: TestContext | null = null;

  afterEach(async () => {
    await ctx?.close();
    ctx = null;
  });

  /** 集成装配:autoStart=false 且手动 runOnce —— 证明不依赖 periodic scan */
  async function mountScheduler(driver: FakeDriver): Promise<BrowserManager> {
    const manager = createFakeManager(driver);
    ctx = await setupTestContext({
      browserManager: manager,
      geminiAdapter: new FakeGeminiAdapter(),
      scheduler: { autoStart: false },
    });
    await ctx.reset();
    return manager;
  }

  /** POST 一条消息拿到 PENDING Request id(await 在 202 后立即返回,Request 仍 PENDING) */
  async function createPendingRequest(conversationId: string, key: string): Promise<string> {
    const res = await sendMessage(ctx!.baseUrl, conversationId, `prewarm ${key}`, key);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { data: { request: { id: string } } };
    return body.data.request.id;
  }

  it("PREWARM-01 冷启动 STOPPED → helper → launch 恰 1 次,终态 READY", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);
    expect(manager.getStatus()).toBe("STOPPED");

    await runBrowserPrewarm(manager, logger);

    expect(manager.getStatus()).toBe("READY");
    expect(driver.launchCount).toBe(1);
    expect(driver.latestContext?.lastPage?.gotoCalls).toEqual([BASE_URL]);
  });

  it("PREWARM-02 已 READY 再执行 helper:launch/goto 均不增加", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);
    await runBrowserPrewarm(manager, logger);
    const page = driver.latestContext!.lastPage!;
    expect(page.gotoCalls).toEqual([BASE_URL]);

    await runBrowserPrewarm(manager, logger);

    expect(driver.launchCount).toBe(1);
    // 第二次 ensureReady 命中 ifNeeded 短路:健康页 + 登录确认 → 0 goto
    expect(page.gotoCalls).toEqual([BASE_URL]);
    expect(manager.getStatus()).toBe("READY");
  });

  it("PREWARM-03 两个并发 helper:runExclusive 队列串行 → launch 恰 1 次", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);

    await Promise.all([
      runBrowserPrewarm(manager, logger),
      runBrowserPrewarm(manager, logger),
    ]);

    expect(driver.launchCount).toBe(1);
    expect(manager.getStatus()).toBe("READY");
  });

  it("PREWARM-04 launch 失败:helper 不 reject、无 unhandledRejection、状态 ERROR", async () => {
    const driver = new FakeDriver();
    driver.throwOnLaunch = new Error("boom: cannot launch chromium");
    const manager = createFakeManager(driver);

    // 模拟 main.ts 的 fire-and-forget 调用形态(void):错误必须被 helper 全捕获
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      void runBrowserPrewarm(manager, logger);
      await sleep(20);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(manager.getStatus()).toBe("ERROR");
    expect(manager.getLastBrowserError()).toEqual({
      code: ErrorCodes.PROVIDER_BROWSER_START_FAILED,
      message: "boom: cannot launch chromium",
    });
  });

  it("PREWARM-05 失败 + 无 PENDING:无独立后台 retry;保持 ERROR 直到未来请求 gate 自愈", async () => {
    const driver = new FailFirstLaunchDriver();
    const manager = createFakeManager(driver);

    await runBrowserPrewarm(manager, logger);
    expect(manager.getStatus()).toBe("ERROR");
    expect(driver.launchCount).toBe(1);

    // 观察窗口:若存在 P7 新增的自动重试定时器,窗口内会出现第二次 launch
    await sleep(150);
    expect(driver.launchCount).toBe(1);
    expect(manager.getStatus()).toBe("ERROR");

    // 未来真实请求的 gate = ensureReady 的 ERROR self-heal(既有语义)
    const status = await manager.ensureReady();
    expect(status).toBe("READY");
    expect(driver.launchCount).toBe(2);
  });

  it("PREWARM-06 首条请求排在成功 prewarm 后:同一次 drain 完成,launch=1、gate 零导航", async () => {
    const driver = new FakeDriver();
    driver.launchDelayMs = 200; // prewarm 的 launch 挂起窗口:让请求在 prewarm 完成前入队
    const manager = await mountScheduler(driver);
    const conversation = await createConversation(ctx!.baseUrl, "prewarm-06");

    const prewarm = runBrowserPrewarm(manager, logger);
    await sleep(30); // prewarm 已占有 BrowserManager queue(launch 挂起中)

    const requestId = await createPendingRequest(conversation.id, "prewarm-06-1");
    await ctx!.scheduler!.runOnce(); // 手动一次 drain(autoStart=false,无 1s scan 兜底)

    await expect(prewarm).resolves.toBeUndefined();

    const row = await ctx!.prisma.modelRequest.findUniqueOrThrow({ where: { id: requestId } });
    // 请求的 ensureReady 在 queue 中等待 prewarm → prewarm READY 后放行,
    // 同一次 drain 内 gate 放行并执行完成 —— 不依赖下一次 scan
    expect(row.status).toBe("SUCCESS");
    expect(driver.launchCount).toBe(1); // 请求不需要第二次 launch
    expect(driver.latestContext!.lastPage!.gotoCalls).toEqual([BASE_URL]); // 请求的 gate 0 goto
  });

  it("PREWARM-06A prewarm 失败 + 已排队请求:同一次 drain 内 ERROR self-heal 二次尝试成功", async () => {
    const driver = new FailFirstLaunchDriver(200); // 第一次 launch 挂起后抛错,之后正常
    const manager = await mountScheduler(driver);
    const conversation = await createConversation(ctx!.baseUrl, "prewarm-06a");

    const prewarm = runBrowserPrewarm(manager, logger);
    await sleep(30); // prewarm 正在第一次 launch(将失败),请求随后排到 queue

    const requestId = await createPendingRequest(conversation.id, "prewarm-06a-1");
    await ctx!.scheduler!.runOnce();

    await expect(prewarm).resolves.toBeUndefined();

    // prewarm 失败后,排队请求的 ensureReady 立即执行 ERROR self-heal(第二次 launch),
    // 成功 → 同一 drain 内放行并执行完成,请求没有被终态成任何错误码
    const row = await ctx!.prisma.modelRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(row.status).toBe("SUCCESS");
    expect(driver.launchCount).toBe(2); // 第一次失败 + self-heal 重建
  });

  it("PREWARM-07 prewarm 在途时 restart 排队:串行执行,旧 context 关闭不复活", async () => {
    const driver = new FakeDriver();
    driver.launchDelayMs = 200;
    const manager = createFakeManager(driver);

    const prewarm = runBrowserPrewarm(manager, logger);
    await sleep(30); // prewarm 已占有 queue(launch 挂起)
    const restart = manager.restart(); // 排队:等 prewarm 完成才执行

    const restartStatus = await restart;
    await expect(prewarm).resolves.toBeUndefined();

    expect(restartStatus).toBe("READY");
    expect(manager.getStatus()).toBe("READY");
    expect(driver.launchCount).toBe(2);
    // 旧(prewarm)context 已被 restart 关闭;唯一活跃实例是 restart 的新 context
    expect(driver.contexts[0]!.closed).toBe(true);
    expect(driver.latestContext?.closed).toBe(false);
    expect(manager.requireGeminiPage()).toBe(driver.latestContext!.lastPage);
  });

  it("PREWARM-08 prewarm 在途时 stop 排队:完成后 context 干净关闭;stop 幂等;helper 可再冷启动", async () => {
    const driver = new FakeDriver();
    driver.launchDelayMs = 200;
    const manager = createFakeManager(driver);

    const prewarm = runBrowserPrewarm(manager, logger);
    await sleep(30);
    const stop = manager.stop(); // 排队等 prewarm 完成

    await stop;
    await expect(prewarm).resolves.toBeUndefined();

    expect(manager.getStatus()).toBe("STOPPED");
    expect(driver.latestContext?.closed).toBe(true);

    await manager.stop(); // closeContext 幂等:STOPPED + 无 context 时 no-op
    expect(manager.getStatus()).toBe("STOPPED");

    // stop 之后 helper 语义不变:STOPPED → 冷启动新 context
    await runBrowserPrewarm(manager, logger);
    expect(driver.launchCount).toBe(2);
    expect(manager.getStatus()).toBe("READY");
  });

  it("PREWARM-09 未登录剧本:helper 正常 resolve 不 throw,终态 LOGIN_REQUIRED", async () => {
    const scenarios: Array<(driver: FakeDriver) => void> = [
      (driver) => {
        driver.redirectToLogin = true; // 重定向到 Google 登录页
      },
      (driver) => {
        driver.sameOriginNotLoggedIn = true; // 同域但显示 Sign in
      },
    ];
    for (const configure of scenarios) {
      const driver = new FakeDriver();
      configure(driver);
      const manager = createFakeManager(driver);

      await expect(runBrowserPrewarm(manager, logger)).resolves.toBeUndefined();
      expect(manager.getStatus()).toBe("LOGIN_REQUIRED");
    }
  });

  it("PREWARM-10 prewarm READY 后页面 crash → ERROR;再次 helper → 重建 READY,launchCount=2", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);
    await runBrowserPrewarm(manager, logger);
    expect(driver.launchCount).toBe(1);

    driver.latestContext!.lastPage!.emitCrashed();
    expect(manager.getStatus()).toBe("ERROR");

    await runBrowserPrewarm(manager, logger);
    expect(manager.getStatus()).toBe("READY");
    expect(driver.launchCount).toBe(2);
  });

  it("PREWARM-11 BUSY(Request 执行中):helper 不 reject、不 launch、不导航、不动状态", async () => {
    const driver = new FakeDriver();
    const manager = createFakeManager(driver);
    await manager.openGemini();
    const page = driver.latestContext!.lastPage!;
    manager.setBusy(); // scheduler 正在该页面上执行 Request

    await expect(runBrowserPrewarm(manager, logger)).resolves.toBeUndefined();

    // helper 对 BUSY 完全被动:不重复启动、不导航、不改状态、不打断请求
    expect(manager.getStatus()).toBe("BUSY");
    expect(driver.launchCount).toBe(1);
    expect(page.gotoCalls).toEqual([BASE_URL]);
    expect(manager.requireGeminiPage()).toBe(page);

    manager.clearBusy();
    expect(manager.getStatus()).toBe("READY");
  });
});
