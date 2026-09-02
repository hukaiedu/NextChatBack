import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createConversation, sendMessage, setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

interface ConvBody {
  data: { id: string; title: string; status: string; provider: string; updatedAt: string };
}

describe("Conversation API", () => {
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

  it("创建 Conversation:默认 title/status/provider,201", async () => {
    const conv = await createConversation(ctx.baseUrl);
    expect(conv.title).toBe("新对话");
    expect(conv.status).toBe("ACTIVE");
    expect(conv.provider).toBe("GEMINI_WEB");
  });

  it("创建 Conversation:自定义 title", async () => {
    const conv = await createConversation(ctx.baseUrl, "Java问题");
    expect(conv.title).toBe("Java问题");
  });

  it("列表默认只返回 ACTIVE", async () => {
    await createConversation(ctx.baseUrl, "a");
    await createConversation(ctx.baseUrl, "b");

    const res = await fetch(`${ctx.baseUrl}/api/conversations`);
    const body = (await res.json()) as { data: { title: string; status: string }[] };

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(body.data.every((c) => c.status === "ACTIVE")).toBe(true);
  });

  it("ARCHIVED 会话不出现在默认列表,出现在 ?status=ARCHIVED", async () => {
    const conv = await createConversation(ctx.baseUrl, "arch");

    const patch = await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ARCHIVED" }),
    });
    expect(patch.status).toBe(200);

    const active = await fetch(`${ctx.baseUrl}/api/conversations`);
    const activeBody = (await active.json()) as { data: unknown[] };
    expect(activeBody.data).toHaveLength(0);

    const archived = await fetch(`${ctx.baseUrl}/api/conversations?status=ARCHIVED`);
    const archivedBody = (await archived.json()) as { data: { id: string }[] };
    expect(archivedBody.data).toHaveLength(1);
    expect(archivedBody.data[0]!.id).toBe(conv.id);
  });

  it("archive 与 unarchive 往返", async () => {
    const conv = await createConversation(ctx.baseUrl);

    const archive = await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ARCHIVED" }),
    });
    const archived = (await archive.json()) as ConvBody;
    expect(archived.data.status).toBe("ARCHIVED");

    const restore = await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ACTIVE" }),
    });
    const restored = (await restore.json()) as ConvBody;
    expect(restored.data.status).toBe("ACTIVE");
  });

  it("PATCH 修改标题", async () => {
    const conv = await createConversation(ctx.baseUrl, "旧标题");
    const res = await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "新标题" }),
    });
    const body = (await res.json()) as ConvBody;
    expect(body.data.title).toBe("新标题");
  });

  it("软删除:DELETE 204,列表与详情不再返回", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const message = await sendMessage(ctx.baseUrl, conv.id, "你好", "del-key-1");
    expect(message.status).toBe(202);

    // 活动 Request 结束前禁止删除;先置为终态
    const request = await ctx.prisma.modelRequest.findFirstOrThrow();
    await ctx.prisma.modelRequest.update({
      where: { id: request.id },
      data: { status: "SUCCESS" },
    });

    const del = await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(204);

    const list = await fetch(`${ctx.baseUrl}/api/conversations`);
    expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(0);

    const detail = await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}`);
    expect(detail.status).toBe(404);

    // 软删除不物理删除 Message / Request
    const messageCount = await ctx.prisma.message.count();
    const requestCount = await ctx.prisma.modelRequest.count();
    expect(messageCount).toBe(2);
    expect(requestCount).toBe(1);
  });

  it("DELETED 不可恢复:PATCH → 409 CONVERSATION_DELETED", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}`, { method: "DELETE" });

    const res = await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ACTIVE" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONVERSATION_DELETED");
  });

  it("已删除会话再次 DELETE → 409 CONVERSATION_DELETED", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}`, { method: "DELETE" });

    const again = await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(409);
  });

  it("Conversation 不存在:GET/PATCH/DELETE → 404 CONVERSATION_NOT_FOUND", async () => {
    const get = await fetch(`${ctx.baseUrl}/api/conversations/no-such-id`);
    expect(get.status).toBe(404);

    const patch = await fetch(`${ctx.baseUrl}/api/conversations/no-such-id`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(patch.status).toBe(404);

    const del = await fetch(`${ctx.baseUrl}/api/conversations/no-such-id`, {
      method: "DELETE",
    });
    expect(del.status).toBe(404);
  });

  it("有活动 Request 时禁止归档 → 409 CONVERSATION_REQUEST_IN_PROGRESS", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const sent = await sendMessage(ctx.baseUrl, conv.id, "你好", "act-key-1");
    expect(sent.status).toBe(202);

    const res = await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ARCHIVED" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "CONVERSATION_REQUEST_IN_PROGRESS",
    );
  });

  it("有活动 Request 时禁止删除 → 409;Request 结束后可删除", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await sendMessage(ctx.baseUrl, conv.id, "你好", "act-key-2");
    expect(conv.id).toBeTruthy();

    const del1 = await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}`, {
      method: "DELETE",
    });
    expect(del1.status).toBe(409);

    // 把 Request 置为终态(模拟第 5 阶段执行完成)
    const request = await ctx.prisma.modelRequest.findFirst();
    expect(request).not.toBeNull();
    await ctx.prisma.modelRequest.update({
      where: { id: request!.id },
      data: { status: "SUCCESS" },
    });

    const del2 = await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}`, {
      method: "DELETE",
    });
    expect(del2.status).toBe(204);
  });

  it("?status=DELETED 拒绝 → 400 VALIDATION_ERROR", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/conversations?status=DELETED`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("cursor 翻页:按 updatedAt DESC,下一页不重复", async () => {
    const convs = [
      await createConversation(ctx.baseUrl, "第一"),
      await createConversation(ctx.baseUrl, "第二"),
      await createConversation(ctx.baseUrl, "第三"),
    ];
    // 通过 PATCH 调整 updatedAt 制造稳定顺序
    for (const c of convs) {
      await fetch(`${ctx.baseUrl}/api/conversations/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `${c.title}-改` }),
      });
    }

    const page1 = await fetch(`${ctx.baseUrl}/api/conversations?limit=2`);
    const body1 = (await page1.json()) as {
      data: { id: string; title: string }[];
      meta: { nextCursor: string | null };
    };
    expect(body1.data).toHaveLength(2);
    expect(body1.meta.nextCursor).toBeTruthy();

    const page2 = await fetch(
      `${ctx.baseUrl}/api/conversations?limit=2&cursor=${body1.meta.nextCursor}`,
    );
    const body2 = (await page2.json()) as {
      data: { id: string }[];
      meta: { nextCursor: string | null };
    };
    expect(body2.data).toHaveLength(1);
    expect(body2.meta.nextCursor).toBeNull();

    const ids = [...body1.data, ...body2.data].map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("limit 上限 100,超限 400", async () => {
    const res = await fetch(`${ctx.baseUrl}/api/conversations?limit=101`);
    expect(res.status).toBe(400);
  });
});
