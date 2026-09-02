import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createConversation, sendMessage, setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

interface SendBody {
  data: {
    request: { id: string; status: string; idempotencyKey: string };
    userMessage: { role: string; content: string; status: string; position: number };
    assistantMessage: { role: string; content: string; status: string; position: number };
    deduplicated: boolean;
  };
}

describe("Message API", () => {
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

  it("缺少 Idempotency-Key → 400 VALIDATION_ERROR", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const res = await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "你好" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("空内容(纯空格)→ 400", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const res = await sendMessage(ctx.baseUrl, conv.id, "   ", "sp-key-1");
    expect(res.status).toBe(400);
  });

  it("正常发送:事务创建 USER + ASSISTANT(PENDING) + REQUEST(PENDING)", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const res = await sendMessage(ctx.baseUrl, conv.id, "你好", "ok-key-1");

    expect(res.status).toBe(201);
    const body = (await res.json()) as SendBody;

    expect(body.data.deduplicated).toBe(false);
    expect(body.data.request.status).toBe("PENDING");
    expect(body.data.userMessage).toMatchObject({
      role: "USER",
      content: "你好",
      status: "COMPLETED",
      position: 1,
    });
    expect(body.data.assistantMessage).toMatchObject({
      role: "ASSISTANT",
      content: "",
      status: "PENDING",
      position: 2,
    });

    // 数据库中确认三个记录,idempotencyKey 落库
    const count = await ctx.prisma.modelRequest.count();
    expect(count).toBe(1);
    const stored = await ctx.prisma.modelRequest.findUnique({
      where: { idempotencyKey: "ok-key-1" },
    });
    expect(stored?.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("同 Key 同内容:幂等命中返回 200,不新增记录", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const first = await sendMessage(ctx.baseUrl, conv.id, "你好", "idem-key-1");
    expect(first.status).toBe(201);

    const second = await sendMessage(ctx.baseUrl, conv.id, "你好", "idem-key-1");
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as SendBody;
    expect(secondBody.data.deduplicated).toBe(true);
    expect(secondBody.data.userMessage.content).toBe("你好");

    const messageCount = await ctx.prisma.message.count();
    const requestCount = await ctx.prisma.modelRequest.count();
    expect(messageCount).toBe(2);
    expect(requestCount).toBe(1);
  });

  it("同 Key 不同内容 → 409 IDEMPOTENCY_KEY_REUSED", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await sendMessage(ctx.baseUrl, conv.id, "你好", "idem-key-2");

    const second = await sendMessage(ctx.baseUrl, conv.id, "完全不同的内容", "idem-key-2");
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    // 未创建任何数据
    expect(await ctx.prisma.message.count()).toBe(2);
    expect(await ctx.prisma.modelRequest.count()).toBe(1);
  });

  it("同 Key 在不同 Conversation 复用 → 409(Key 全局唯一)", async () => {
    const convA = await createConversation(ctx.baseUrl);
    const convB = await createConversation(ctx.baseUrl);
    await sendMessage(ctx.baseUrl, convA.id, "你好", "glob-key-1");

    const res = await sendMessage(ctx.baseUrl, convB.id, "你好", "glob-key-1");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "IDEMPOTENCY_KEY_REUSED",
    );
  });

  it("同 Conversation 有活动 Request 时再次发送 → 409 CONVERSATION_REQUEST_IN_PROGRESS", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await sendMessage(ctx.baseUrl, conv.id, "第一个问题", "prog-key-1");

    const second = await sendMessage(ctx.baseUrl, conv.id, "第二个问题", "prog-key-2");
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
      "CONVERSATION_REQUEST_IN_PROGRESS",
    );

    // 失败时不留任何半截数据(检查在事务内,USER 消息未被写入)
    expect(await ctx.prisma.message.count()).toBe(2);
    expect(await ctx.prisma.modelRequest.count()).toBe(1);
  });

  it("不同 Conversation 可以各自创建 PENDING Request", async () => {
    const convA = await createConversation(ctx.baseUrl);
    const convB = await createConversation(ctx.baseUrl);

    const a = await sendMessage(ctx.baseUrl, convA.id, "A", "conv-a-1");
    const b = await sendMessage(ctx.baseUrl, convB.id, "B", "conv-b-1");
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const pending = await ctx.prisma.modelRequest.findMany({
      where: { status: "PENDING" },
    });
    expect(pending).toHaveLength(2);
  });

  it("Request 结束后 position 严格递增(3,4)", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const first = await sendMessage(ctx.baseUrl, conv.id, "第一个", "pos-key-1");
    const firstBody = (await first.json()) as SendBody;
    expect(firstBody.data.userMessage.position).toBe(1);
    expect(firstBody.data.assistantMessage.position).toBe(2);

    // 置为终态释放活动锁
    const request = await ctx.prisma.modelRequest.findUniqueOrThrow({
      where: { idempotencyKey: "pos-key-1" },
    });
    await ctx.prisma.modelRequest.update({
      where: { id: request.id },
      data: { status: "SUCCESS" },
    });

    const second = await sendMessage(ctx.baseUrl, conv.id, "第二个", "pos-key-2");
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as SendBody;
    expect(secondBody.data.userMessage.position).toBe(3);
    expect(secondBody.data.assistantMessage.position).toBe(4);
  });

  it("发送到不存在的 Conversation → 404 CONVERSATION_NOT_FOUND", async () => {
    const res = await sendMessage(ctx.baseUrl, "no-such-conv", "你好", "nf-key-1");
    expect(res.status).toBe(404);
  });

  it("发送到 ARCHIVED Conversation → 409 CONVERSATION_ARCHIVED", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ARCHIVED" }),
    });

    const res = await sendMessage(ctx.baseUrl, conv.id, "你好", "arch-key-1");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "CONVERSATION_ARCHIVED",
    );
  });

  it("发送到 DELETED Conversation → 409 CONVERSATION_DELETED", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}`, { method: "DELETE" });

    const res = await sendMessage(ctx.baseUrl, conv.id, "你好", "del-key-1");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "CONVERSATION_DELETED",
    );
  });

  it("Message List:position ASC,Assistant 消息带 Request 摘要(含 errorCode/errorMessage null)", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await sendMessage(ctx.baseUrl, conv.id, "你好", "list-key-1");

    const res = await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}/messages`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        role: string;
        position: number;
        request: { id: string; status: string; errorCode: string | null; errorMessage: string | null } | null;
      }[];
    };

    expect(body.data.map((m) => m.position)).toEqual([1, 2]);
    const assistant = body.data[1]!;
    expect(assistant.role).toBe("ASSISTANT");
    expect(assistant.request).toMatchObject({
      status: "PENDING",
      errorCode: null,
      errorMessage: null,
    });
    expect(assistant.request?.id).toBeTruthy();
  });

  it("Message List:会话不存在(含已删除)→ 404", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}`, { method: "DELETE" });

    const res = await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}/messages`);
    expect(res.status).toBe(404);
  });

  it("数据库兜底:同 Conversation 直接插入第二个活动 Request 被唯一索引拒绝", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await sendMessage(ctx.baseUrl, conv.id, "你好", "db-key-1");

    const first = await ctx.prisma.modelRequest.findUniqueOrThrow({
      where: { idempotencyKey: "db-key-1" },
    });
    const msgIds = [first.userMessageId, first.assistantMessageId];

    // 绕过 Service,直接插第二个 PENDING → 必须撞 uk_active_request_per_conversation
    await expect(
      ctx.prisma.modelRequest.create({
        data: {
          conversationId: conv.id,
          userMessageId: msgIds[0]!,
          assistantMessageId: msgIds[1]!,
          idempotencyKey: "db-key-2",
          requestFingerprint: "f".repeat(64),
          status: "PROCESSING",
          provider: "GEMINI_WEB",
        },
      }),
    ).rejects.toThrow(/conversationId/);

    // 终态与活动态共存没问题
    await ctx.prisma.modelRequest.create({
      data: {
        conversationId: conv.id,
        userMessageId: msgIds[0]!,
        assistantMessageId: msgIds[1]!,
        idempotencyKey: "db-key-3",
        requestFingerprint: "e".repeat(64),
        status: "SUCCESS",
        provider: "GEMINI_WEB",
      },
    });
  });
});
