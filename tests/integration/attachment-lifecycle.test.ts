import { afterEach, describe, expect, it } from "vitest";

import { AppError } from "../../src/common/errors/app-error.js";
import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { createLogger } from "../../src/common/logger/logger.js";
import type { ModelRequestModel } from "../../src/generated/prisma/models.js";
import type { BrowserManager } from "../../src/providers/gemini/browser-manager.js";
import { GeminiWebAdapter } from "../../src/providers/gemini/gemini.adapter.js";
import type { AttachmentFile, RawAttachment } from "../../src/modules/message/attachment.js";
import type { PromptExecutionInput } from "../../src/modules/provider/gemini-prompt.service.js";
import {
  cancelRequest,
  createConversation,
  sendMessage,
  setupTestContext,
} from "../helpers.js";
import type { TestContext } from "../helpers.js";
import {
  attachment,
  decodedBytes,
  expectAttachmentInvariant,
} from "../attachment-fixtures.js";
import { FakeDriver, FakeGeminiAdapter, createFakeManager } from "../fakes.js";
import type { FakeAdapterBehavior } from "../fakes.js";

/**
 * V1.2 I1 §七 / §八 / §十 / §十一:附件在 MessageService 与 Scheduler 之间的完整生命周期。
 *
 * 三条硬线:
 * 1. 幂等命中绝不新建 / 覆盖 / 删除 slot(ATT-IDEM-01);
 * 2. 任何失败路径(校验、事务、竞态让位)之后 liveBytes 与 slot 数回到调用前(§八、ATT-ST-07);
 * 3. 附件拿不到就是 FAILED —— Executor 与 Page 的 fill/Enter 一次都不能被调用(§十)。
 *
 * `autoStart: false` 的用例用 `scheduler.runOnce()` 手动驱动,时序完全可控;
 * 只有需要跑完整条执行链的用例才开周期扫描。
 */

let ctx: TestContext;
let driver: FakeDriver;
let manager: BrowserManager;
let adapter: FakeGeminiAdapter;
let conversationId = "";

interface SendBody {
  data: { request: ModelRequestModel; deduplicated: boolean };
}

async function mount(
  behavior: FakeAdapterBehavior = {},
  autoStart = true,
  useRealAdapter = false,
): Promise<void> {
  driver = new FakeDriver();
  manager = createFakeManager(driver);
  adapter = new FakeGeminiAdapter(behavior);
  ctx = await setupTestContext({
    browserManager: manager,
    // 真 Adapter 才会真的调 Page.fill / Enter —— §十五那句「页面动作之前必须已退出」只能由它证明
    geminiAdapter: useRealAdapter
      ? new GeminiWebAdapter({
          manager,
          baseUrl: "https://gemini.google.com/app",
          options: {
            responseTimeoutMs: 1_000,
            composerReadyTimeoutMs: 200,
            sendAckTimeoutMs: 200,
            historySettleTimeoutMs: 200,
            urlGraceMs: 10,
            pollIntervalMs: 10,
            stableWindowMs: 20,
          },
          logger: createLogger("silent"),
        })
      : adapter,
    scheduler: { scanIntervalMs: 25, autoStart },
  });
  await ctx.reset();
  conversationId = (await createConversation(ctx.baseUrl, "attachment-lifecycle")).id;
}

async function send(items: RawAttachment[], key: string): Promise<SendBody> {
  const res = await sendMessage(ctx.baseUrl, conversationId, "看图", key, undefined, items);
  return (await res.json()) as SendBody;
}

async function rowOf(id: string): Promise<ModelRequestModel> {
  return ctx.prisma.modelRequest.findUniqueOrThrow({ where: { id } });
}

async function waitForStatus(id: string, status: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await rowOf(id);
    if (row.status === status) {
      return;
    }
    if (isTerminal(row.status) || Date.now() > deadline) {
      throw new Error(`request ${id} stuck at ${row.status}, expected ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isTerminal(status: string): boolean {
  return ["SUCCESS", "FAILED", "TIMEOUT", "CANCELLED"].includes(status);
}

async function waitForTerminal(id: string, timeoutMs = 3000): Promise<ModelRequestModel> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await rowOf(id);
    if (isTerminal(row.status)) {
      return row;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitForTerminal timeout: request ${id} stuck at ${row.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 空容器快照:失败/收尾路径的落点都必须长这样 */
const EMPTY_STORE = { slotCount: 0, liveBytes: 0, slots: [] };

/** 记录 Executor 实际收到的入参(§十「绝不能被调用」的判据就落在这里) */
function spyExecutor(): PromptExecutionInput[] {
  const calls: PromptExecutionInput[] = [];
  const original = ctx.executor.execute.bind(ctx.executor);
  ctx.executor.execute = (input) => {
    calls.push(input);
    return original(input);
  };
  return calls;
}

/** 记录 Scheduler 是否碰过取件口(§十:attachmentCount==0 时完全不访问容器) */
function spyTake(): string[] {
  const ids: string[] = [];
  const original = ctx.attachmentStore.take.bind(ctx.attachmentStore);
  ctx.attachmentStore.take = (requestId) => {
    ids.push(requestId);
    return original(requestId);
  };
  return ids;
}

afterEach(async () => {
  await ctx.close();
});

describe("幂等 × 附件(§八)", () => {
  it("ATT-IDEM-01 同 Key 同图重放:返回既有 Request,不新建 slot、不覆盖、不删除", async () => {
    await mount({}, false);
    const items = [attachment("image/png", 3_000)];
    const first = await send(items, "idem-01");
    const requestId = first.data.request.id;
    expect(first.data.deduplicated).toBe(false);
    expect(ctx.attachmentStore.stats().slots).toEqual([
      { requestId, state: "READY", byteSize: decodedBytes(items) },
    ]);
    const afterFirst = ctx.attachmentStore.stats();

    const second = await send(items, "idem-01");
    expect(second.data.deduplicated).toBe(true);
    expect(second.data.request.id).toBe(requestId);

    // 账本逐字段相同 = 既没新建、也没覆盖或删除
    expect(ctx.attachmentStore.stats()).toEqual(afterFirst);
    // attach 仍返回 false:它是被第一次请求消费过的那个 RESERVED,第二次没碰它
    expect(ctx.attachmentStore.attach(requestId)).toBe(false);
    expect(await ctx.prisma.modelRequest.count()).toBe(1);
    expectAttachmentInvariant(ctx.attachmentStore);
  });

  it("ATT-IDEM-02 同 Key 换图:409 之后 liveBytes 与 slot 数回到调用前", async () => {
    await mount({}, false);
    const a = [attachment("image/png", 1_000)];
    const first = await send(a, "idem-02");
    const before = ctx.attachmentStore.stats();
    expect(before.slotCount).toBe(1);

    const res = await sendMessage(
      ctx.baseUrl,
      conversationId,
      "看图",
      "idem-02",
      undefined,
      [attachment("image/png", 2_000)],
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ErrorCodes.IDEMPOTENCY_KEY_REUSED,
    );

    expect(ctx.attachmentStore.stats()).toEqual(before);
    expect(ctx.attachmentStore.stats().slots[0]!.requestId).toBe(first.data.request.id);
    expect(await ctx.prisma.modelRequest.count()).toBe(1);
    expectAttachmentInvariant(ctx.attachmentStore);
  });

  it("ATT-IDEM-03 同图换序 → 指纹不同被 409 拒绝,让位时只回滚自己的占位", async () => {
    await mount({}, false);
    const x = attachment("image/png", 700);
    const y = attachment("image/jpeg", 800);
    const first = await send([x, y], "idem-03");

    const res = await sendMessage(
      ctx.baseUrl,
      conversationId,
      "看图",
      "idem-03",
      undefined,
      [y, x],
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ErrorCodes.IDEMPOTENCY_KEY_REUSED,
    );

    expect(ctx.attachmentStore.stats().slots).toEqual([
      { requestId: first.data.request.id, state: "READY", byteSize: decodedBytes([x, y]) },
    ]);
    expectAttachmentInvariant(ctx.attachmentStore);
  });
});

describe("失败路径必须把占位收回去(§七 / ATT-ST-07 / ATT-ST-08)", () => {
  it("ATT-ST-07 事务失败(同会话已有活动 Request):占位归零,不留 RESERVED", async () => {
    await mount({}, false);
    const text = await sendMessage(ctx.baseUrl, conversationId, "占位", "st07-text");
    expect(text.status).toBe(202);
    expect(ctx.attachmentStore.stats()).toEqual(EMPTY_STORE); // 纯文本不占位

    const res = await sendMessage(
      ctx.baseUrl,
      conversationId,
      "看图",
      "st07-image",
      undefined,
      [attachment("image/png", 5_000)],
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ErrorCodes.CONVERSATION_REQUEST_IN_PROGRESS,
    );

    expect(ctx.attachmentStore.stats()).toEqual(EMPTY_STORE);
    expect(
      await ctx.prisma.modelRequest.findFirst({ where: { idempotencyKey: "st07-image" } }),
    ).toBeNull();
    expectAttachmentInvariant(ctx.attachmentStore);
  });

  it("ATT-ST-07B 校验失败(415/400)排在 reserve 之前:零占位零落库", async () => {
    await mount({}, false);
    const res = await sendMessage(
      ctx.baseUrl,
      conversationId,
      "看图",
      "st07b",
      undefined,
      [{ name: "a.png", mimeType: "image/png", data: "data:image/png;base64,!!!" }],
    );
    expect(res.status).toBe(400);
    expect(ctx.attachmentStore.stats()).toEqual(EMPTY_STORE);
    expect(await ctx.prisma.message.count()).toBe(0);
  });

  it("ATT-ST-08 PENDING 带图请求被取消:离开活动态后由 sweep 回收字节", async () => {
    await mount({}, false);
    const items = [attachment("image/png", 1_500)];
    const sent = await send(items, "st08");
    expect(ctx.attachmentStore.stats().liveBytes).toBe(decodedBytes(items));

    const cancel = await cancelRequest(ctx.baseUrl, sent.data.request.id);
    expect(cancel.status).toBe(200);
    expect((await rowOf(sent.data.request.id)).status).toBe("CANCELLED");

    // 取消走 markCancelled,不经过 Scheduler → 这份字节由 sweep 收
    expect(await ctx.attachmentStore.sweep()).toBe(1);
    expect(ctx.attachmentStore.stats()).toEqual(EMPTY_STORE);
    expectAttachmentInvariant(ctx.attachmentStore);
  });

  it("ATT-ST-08B 仍处 PENDING 的带图请求:sweep 绝不删字节", async () => {
    await mount({}, false);
    const items = [attachment("image/png", 1_500)];
    const sent = await send(items, "st08b");

    expect(await ctx.attachmentStore.sweep()).toBe(0);
    expect(ctx.attachmentStore.stats().liveBytes).toBe(decodedBytes(items));
    expect((await rowOf(sent.data.request.id)).status).toBe("PENDING");
  });
});

describe("Scheduler 附件守卫(§十)与释放(§十一)", () => {
  it("ATT-GUARD-01 字节缺失:FAILED PROVIDER_ATTACHMENT_FAILED,Executor 与 Page 一次都不碰", async () => {
    await mount({}, false);
    const executes = spyExecutor();
    const sent = await send([attachment("image/png", 2_200)], "guard-01");
    const requestId = sent.data.request.id;
    // 模拟字节意外丢失:数据库仍记着 1 份附件
    ctx.attachmentStore.drop(requestId);

    await ctx.scheduler!.runOnce();

    const row = await rowOf(requestId);
    expect(row.status).toBe("FAILED");
    expect(row.errorCode).toBe(ErrorCodes.PROVIDER_ATTACHMENT_FAILED);
    expect(executes).toHaveLength(0);
    expect(adapter.runCalls).toHaveLength(0);
    expect(ctx.attachmentStore.stats()).toEqual(EMPTY_STORE);
  });

  it("ATT-GUARD-02 份数不符:同样在执行器之前 FAILED,已取到的 slot 由 finally 收走", async () => {
    await mount({}, false);
    const executes = spyExecutor();
    const sent = await send([attachment("image/png", 900)], "guard-02");
    const requestId = sent.data.request.id;
    // 容器里换成 3 份:DB 说 1、取件取到 3 → 必须判失败,绝不照发「只有文字」的请求
    ctx.attachmentStore.drop(requestId);
    const extra: AttachmentFile[] = [1, 2, 3].map((n) => ({
      name: `x${n}.png`,
      mimeType: "image/png",
      buffer: Buffer.alloc(64 * n, 0x61),
    }));
    ctx.attachmentStore.reserve(requestId, extra);
    ctx.attachmentStore.attach(requestId);

    await ctx.scheduler!.runOnce();

    const row = await rowOf(requestId);
    expect(row.status).toBe("FAILED");
    expect(row.errorCode).toBe(ErrorCodes.PROVIDER_ATTACHMENT_FAILED);
    expect(row.errorMessage).toContain("Expected 1 attachments");
    expect(executes).toHaveLength(0);
    expect(adapter.runCalls).toHaveLength(0);
    expect(ctx.attachmentStore.stats()).toEqual(EMPTY_STORE);
  });

  it("ATT-GUARD-04 真 Adapter:Page 已被建出来,但 fill 与 Enter 一次都没发生", async () => {
    // 假 Adapter 不驱动 Page,fill 计数在它身上恒为 0 —— 只有真 Adapter 能证明这句话
    await mount({}, false, true);
    const sent = await send([attachment("image/png", 1_800)], "guard-04");
    const requestId = sent.data.request.id;
    ctx.attachmentStore.drop(requestId);

    await ctx.scheduler!.runOnce();

    const page = driver.latestContext?.lastPage ?? null;
    expect(page, "gateProvider 应已建出 Page,否则 0 次写入是空断言").not.toBeNull();
    expect(page!.fillCalls).toEqual([]);
    expect(page!.pressCalls).toEqual([]);
    const row = await rowOf(requestId);
    expect(row.status).toBe("FAILED");
    expect(row.errorCode).toBe(ErrorCodes.PROVIDER_ATTACHMENT_FAILED);
    expect(ctx.attachmentStore.stats()).toEqual(EMPTY_STORE);
  });

  it("ATT-GUARD-03 纯文本零接触:attachmentCount=0 时 Scheduler 不访问容器", async () => {
    await mount({}, false);
    const takes = spyTake();
    const res = await sendMessage(ctx.baseUrl, conversationId, "只发文字", "guard-03");
    expect(res.status).toBe(202);

    await ctx.scheduler!.runOnce();

    expect(takes).toEqual([]);
    expect(ctx.attachmentStore.stats()).toEqual(EMPTY_STORE);
    expect((await ctx.prisma.modelRequest.findFirstOrThrow()).status).toBe("SUCCESS");
  });

  it("ATT-LEAK-01 执行成功:附件送到 Executor 门口,收尾由 finally 负责", async () => {
    await mount();
    const executes = spyExecutor();
    const items = [attachment("image/png", 1_000), attachment("image/jpeg", 1_100)];
    const sent = await send(items, "leak-01");
    const row = await waitForTerminal(sent.data.request.id);

    expect(row.status).toBe("SUCCESS");
    expect(row.attachmentCount).toBe(2);
    expect(executes).toHaveLength(1);
    expect(executes[0]!.attachments).toHaveLength(2);
    expect(executes[0]!.request.id).toBe(row.id);
    expect(ctx.attachmentStore.stats()).toEqual(EMPTY_STORE);
    expectAttachmentInvariant(ctx.attachmentStore);
  });

  it("ATT-LEAK-01B 纯文本执行:Executor 入参里根本没有 attachments 这个键", async () => {
    await mount();
    const executes = spyExecutor();
    const res = await sendMessage(ctx.baseUrl, conversationId, "只发文字", "leak-01b");
    const sent = (await res.json()) as SendBody;
    const row = await waitForTerminal(sent.data.request.id);

    expect(row.status).toBe("SUCCESS");
    expect(executes).toHaveLength(1);
    expect("attachments" in executes[0]!).toBe(false);
  });

  it("ATT-LEAK-02 Provider 失败:字节同样被 finally 收走", async () => {
    await mount({ runError: new AppError(ErrorCodes.PROVIDER_DOM_CHANGED, "dom changed") });
    const sent = await send([attachment("image/png", 1_200)], "leak-02");
    const row = await waitForTerminal(sent.data.request.id);

    expect(row.status).toBe("FAILED");
    expect(row.errorCode).toBe(ErrorCodes.PROVIDER_DOM_CHANGED);
    expect(ctx.attachmentStore.stats()).toEqual(EMPTY_STORE);
  });

  it("ATT-LEAK-03 执行中被取消:IN_USE 期间 slot 保留,CANCELLED 之后一分不剩", async () => {
    await mount({ hang: true, cancelBehaviour: "cancelled" });
    const sent = await send([attachment("image/png", 1_400)], "leak-03");
    const requestId = sent.data.request.id;
    await waitForStatus(requestId, "PROCESSING");
    // take 只改状态不删 slot —— 释放权在执行链的 finally
    expect(ctx.attachmentStore.stats().slots).toEqual([
      { requestId, state: "IN_USE", byteSize: decodedBytes([attachment("image/png", 1_400)]) },
    ]);

    expect((await cancelRequest(ctx.baseUrl, requestId)).status).toBe(202);
    const row = await waitForTerminal(requestId);

    expect(row.status).toBe("CANCELLED");
    expect(ctx.attachmentStore.stats()).toEqual(EMPTY_STORE);
  });

  it("ATT-LEAK-04 Provider 未就绪(PENDING 等待):字节必须留着,恢复后照原样跑完", async () => {
    await mount({}, false);
    const items = [attachment("image/png", 1_600)];
    driver.throwOnLaunch = new Error("profile locked");
    const sent = await send(items, "leak-04");

    await ctx.scheduler!.runOnce(); // gateProvider 抛错 → 本轮 WAIT,未认领

    expect(ctx.attachmentStore.stats().liveBytes).toBe(decodedBytes(items));
    expect((await rowOf(sent.data.request.id)).status).toBe("PENDING");

    driver.throwOnLaunch = null;
    await ctx.scheduler!.runOnce();
    expect((await waitForTerminal(sent.data.request.id)).status).toBe("SUCCESS");
    expect(ctx.attachmentStore.stats()).toEqual(EMPTY_STORE);
  });
});
