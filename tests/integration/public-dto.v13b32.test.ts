import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { COMPAT_USER_ID } from "../../src/config/constants.js";
import { createConversation, sendMessage, setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

/** §67:Public 面上绝不该出现的内部字段(按对象层级在收集到的全部键上核对) */
const FORBIDDEN_PUBLIC_KEYS = [
  "userId",
  "provider",
  "providerConversationUrl",
  "deletedAt",
  "idempotencyKey",
  "requestFingerprint",
  "attemptCount",
  "startedAt",
  "completedAt",
  "requestedModelKey",
  "resolvedModelKey",
  "resolvedModelLabel",
  "profileDir",
  "providerLoggedIn",
  "headless",
  "browserType",
] as const;

const CONVERSATION_KEYS = [
  "id",
  "title",
  "status",
  "preferredModelKey",
  "createdAt",
  "updatedAt",
] as const;

const MESSAGE_KEYS = [
  "id",
  "conversationId",
  "role",
  "content",
  "status",
  "position",
  "createdAt",
  "updatedAt",
  "attachmentCount",
  "request",
] as const;

const REQUEST_BRIEF_KEYS = ["id", "status", "errorCode", "errorMessage"] as const;

const REQUEST_KEYS = [
  "id",
  "conversationId",
  "userMessageId",
  "assistantMessageId",
  "status",
  "errorCode",
  "errorMessage",
  "attachmentCount",
  "createdAt",
  "updatedAt",
] as const;

const SEND_RESULT_KEYS = ["request", "userMessage", "assistantMessage", "deduplicated"] as const;

/** §11:白名单而不是「某个键 === undefined」——未来给 Prisma Model 加字段也不会自动泄露 */
function expectExactKeys(actual: Record<string, unknown>, expected: readonly string[]): void {
  expect(Object.keys(actual).sort()).toEqual([...expected].sort());
}

/** 递归收集一个 JSON 值里出现的全部对象键 */
function collectKeys(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, acc);
    return acc;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      acc.add(key);
      collectKeys(nested, acc);
    }
  }
  return acc;
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("V1.3-B3-2 Public DTO 白名单(§11 九面)", () => {
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

  it("DTO-01 Conversation create:exact keys", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "白名单" }),
    });
    expectExactKeys(((await jsonOf(res)).data ?? {}) as Record<string, unknown>, CONVERSATION_KEYS);
  });

  it("DTO-02 Conversation get:exact keys", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const res = await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}`);
    expectExactKeys(((await jsonOf(res)).data ?? {}) as Record<string, unknown>, CONVERSATION_KEYS);
  });

  it("DTO-03 Conversation list item:exact keys", async () => {
    await createConversation(ctx.baseUrl, "a");
    await createConversation(ctx.baseUrl, "b");
    const res = await fetch(`${ctx.baseUrl}/api/conversations`);
    const body = await jsonOf(res);
    const items = body.data as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    for (const item of items) {
      expectExactKeys(item, CONVERSATION_KEYS);
    }
  });

  it("DTO-04 Conversation patch:exact keys", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const res = await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "改名", preferredModelKey: "model-a" }),
    });
    const data = ((await jsonOf(res)).data ?? {}) as Record<string, unknown>;
    expectExactKeys(data, CONVERSATION_KEYS);
    expect(data.title).toBe("改名");
    expect(data.preferredModelKey).toBe("model-a");
  });

  it("DTO-05/06 Message history item 与内嵌 RequestBrief:exact keys", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const sent = await sendMessage(ctx.baseUrl, conv.id, "你好", "hist-keys");
    const sentData = ((await jsonOf(sent)).data ?? {}) as { request: { id: string } };
    await ctx.prisma.modelRequest.update({
      where: { id: sentData.request.id },
      data: { status: "FAILED", errorCode: ErrorCodes.PROVIDER_PAGE_CLOSED, errorMessage: "raw" },
    });

    const res = await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}/messages`);
    const items = ((await jsonOf(res)).data ?? []) as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    for (const item of items) {
      expectExactKeys(item, MESSAGE_KEYS);
    }
    const user = items.find((m) => m.role === "USER")!;
    const assistant = items.find((m) => m.role === "ASSISTANT")!;
    // 附件份数保持扁平(§7:现前端读 message.attachmentCount)
    expect(user.attachmentCount).toBe(0);
    expect(assistant.attachmentCount).toBe(0);
    // USER 行不带 Request 摘要,ASSISTANT 行带且只有四键
    expect(user.request).toBeNull();
    expectExactKeys(assistant.request as Record<string, unknown>, REQUEST_BRIEF_KEYS);
  });

  it("DTO-07 Send message result:顶层与三个内嵌对象全部经 mapper", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const res = await sendMessage(ctx.baseUrl, conv.id, "你好", "send-keys");
    expect(res.status).toBe(202);
    const data = ((await jsonOf(res)).data ?? {}) as Record<string, unknown>;
    expectExactKeys(data, SEND_RESULT_KEYS);
    expectExactKeys(data.request as Record<string, unknown>, REQUEST_KEYS);
    expectExactKeys(
      { ...(data.userMessage as Record<string, unknown>) },
      [...MESSAGE_KEYS].filter((k) => k !== "request"),
    );
    expectExactKeys(
      { ...(data.assistantMessage as Record<string, unknown>) },
      [...MESSAGE_KEYS].filter((k) => k !== "request"),
    );
    expect(data.deduplicated).toBe(false);
  });

  it("DTO-08 Request GET:exact keys", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const sent = await sendMessage(ctx.baseUrl, conv.id, "你好", "get-keys");
    const requestId = (((await jsonOf(sent)).data ?? {}) as { request: { id: string } }).request.id;
    const res = await fetch(`${ctx.baseUrl}/api/requests/${requestId}`);
    expectExactKeys(((await jsonOf(res)).data ?? {}) as Record<string, unknown>, REQUEST_KEYS);
  });

  /** 直造一条在飞(PROCESSING)Request,归属与本文件 HTTP 身份(COMPAT)一致 */
  async function seedProcessing(key: string): Promise<string> {
    const conversation = await ctx.prisma.conversation.create({
      data: { title: `processing-${key}`, userId: COMPAT_USER_ID },
    });
    const userMessage = await ctx.prisma.message.create({
      data: { conversationId: conversation.id, role: "USER", content: "在飞", status: "COMPLETED", position: 1 },
    });
    const assistantMessage = await ctx.prisma.message.create({
      data: { conversationId: conversation.id, role: "ASSISTANT", content: "", status: "PENDING", position: 2 },
    });
    const request = await ctx.prisma.modelRequest.create({
      data: {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        idempotencyKey: key,
        requestFingerprint: key,
        status: "PROCESSING",
      },
    });
    return request.id;
  }

  it("DTO-09 Request cancel:两条分支(200 已终态 / 202 CANCELLING)共用同一白名单", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const sent = await sendMessage(ctx.baseUrl, conv.id, "你好", "cancel-keys");
    const requestId = (((await jsonOf(sent)).data ?? {}) as { request: { id: string } }).request.id;

    // PENDING 没有执行器在跑 → 取消可立即确认终态
    const pending = await fetch(`${ctx.baseUrl}/api/requests/${requestId}/cancel`, { method: "POST" });
    expect(pending.status).toBe(200);
    expectExactKeys(((await jsonOf(pending)).data ?? {}) as Record<string, unknown>, REQUEST_KEYS);

    const processingId = await seedProcessing("cancel-keys-processing");
    const cancelling = await fetch(`${ctx.baseUrl}/api/requests/${processingId}/cancel`, {
      method: "POST",
    });
    expect(cancelling.status).toBe(202);
    expectExactKeys(
      ((await jsonOf(cancelling)).data ?? {}) as Record<string, unknown>,
      REQUEST_KEYS,
    );
  });

  it("DTO-10 §67 全局扫描:聊天各面响应里没有任何禁止键", async () => {
    const created = await fetch(`${ctx.baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "扫描用会话" }),
    });
    const createdBody = await jsonOf(created);
    const convId = (createdBody.data as { id: string }).id;

    const sent = await sendMessage(ctx.baseUrl, convId, "你好", "scan-keys");
    const sentBody = await jsonOf(sent);
    const requestId = (sentBody.data as { request: { id: string } }).request.id;
    const requestGet = await jsonOf(await fetch(`${ctx.baseUrl}/api/requests/${requestId}`));
    const cancel = await jsonOf(
      await fetch(`${ctx.baseUrl}/api/requests/${requestId}/cancel`, { method: "POST" }),
    );
    const list = await jsonOf(await fetch(`${ctx.baseUrl}/api/conversations`));
    const getOne = await jsonOf(await fetch(`${ctx.baseUrl}/api/conversations/${convId}`));
    const patched = await jsonOf(
      await fetch(`${ctx.baseUrl}/api/conversations/${convId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "改名" }),
      }),
    );
    const history = await jsonOf(
      await fetch(`${ctx.baseUrl}/api/conversations/${convId}/messages`),
    );

    const surfaces: Array<[string, Record<string, unknown>]> = [
      ["conversation create", createdBody],
      ["conversation get", getOne],
      ["conversation list", list],
      ["conversation patch", patched],
      ["send message", sentBody],
      ["request get", requestGet],
      ["request cancel", cancel],
      ["message history", history],
    ];
    for (const [name, payload] of surfaces) {
      const keys = collectKeys(payload.data);
      for (const forbidden of FORBIDDEN_PUBLIC_KEYS) {
        expect(keys.has(forbidden), `${name} leaks ${forbidden}`).toBe(false);
      }
    }
  });

  it("DTO-11 §52:B4 后 userId 变必填也不会因此泄露(库内三字段都有值)", async () => {
    const row = await ctx.prisma.conversation.create({
      data: {
        title: "内部字段齐全",
        status: "ACTIVE",
        provider: "GEMINI_WEB",
        providerConversationUrl: "https://gemini.google.com/app/secret-conversation",
        userId: COMPAT_USER_ID,
      },
    });

    const get = await fetch(`${ctx.baseUrl}/api/conversations/${row.id}`);
    expect(get.status).toBe(200);
    const text = await get.text();
    expect(text).not.toContain("secret-conversation");
    expect(text).not.toContain("gemini.google.com");
    expect(text).not.toContain(COMPAT_USER_ID);
    expectExactKeys(
      (JSON.parse(text) as { data: Record<string, unknown> }).data,
      CONVERSATION_KEYS,
    );

    const list = (await (await fetch(`${ctx.baseUrl}/api/conversations`)).json()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(list.data).toHaveLength(1);
    expect(JSON.stringify(list.data)).not.toContain("providerConversationUrl");
  });
});
