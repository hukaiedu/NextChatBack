import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ATTACHMENT_TYPES, attachment } from "../attachment-fixtures.js";
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

    expect(res.status).toBe(202);
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
    expect(first.status).toBe(202);

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
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);

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
    expect(second.status).toBe(202);
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

    // USER Message:request 固定为 null
    const user = body.data[0]!;
    expect(user.role).toBe("USER");
    expect(user.request).toBeNull();

    // ASSISTANT Message:必须携带 Request 摘要
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

interface MessagePageBody {
  data: {
    id: string;
    role: string;
    position: number;
    content: string;
    request: unknown;
  }[];
  meta: { nextCursor: string | null; totalCount: number };
}

/** [a..b] 闭区间升序数组 */
function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

describe("Message API pagination (PAG-2)", () => {
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

  /** 绕过 send 链路直接落库:position 1..count,奇数位 USER / 偶数位 ASSISTANT */
  async function seedMessages(conversationId: string, count: number): Promise<void> {
    await ctx.prisma.message.createMany({
      data: range(1, count).map((position) => ({
        conversationId,
        role: position % 2 === 1 ? "USER" : "ASSISTANT",
        content: `msg-${position}`,
        status: "COMPLETED",
        position,
      })),
    });
  }

  async function getMessagesPage(
    conversationId: string,
    query = "",
  ): Promise<{ res: Response; body: MessagePageBody }> {
    const res = await fetch(
      `${ctx.baseUrl}/api/conversations/${conversationId}/messages${query}`,
    );
    return { res, body: (await res.json()) as MessagePageBody };
  }

  function encodeCursor(value: unknown): string {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  }

  it("PAG2-BE-01: 默认返回最新 50 条(151..200),meta.nextCursor 非空,totalCount=200", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await seedMessages(conv.id, 200);

    const { res, body } = await getMessagesPage(conv.id);
    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(50);
    expect(body.data.map((m) => m.position)).toEqual(range(151, 200));
    expect(body.meta.totalCount).toBe(200);
    expect(body.meta.nextCursor).not.toBeNull();
  });

  it("PAG2-BE-02: 页内 position 严格升序(旧→新)", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await seedMessages(conv.id, 200);

    const { body } = await getMessagesPage(conv.id);
    const positions = body.data.map((m) => m.position);
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]!).toBeGreaterThan(positions[i - 1]!);
    }
  });

  it("PAG2-BE-03: cursor 取更老一页(101..150)", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await seedMessages(conv.id, 200);

    const first = await getMessagesPage(conv.id);
    const second = await getMessagesPage(conv.id, `?cursor=${first.body.meta.nextCursor}`);
    expect(second.res.status).toBe(200);
    expect(second.body.data.map((m) => m.position)).toEqual(range(101, 150));
    expect(second.body.meta.totalCount).toBe(200);
    expect(second.body.meta.nextCursor).not.toBeNull();
  });

  it("PAG2-BE-04: 200 条完整 traversal 恰好 4 次请求,无第五次空请求", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await seedMessages(conv.id, 200);

    const visited: number[] = [];
    let cursor: string | null = null;
    let requests = 0;
    do {
      const { body } = await getMessagesPage(conv.id, cursor ? `?cursor=${cursor}` : "");
      requests += 1;
      visited.push(...body.data.map((m) => m.position));
      cursor = body.meta.nextCursor;
    } while (cursor !== null);

    expect(requests).toBe(4);
    expect(visited).toEqual([...range(151, 200), ...range(101, 150), ...range(51, 100), ...range(1, 50)]);
  });

  it("PAG2-BE-05: position 唯一稳定 —— traversal 每条恰好一次,无重复无遗漏", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await seedMessages(conv.id, 200);

    const visited: number[] = [];
    let cursor: string | null = null;
    do {
      const { body } = await getMessagesPage(conv.id, cursor ? `?cursor=${cursor}` : "");
      visited.push(...body.data.map((m) => m.position));
      cursor = body.meta.nextCursor;
    } while (cursor !== null);

    expect(new Set(visited).size).toBe(200);
    expect([...visited].sort((a, b) => a - b)).toEqual(range(1, 200));
  });

  it("PAG2-BE-06: 恰好整除(100 条 × limit 50)最后一页 nextCursor=null", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await seedMessages(conv.id, 100);

    const first = await getMessagesPage(conv.id);
    expect(first.body.data.map((m) => m.position)).toEqual(range(51, 100));
    expect(first.body.meta.nextCursor).not.toBeNull();

    const second = await getMessagesPage(conv.id, `?cursor=${first.body.meta.nextCursor}`);
    expect(second.body.data.map((m) => m.position)).toEqual(range(1, 50));
    expect(second.body.meta.nextCursor).toBeNull();
  });

  it("PAG2-BE-06A: 201 条需要第 5 页(最后一页仅 1 条)", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await seedMessages(conv.id, 201);

    const pages: MessagePageBody[] = [];
    let cursor: string | null = null;
    do {
      const { body } = await getMessagesPage(conv.id, cursor ? `?cursor=${cursor}` : "");
      pages.push(body);
      cursor = body.meta.nextCursor;
    } while (cursor !== null);

    expect(pages).toHaveLength(5);
    expect(pages[0]!.data.map((m) => m.position)).toEqual(range(152, 201));
    expect(pages[3]!.data.map((m) => m.position)).toEqual(range(2, 51));
    expect(pages[4]!.data.map((m) => m.position)).toEqual([1]);
    expect(pages.every((p) => p.meta.totalCount === 201)).toBe(true);
  });

  it("PAG2-BE-07: A 会话 cursor 用于 B 会话不串数据", async () => {
    const convA = await createConversation(ctx.baseUrl);
    const convB = await createConversation(ctx.baseUrl);
    await seedMessages(convA.id, 60);
    await seedMessages(convB.id, 20);

    const pageA = await getMessagesPage(convA.id);
    const cursorA = pageA.body.meta.nextCursor;
    expect(cursorA).not.toBeNull();

    const pageB = await getMessagesPage(convB.id, `?cursor=${cursorA}`);
    expect(pageB.res.status).toBe(200);
    expect(pageB.body.data.map((m) => m.position)).toEqual(range(1, 10));
    expect(pageB.body.data.every((m) => m.content === `msg-${m.position}`)).toBe(true);
    expect(pageB.body.meta.totalCount).toBe(20);
    expect(pageB.body.meta.nextCursor).toBeNull();
  });

  it("PAG2-BE-08: 非法 cursor → 400 VALIDATION_ERROR(垃圾串/p=0/p=1.5/p 为字符串/缺 p)", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await seedMessages(conv.id, 3);

    for (const cursor of [
      "not-a-cursor",
      encodeCursor({ p: 0 }),
      encodeCursor({ p: 1.5 }),
      encodeCursor({ p: "1" }),
      encodeCursor({ q: 1 }),
    ]) {
      const { res, body } = await getMessagesPage(conv.id, `?cursor=${cursor}`);
      expect(res.status).toBe(400);
      expect((body as unknown as { error: { code: string } }).error.code).toBe(
        "VALIDATION_ERROR",
      );
    }
  });

  it("PAG2-BE-09: limit 边界(0/101/非数字 → 400;1/100 → 200)", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await seedMessages(conv.id, 5);

    for (const limit of ["0", "101", "abc", "-1", "1.5"]) {
      const { res } = await getMessagesPage(conv.id, `?limit=${limit}`);
      expect(res.status).toBe(400);
    }

    const single = await getMessagesPage(conv.id, "?limit=1");
    expect(single.res.status).toBe(200);
    expect(single.body.data.map((m) => m.position)).toEqual([5]);

    const max = await getMessagesPage(conv.id, "?limit=100");
    expect(max.res.status).toBe(200);
    expect(max.body.data.map((m) => m.position)).toEqual(range(1, 5));
  });

  it("PAG2-BE-10: 不存在/已删除 → 404;ARCHIVED 保持可读", async () => {
    const { res: missing } = await getMessagesPage("no-such-conv");
    expect(missing.status).toBe(404);

    const deleted = await createConversation(ctx.baseUrl);
    await fetch(`${ctx.baseUrl}/api/conversations/${deleted.id}`, { method: "DELETE" });
    const { res: gone } = await getMessagesPage(deleted.id);
    expect(gone.status).toBe(404);

    const archived = await createConversation(ctx.baseUrl);
    await seedMessages(archived.id, 2);
    await fetch(`${ctx.baseUrl}/api/conversations/${archived.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ARCHIVED" }),
    });
    const { res: stillReadable, body } = await getMessagesPage(archived.id);
    expect(stillReadable.status).toBe(200);
    expect(body.data.map((m) => m.position)).toEqual([1, 2]);
  });

  it("PAG2-BE-11: 每一页 meta.totalCount 都是后端总数", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await seedMessages(conv.id, 120);

    const pages: MessagePageBody[] = [];
    let cursor: string | null = null;
    do {
      const { body } = await getMessagesPage(conv.id, cursor ? `?cursor=${cursor}` : "");
      pages.push(body);
      cursor = body.meta.nextCursor;
    } while (cursor !== null);

    expect(pages).toHaveLength(3);
    expect(pages.every((p) => p.meta.totalCount === 120)).toBe(true);
  });
});

describe("Message API attachmentCount (I3.5)", () => {
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

  interface I35SendBody {
    data: {
      request: { attachmentCount: number };
      userMessage: { content: string; attachmentCount: number };
      deduplicated: boolean;
    };
  }

  interface I35PageBody {
    data: { role: string; position: number; attachmentCount: number }[];
    meta: { nextCursor: string | null };
  }

  async function getMessagesPage(conversationId: string, query = ""): Promise<I35PageBody> {
    const res = await fetch(`${ctx.baseUrl}/api/conversations/${conversationId}/messages${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as I35PageBody;
  }

  /** 把活动 Request 置为终态,释放「同会话无活动请求」约束,允许再发下一条 */
  async function finishActiveRequest(key: string): Promise<void> {
    const request = await ctx.prisma.modelRequest.findUniqueOrThrow({
      where: { idempotencyKey: key },
    });
    await ctx.prisma.modelRequest.update({
      where: { id: request.id },
      data: { status: "SUCCESS" },
    });
  }

  it("I35-BE-01: 纯文本 USER —— POST 与 list 的 attachmentCount 均为 0", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const res = await sendMessage(ctx.baseUrl, conv.id, "纯文本", "i35-be-01");
    expect(res.status).toBe(202);
    const body = (await res.json()) as I35SendBody;
    expect(body.data.userMessage.attachmentCount).toBe(0);

    const page = await getMessagesPage(conv.id);
    const user = page.data.find((m) => m.role === "USER");
    expect(user?.attachmentCount).toBe(0);
  });

  it("I35-BE-02: 1 图 —— POST userMessage.attachmentCount=1 且 list USER=1", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const res = await sendMessage(ctx.baseUrl, conv.id, "看图", "i35-be-02", undefined, [
      attachment(),
    ]);
    expect(res.status).toBe(202);
    const body = (await res.json()) as I35SendBody;
    expect(body.data.userMessage.attachmentCount).toBe(1);

    const page = await getMessagesPage(conv.id);
    const user = page.data.find((m) => m.role === "USER");
    expect(user?.attachmentCount).toBe(1);
  });

  it("I35-BE-03: 4 图(四种 MIME)—— POST 与 list 均为 4", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const images = ATTACHMENT_TYPES.map((type) => attachment(type));
    expect(images).toHaveLength(4);

    const res = await sendMessage(ctx.baseUrl, conv.id, "四张图", "i35-be-03", undefined, images);
    expect(res.status).toBe(202);
    const body = (await res.json()) as I35SendBody;
    expect(body.data.userMessage.attachmentCount).toBe(4);

    const page = await getMessagesPage(conv.id);
    const user = page.data.find((m) => m.role === "USER");
    expect(user?.attachmentCount).toBe(4);
  });

  it("I35-BE-04: 首次 202 —— userMessage.attachmentCount 与 request.attachmentCount 一致(2 图)", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const res = await sendMessage(ctx.baseUrl, conv.id, "两张图", "i35-be-04", undefined, [
      attachment(),
      attachment("image/jpeg"),
    ]);
    expect(res.status).toBe(202);
    const body = (await res.json()) as I35SendBody;
    expect(body.data.userMessage.attachmentCount).toBe(2);
    expect(body.data.request.attachmentCount).toBe(2);
  });

  it("I35-BE-05: latest 页逐项正确(先纯文本后带图)", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await sendMessage(ctx.baseUrl, conv.id, "第一轮", "i35-be-05-a");
    await finishActiveRequest("i35-be-05-a");
    await sendMessage(ctx.baseUrl, conv.id, "第二轮", "i35-be-05-b", undefined, [attachment()]);

    const page = await getMessagesPage(conv.id);
    expect(page.data.map((m) => [m.role, m.attachmentCount])).toEqual([
      ["USER", 0],
      ["ASSISTANT", 0],
      ["USER", 1],
      ["ASSISTANT", 0],
    ]);
  });

  it("I35-BE-06: 带图 USER 位于 older page —— count 正确,无 Request 直插消息 fallback 0", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await sendMessage(ctx.baseUrl, conv.id, "带图", "i35-be-06", undefined, [attachment()]);
    await finishActiveRequest("i35-be-06");

    // 直插 60 条纯文本(position 3..62),不带 ModelRequest
    await ctx.prisma.message.createMany({
      data: Array.from({ length: 60 }, (_, i) => {
        const position = 3 + i;
        return {
          conversationId: conv.id,
          role: position % 2 === 1 ? "USER" : "ASSISTANT",
          content: `seed-${position}`,
          status: "COMPLETED",
          position,
        };
      }),
    });

    const latest = await getMessagesPage(conv.id);
    expect(latest.data.map((m) => m.position)).toEqual(range(13, 62));
    expect(latest.meta.nextCursor).not.toBeNull();
    expect(latest.data.every((m) => m.attachmentCount === 0)).toBe(true);

    const older = await getMessagesPage(conv.id, `?cursor=${latest.meta.nextCursor}`);
    expect(older.data.map((m) => m.position)).toEqual(range(1, 12));
    const imageUser = older.data.find((m) => m.position === 1);
    expect(imageUser?.role).toBe("USER");
    expect(imageUser?.attachmentCount).toBe(1);
    expect(older.data.filter((m) => m.position !== 1).every((m) => m.attachmentCount === 0)).toBe(
      true,
    );
  });

  it("I35-BE-07: 同 Idempotency-Key 同附件重放 —— 200 deduplicated=true 且 count 保持", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const images = [attachment()];
    const first = await sendMessage(ctx.baseUrl, conv.id, "幂等带图", "i35-be-07", undefined, images);
    expect(first.status).toBe(202);

    const second = await sendMessage(ctx.baseUrl, conv.id, "幂等带图", "i35-be-07", undefined, images);
    expect(second.status).toBe(200);
    const body = (await second.json()) as I35SendBody;
    expect(body.data.deduplicated).toBe(true);
    expect(body.data.userMessage.attachmentCount).toBe(1);
    expect(body.data.request.attachmentCount).toBe(1);

    expect(await ctx.prisma.message.count()).toBe(2);
    expect(await ctx.prisma.modelRequest.count()).toBe(1);
  });

  it("I35-BE-08: 带图 Request 对应 ASSISTANT 列表项 attachmentCount 恒为 0", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await sendMessage(ctx.baseUrl, conv.id, "带图", "i35-be-08", undefined, [attachment()]);

    const page = await getMessagesPage(conv.id);
    const user = page.data.find((m) => m.role === "USER");
    const assistant = page.data.find((m) => m.role === "ASSISTANT");
    // 同一 Request 的 USER 侧为 1,反证 ASSISTANT 的 0 不是「查不到」
    expect(user?.attachmentCount).toBe(1);
    expect(assistant?.attachmentCount).toBe(0);
  });
});
