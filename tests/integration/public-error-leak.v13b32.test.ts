import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { computeRequestFingerprint } from "../../src/common/utils/fingerprint.js";
import { ADMIN_USER_ID, COMPAT_USER_ID } from "../../src/config/constants.js";
import { createConversation, sendMessage, setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

/** §19:主动植入的内部标记,任何 Public 面都不得带上它 */
const SECRET = "SECRET_PROVIDER_INTERNAL_DETAIL_123";
const CONTENT = "你好";

/**
 * 直接落一条终态 Request(带内部错误),用来逐面检查映射:
 * 不依赖 Scheduler 与 Adapter,避免把断言绑在执行链路上。
 *
 * 指纹复用生产算法,因此幂等重放能真的命中(否则 409,测不到重放分支)。
 * owner 默认 COMPAT(= 本文件未带 Cookie 的 HTTP 身份);传其他 User 即造出越权目标。
 */
async function seedFailedRequest(
  ctx: TestContext,
  errorCode: string,
  errorMessage: string,
  key: string,
  owner: string = COMPAT_USER_ID,
): Promise<{ conversationId: string; requestId: string }> {
  const conversation = await ctx.prisma.conversation.create({
    data: { title: `err-${key}`, userId: owner },
  });
  const userMessage = await ctx.prisma.message.create({
    data: { conversationId: conversation.id, role: "USER", content: CONTENT, status: "COMPLETED", position: 1 },
  });
  const assistantMessage = await ctx.prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "ASSISTANT",
      content: "半成品",
      status: "FAILED",
      position: 2,
    },
  });
  const request = await ctx.prisma.modelRequest.create({
    data: {
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      idempotencyKey: key,
      requestFingerprint: computeRequestFingerprint(conversation.id, CONTENT),
      status: "FAILED",
      errorCode,
      errorMessage,
    },
  });
  return { conversationId: conversation.id, requestId: request.id };
}

describe("V1.3-B3-2 Public Error 零泄露(§18/§19/§54)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestContext();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it.each([
    [ErrorCodes.PROVIDER_PAGE_CLOSED, "CHAT_FAILED"],
    [ErrorCodes.PROVIDER_BROWSER_CRASHED, "CHAT_FAILED"],
    [ErrorCodes.BROWSER_LAUNCH_FAILED, "CHAT_FAILED"],
    [ErrorCodes.STREAMING_UPDATE_FAILED, "CHAT_FAILED"],
    [ErrorCodes.SERVER_RESTARTED_DURING_PROCESSING, "CHAT_FAILED"],
    [ErrorCodes.DATABASE_ERROR, "CHAT_FAILED"],
    [ErrorCodes.PROVIDER_RESPONSE_TIMEOUT, "REQUEST_TIMEOUT"],
    [ErrorCodes.PROVIDER_CANCELLATION_UNCONFIRMED, "REQUEST_TIMEOUT"],
    [ErrorCodes.PROVIDER_RATE_LIMITED, "SERVICE_BUSY"],
    [ErrorCodes.ATTACHMENT_CAPACITY_EXCEEDED, "SERVICE_BUSY"],
  ])(
    "ER-PUB-01 %s → Public DTO %s",
    async (internalCode, expectedPublic) => {
      const { requestId } = await seedFailedRequest(
        ctx,
        internalCode,
        `raw detail ${SECRET} for ${internalCode}`,
        `er-pub-${internalCode}`,
      );

      const res = await fetch(`${ctx.baseUrl}/api/requests/${requestId}`);
      const text = await res.text();
      const data = (JSON.parse(text) as { data: Record<string, unknown> }).data;
      expect(data.errorCode).toBe(expectedPublic);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(internalCode);

      // §18:数据库仍保存原始码与原始 message
      const row = await ctx.prisma.modelRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(row.errorCode).toBe(internalCode);
      expect(row.errorMessage).toContain(SECRET);
    },
  );

  it("ER-PUB-02 消息列表内嵌 RequestBrief 同样只剩通用码", async () => {
    const { conversationId } = await seedFailedRequest(
      ctx,
      ErrorCodes.PROVIDER_DOM_CHANGED,
      `Gemini page .cib-task-item missing ${SECRET}`,
      "er-brief",
    );

    const res = await fetch(`${ctx.baseUrl}/api/conversations/${conversationId}/messages`);
    const text = await res.text();
    const items = (JSON.parse(text) as { data: Array<Record<string, unknown>> }).data;
    const brief = items.find((m) => m.role === "ASSISTANT")!.request as Record<string, unknown>;

    expect(brief).toMatchObject({
      errorCode: "CHAT_FAILED",
      errorMessage: "Chat request failed.",
    });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("cib-task-item");
    expect(text).not.toContain("PROVIDER_DOM_CHANGED");
  });

  it("ER-PUB-03 发送结果里的 request 也已映射", async () => {
    const { requestId, conversationId } = await seedFailedRequest(
      ctx,
      ErrorCodes.PROVIDER_ATTACHMENT_TIMEOUT,
      `attachment wait timed out ${SECRET}`,
      "er-send",
    );
    // 幂等命中同一条 Request → 200 返回既有对象,走的仍是同一个 mapper
    const res = await sendMessage(ctx.baseUrl, conversationId, CONTENT, "er-send");
    expect(res.status).toBe(200);
    const text = await res.text();
    const data = (JSON.parse(text) as { data: { request: Record<string, unknown> } }).data;
    expect(data.request.id).toBe(requestId);
    expect(data.request.errorCode).toBe("REQUEST_TIMEOUT");
    expect(text).not.toContain(SECRET);
  });

  it("ER-PUB-04 透传类业务码在 DTO 里不被改写(§14)", async () => {
    const { requestId } = await seedFailedRequest(
      ctx,
      ErrorCodes.REQUEST_NOT_CANCELLABLE,
      "already finished",
      "er-passthrough",
    );
    const data = ((await (await fetch(`${ctx.baseUrl}/api/requests/${requestId}`)).json()) as {
      data: Record<string, unknown>;
    }).data;
    expect(data.errorCode).toBe(ErrorCodes.REQUEST_NOT_CANCELLABLE);
    expect(data.errorMessage).toBe("already finished");
  });

  it("ER-PUB-05 同一会话的 Public 视图不泄露他人 Request 的存在性(B3-1 不退化,§20)", async () => {
    const other = await seedFailedRequest(
      ctx,
      ErrorCodes.PROVIDER_DOM_CHANGED,
      `foreign ${SECRET}`,
      "er-foreign",
      ADMIN_USER_ID,
    );
    const mine = await createConversation(ctx.baseUrl);

    const stolen = await fetch(`${ctx.baseUrl}/api/requests/${other.requestId}`);
    expect(stolen.status).toBe(404);
    const text = await stolen.text();
    expect(text).not.toContain(SECRET);
    // 越权仍是「不存在」语义,不能被错误映射改写成 CHAT_FAILED
    expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe(
      ErrorCodes.REQUEST_NOT_FOUND,
    );
    expect(mine.id).toBeTruthy();
  });
});
