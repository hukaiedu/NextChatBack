import { afterEach, describe, expect, it } from "vitest";

import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import type { ModelRequestModel } from "../../src/generated/prisma/models.js";
import { FakeDriver, FakeGeminiAdapter, createFakeManager } from "../fakes.js";
import { attachment, expectAttachmentInvariant } from "../attachment-fixtures.js";
import { createConversation, sendMessage, setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

/**
 * V1.2 I1 §十三:进程重启后的带图 PENDING 恢复。
 *
 * 「重启」在这里是字面意义的换进程:同一个 SQLite 文件,旧 app 整体 close(内存容器随之
 * 清空),再开一个新 app —— 新进程天生看不到上一进程的附件字节。恢复必须先跑完再 start(),
 * 与 main.ts 的启动顺序一致。
 */

let adapter: FakeGeminiAdapter;
const opened: TestContext[] = [];

/** 开一个新「进程」;reset=false 用于承接上一个 ctx 留下的数据库状态 */
async function openApp(reset = true): Promise<TestContext> {
  adapter = new FakeGeminiAdapter();
  const ctx = await setupTestContext({
    browserManager: createFakeManager(new FakeDriver()),
    geminiAdapter: adapter,
    // 一律手动驱动:恢复必须先于 start(),时序不能让 25ms 扫描抢先
    scheduler: { scanIntervalMs: 25, autoStart: false },
  });
  opened.push(ctx);
  if (reset) {
    await ctx.reset();
  }
  return ctx;
}

/** 显式关掉某个「进程」,同时从 afterEach 的兜底清单里摘掉,避免二次 close */
async function closeApp(ctx: TestContext): Promise<void> {
  const index = opened.indexOf(ctx);
  if (index >= 0) {
    opened.splice(index, 1);
  }
  await ctx.close();
}

async function sendWithImage(ctx: TestContext, conversationId: string, key: string) {
  const res = await sendMessage(
    ctx.baseUrl,
    conversationId,
    "看图",
    key,
    undefined,
    [attachment("image/png", 2_048), attachment("image/jpeg", 1_024)],
  );
  return { status: res.status, body: (await res.json()) as { data: { request: ModelRequestModel } } };
}

async function rowOf(ctx: TestContext, id: string): Promise<ModelRequestModel> {
  return ctx.prisma.modelRequest.findUniqueOrThrow({ where: { id } });
}

async function assistantOf(ctx: TestContext, id: string): Promise<string> {
  const row = await rowOf(ctx, id);
  return (await assistantMessage(ctx, row)).status;
}

/** 恢复只改状态,绝不改写已生成的回答内容;终态内容也是断言对象 */
async function assistantContent(
  ctx: TestContext,
  row: ModelRequestModel,
): Promise<string> {
  return (await assistantMessage(ctx, row)).content;
}

async function assistantMessage(
  ctx: TestContext,
  row: ModelRequestModel,
): Promise<{ status: string; content: string }> {
  return ctx.prisma.message.findUniqueOrThrow({
    where: { id: row.assistantMessageId },
    select: { status: true, content: true },
  });
}

afterEach(async () => {
  for (const ctx of opened.splice(0)) {
    await ctx.close();
  }
});

describe("重启恢复:带附件的 PENDING(§十三)", () => {
  it("ATT-RC-01 带图 PENDING 跨重启 → Request FAILED + Assistant FAILED + SERVER_RESTARTED_DURING_PROCESSING", async () => {
    const first = await openApp();
    const conversationId = (await createConversation(first.baseUrl, "restart-image")).id;
    const sent = await sendWithImage(first, conversationId, "rc-01");
    const requestId = sent.body.data.request.id;
    expect(sent.status).toBe(202);
    expect(first.attachmentStore.stats().slotCount).toBe(1);

    // 换进程:旧 app 连同它的内存容器一起消失
    await closeApp(first);
    const second = await openApp(false);
    expect(second.attachmentStore.stats()).toEqual({ slotCount: 0, liveBytes: 0, slots: [] });

    const report = await second.recovery.run();
    expect(report.pendingAttachmentFailed).toBe(1);
    expect(report.processingFailed).toBe(0);
    expect(report.pairingViolations).toBe(0);

    const row = await rowOf(second, requestId);
    expect(row.status).toBe("FAILED");
    expect(row.errorCode).toBe(ErrorCodes.SERVER_RESTARTED_DURING_PROCESSING);
    expect(row.errorMessage).toContain("attachments lived only in memory");
    expect(row.attachmentCount).toBe(2);
    expect(row.completedAt).not.toBeNull();
    // §六 配对:Assistant 只能跟着 FAILED,不能落 CANCELLED
    expect(await assistantOf(second, requestId)).toBe("FAILED");
    // 恢复只推进状态,不碰内容
    expect(await assistantContent(second, row)).toBe("");
    expectAttachmentInvariant(second.attachmentStore);
  });

  it("ATT-RC-02 恢复之后 Scheduler 全量扫描:这条请求绝不被重新执行,Provider 零调用", async () => {
    const first = await openApp();
    const conversationId = (await createConversation(first.baseUrl, "restart-noreplay")).id;
    const sent = await sendWithImage(first, conversationId, "rc-02");
    await closeApp(first);

    const second = await openApp(false);
    await second.recovery.run();
    second.scheduler!.start();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const row = await rowOf(second, sent.body.data.request.id);
    expect(row.status).toBe("FAILED");
    expect(row.attemptCount).toBe(0); // 从没被认领过
    expect(adapter.runCalls).toHaveLength(0);
    expect(second.attachmentStore.stats()).toEqual({ slotCount: 0, liveBytes: 0, slots: [] });
  });

  it("ATT-RC-03 纯文本 PENDING 跨重启照旧续跑(硬回归条件)", async () => {
    const first = await openApp();
    const conversationId = (await createConversation(first.baseUrl, "restart-text")).id;
    const res = await sendMessage(first.baseUrl, conversationId, "只发文字", "rc-03");
    const sent = (await res.json()) as { data: { request: ModelRequestModel } };
    await closeApp(first);

    const second = await openApp(false);
    const report = await second.recovery.run();
    expect(report).toMatchObject({ processingFailed: 0, pendingAttachmentFailed: 0 });

    second.scheduler!.start();
    await new Promise((resolve) => setTimeout(resolve, 400));

    const row = await rowOf(second, sent.data.request.id);
    expect(row.status).toBe("SUCCESS");
    expect(row.attachmentCount).toBe(0);
    expect(row.errorCode).toBeNull();
    // 「被重新执行」的实证:Provider 收到一次 Prompt,回答也真写回了 Assistant
    expect(adapter.runCalls).toEqual([{ prompt: "只发文字", existingUrl: null }]);
    expect(await assistantContent(second, row)).toBe("fake answer");
  });

  it("ATT-RC-04 在飞残留的分类不受新扫描影响:PROCESSING/CANCELLING 各归各码", async () => {
    const ctx = await openApp();
    const convA = (await createConversation(ctx.baseUrl, "restart-inflight-a")).id;
    const convB = (await createConversation(ctx.baseUrl, "restart-inflight-b")).id;
    const a = await sendWithImage(ctx, convA, "rc-04a");
    const b = await sendWithImage(ctx, convB, "rc-04b");
    const idA = a.body.data.request.id;
    const idB = b.body.data.request.id;
    // 直接改库造在飞残留:恢复扫描只看数据库,与谁改的状态无关
    await ctx.prisma.modelRequest.update({ where: { id: idA }, data: { status: "PROCESSING" } });
    await ctx.prisma.modelRequest.update({ where: { id: idB }, data: { status: "CANCELLING" } });
    await closeApp(ctx);

    const second = await openApp(false);
    const report = await second.recovery.run();
    expect(report).toMatchObject({
      processingFailed: 1,
      cancellingFailed: 1,
      pendingAttachmentFailed: 0,
    });
    expect((await rowOf(second, idA)).errorCode).toBe(
      ErrorCodes.SERVER_RESTARTED_DURING_PROCESSING,
    );
    expect((await rowOf(second, idB)).errorCode).toBe(
      ErrorCodes.SERVER_RESTARTED_DURING_CANCELLING,
    );
    expect(await assistantOf(second, idA)).toBe("FAILED");
    expect(await assistantOf(second, idB)).toBe("FAILED");
  });

  it("ATT-RC-05 恢复是幂等的:再跑一次不重复计数,也不碰已终态的行", async () => {
    const first = await openApp();
    const conversationId = (await createConversation(first.baseUrl, "restart-twice")).id;
    const sent = await sendWithImage(first, conversationId, "rc-05");
    await closeApp(first);

    const second = await openApp(false);
    expect((await second.recovery.run()).pendingAttachmentFailed).toBe(1);
    const text = await sendMessage(second.baseUrl, conversationId, "续发文字", "rc-05-text");
    expect(text.status).toBe(202);

    const again = await second.recovery.run();
    expect(again).toMatchObject({
      pendingAttachmentFailed: 0,
      processingFailed: 0,
      cancellingFailed: 0,
    });
    const row = await rowOf(second, sent.body.data.request.id);
    expect(row.status).toBe("FAILED");
    // 新受理的纯文本 PENDING 依然不被误判
    expect((await second.prisma.modelRequest.findFirstOrThrow({ where: { idempotencyKey: "rc-05-text" } })).status).toBe("PENDING");
  });

  it("ATT-RC-06 判死之后会话立即解锁:同会话可以再发一条(活动唯一索引已让位)", async () => {
    const first = await openApp();
    const conversationId = (await createConversation(first.baseUrl, "restart-unlock")).id;
    await sendWithImage(first, conversationId, "rc-06");
    await closeApp(first);

    const second = await openApp(false);
    await second.recovery.run();
    const res = await sendMessage(
      second.baseUrl,
      conversationId,
      "看图(重发)",
      "rc-06-retry",
      undefined,
      [attachment("image/png", 512)],
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { data: { request: ModelRequestModel } };
    expect(body.data.request.attachmentCount).toBe(1);
    expect(second.attachmentStore.stats().slotCount).toBe(1);
    expectAttachmentInvariant(second.attachmentStore);
  });
});
