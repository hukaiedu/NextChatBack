import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "../../src/common/logger/logger.js";
import type { BrowserManager } from "../../src/providers/gemini/browser-manager.js";
import {
  createConversation,
  sendMessage,
  setupTestContext,
} from "../helpers.js";
import type { TestContext } from "../helpers.js";
import { createFakeManager, FAKE_MODEL_CATALOG, FakeDriver, FakeGeminiAdapter } from "../fakes.js";

interface MessageSendBody {
  data: {
    request: {
      id: string;
      requestedModelKey: string | null;
      resolvedModelKey: string | null;
      resolvedModelLabel: string | null;
    };
    deduplicated: boolean;
  };
}

async function patchConversation(
  ctx: TestContext,
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${ctx.baseUrl}/api/conversations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("M1 模型选择:发送消息 modelKey 语义(§二十一 四象限)", () => {
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

  it("象限 1(FIX-01): preferred=A + body 省略 → requested=A,偏好仍 A", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const patched = await patchConversation(ctx, conv.id, { preferredModelKey: "model-c" });
    expect(patched.status).toBe(200);

    const res = await sendMessage(ctx.baseUrl, conv.id, "你好", "quad-1-key");
    expect(res.status).toBe(202);
    const body = (await res.json()) as MessageSendBody;
    expect(body.data.request.requestedModelKey).toBe("model-c");

    const conversation = await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(conversation.preferredModelKey).toBe("model-c");
  });

  it("象限 1b(FIX-01): preferred=null + body 省略 → requested=null", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const res = await sendMessage(ctx.baseUrl, conv.id, "你好", "quad-1b-key");
    expect(res.status).toBe(202);
    const body = (await res.json()) as MessageSendBody;
    expect(body.data.request.requestedModelKey).toBeNull();
    const conversation = await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(conversation.preferredModelKey).toBeNull();
  });

  it("象限 2:显式 modelKey → 快照冻结 + 同事务同步会话偏好", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const res = await sendMessage(ctx.baseUrl, conv.id, "你好", "quad-2-key", "model-b");
    expect(res.status).toBe(202);
    const body = (await res.json()) as MessageSendBody;
    expect(body.data.request.requestedModelKey).toBe("model-b");

    const conversation = await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(conversation.preferredModelKey).toBe("model-b");
  });

  it("象限 3:显式 modelKey 覆盖既有偏好 → 偏好更新为新键", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await patchConversation(ctx, conv.id, { preferredModelKey: "model-a" });

    const res = await sendMessage(ctx.baseUrl, conv.id, "换个模型", "quad-3-key", "model-c");
    expect(res.status).toBe(202);
    const conversation = await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(conversation.preferredModelKey).toBe("model-c");
  });

  it("象限 4:显式 modelKey 与既有偏好相同 → 幂等写回,请求正常创建", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await patchConversation(ctx, conv.id, { preferredModelKey: "model-b" });

    const res = await sendMessage(ctx.baseUrl, conv.id, "继续", "quad-4-key", "model-b");
    expect(res.status).toBe(202);
    const body = (await res.json()) as MessageSendBody;
    expect(body.data.request.requestedModelKey).toBe("model-b");
    const conversation = await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(conversation.preferredModelKey).toBe("model-b");
  });

  it("请求 DTO:GET /api/requests/:id 与消息列表 RequestBrief 均带模型三字段(resolved 恒 null,M2 才写入)", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const sent = await sendMessage(ctx.baseUrl, conv.id, "你好", "dto-key", "model-a");
    const { request } = ((await sent.json()) as MessageSendBody).data;

    const detail = await fetch(`${ctx.baseUrl}/api/requests/${request.id}`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      data: { requestedModelKey: string | null; resolvedModelKey: string | null; resolvedModelLabel: string | null };
    };
    expect(detailBody.data.requestedModelKey).toBe("model-a");
    expect(detailBody.data.resolvedModelKey).toBeNull();
    expect(detailBody.data.resolvedModelLabel).toBeNull();

    const list = await fetch(`${ctx.baseUrl}/api/conversations/${conv.id}/messages`);
    const listBody = (await list.json()) as {
      data: Array<{ role: string; request: { requestedModelKey: string | null } | null }>;
    };
    const assistant = listBody.data.find((m) => m.role === "ASSISTANT");
    expect(assistant?.request?.requestedModelKey).toBe("model-a");
  });
});

describe("M1 模型选择:Conversation PATCH preferredModelKey(§二十二)", () => {
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

  it("设置偏好 → 200 且持久化;响应 DTO 暴露 preferredModelKey", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const res = await patchConversation(ctx, conv.id, { preferredModelKey: "  model-b  " });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { preferredModelKey: string | null } };
    expect(body.data.preferredModelKey).toBe("model-b");
  });

  it("显式 null 清除偏好 → 200 且落库为 null", async () => {
    const conv = await createConversation(ctx.baseUrl);
    await patchConversation(ctx, conv.id, { preferredModelKey: "model-a" });
    const res = await patchConversation(ctx, conv.id, { preferredModelKey: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { preferredModelKey: string | null } };
    expect(body.data.preferredModelKey).toBeNull();

    const reloaded = await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(reloaded.preferredModelKey).toBeNull();
  });

  it("PATCH 只带 preferredModelKey 也能通过「至少一个字段」校验;空 body → 400", async () => {
    const conv = await createConversation(ctx.baseUrl);
    const ok = await patchConversation(ctx, conv.id, { preferredModelKey: "model-a" });
    expect(ok.status).toBe(200);

    const empty = await patchConversation(ctx, conv.id, {});
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });

  it("校验:空串 / 超 256 字符 / 非字符串 → 400 VALIDATION_ERROR", async () => {
    const conv = await createConversation(ctx.baseUrl);
    for (const bad of ["", "   ", "x".repeat(257), 123]) {
      const res = await patchConversation(ctx, conv.id, { preferredModelKey: bad });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("FIX-02: 活动 Request 用冻结快照,PATCH 偏好只影响下一次 → 200", async () => {
    const conv = await createConversation(ctx.baseUrl);
    // 活动 Request 的 requestedModelKey 冻结为 A(显式提交)
    const sent = await sendMessage(ctx.baseUrl, conv.id, "你好", "fix2-key", "model-a");
    expect(sent.status).toBe(202);
    const firstRequest = ((await sent.json()) as MessageSendBody).data.request;

    // 在途时把偏好改成 B:不做活动 Request 闸门
    const patched = await patchConversation(ctx, conv.id, { preferredModelKey: "model-b" });
    expect(patched.status).toBe(200);

    // 在途 Request 快照不受影响,偏好已变
    const frozen = await ctx.prisma.modelRequest.findUniqueOrThrow({ where: { id: firstRequest.id } });
    expect(frozen.requestedModelKey).toBe("model-a");
    const conversation = await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(conversation.preferredModelKey).toBe("model-b");

    // 活动 Request 结束后,下一次新 Request 不带 modelKey → requestedModelKey = B
    await ctx.prisma.modelRequest.update({
      where: { id: firstRequest.id },
      data: { status: "SUCCESS" },
    });
    const second = await sendMessage(ctx.baseUrl, conv.id, "第二条", "fix2-key-2");
    expect(second.status).toBe(202);
    const secondBody = (await second.json()) as MessageSendBody;
    expect(secondBody.data.request.requestedModelKey).toBe("model-b");
  });
});

describe("M1 模型选择:幂等指纹(§七 FINGERPRINT-06)", () => {
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

  it("FINGERPRINT-06: 原始与重试之间会话偏好发生变化,同 Key 重试仍幂等去重(非 409)", async () => {
    const conv = await createConversation(ctx.baseUrl);

    // 首次:不带 modelKey(V1 语义),此时偏好为 null
    const first = await sendMessage(ctx.baseUrl, conv.id, "你好", "fp6-key");
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as MessageSendBody;
    expect(firstBody.data.deduplicated).toBe(false);

    // 偏好在两次之间被「别人」改掉(直接写库,绕过活动 Request 闸门)
    await ctx.prisma.conversation.update({
      where: { id: conv.id },
      data: { preferredModelKey: "model-c" },
    });

    // 重试:同 Key + 同 content + 仍不带 modelKey → 指纹只取决于显式语义 → 幂等命中
    const retry = await sendMessage(ctx.baseUrl, conv.id, "你好", "fp6-key");
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as MessageSendBody;
    expect(retryBody.data.deduplicated).toBe(true);
    expect(retryBody.data.request.id).toBe(firstBody.data.request.id);

    // 数据没有翻倍
    const requests = await ctx.prisma.modelRequest.findMany({ where: { conversationId: conv.id } });
    expect(requests).toHaveLength(1);
  });

  it("FINGERPRINT-06 变体:显式 modelKey 的原始请求,同键重试在偏好变化后仍去重", async () => {
    const conv = await createConversation(ctx.baseUrl);

    const first = await sendMessage(ctx.baseUrl, conv.id, "换个模型", "fp6b-key", "model-b");
    expect(first.status).toBe(202);

    await ctx.prisma.conversation.update({
      where: { id: conv.id },
      data: { preferredModelKey: "model-a" },
    });

    const retry = await sendMessage(ctx.baseUrl, conv.id, "换个模型", "fp6b-key", "model-b");
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as MessageSendBody).data.deduplicated).toBe(true);
  });

  it("对照:同 Key 不同显式语义(modelKey 有无之别)→ 409 IDEMPOTENCY_KEY_REUSED", async () => {
    const conv = await createConversation(ctx.baseUrl);

    const first = await sendMessage(ctx.baseUrl, conv.id, "你好", "fp-c-key", "model-b");
    expect(first.status).toBe(202);

    const retry = await sendMessage(ctx.baseUrl, conv.id, "你好", "fp-c-key");
    expect(retry.status).toBe(409);
    expect(((await retry.json()) as { error: { code: string } }).error.code).toBe(
      "IDEMPOTENCY_KEY_REUSED",
    );
  });
});

describe("M1 模型选择:GET /api/provider/models(§十/§二十三;FIX-03 状态矩阵)", () => {
  /** 构造getStatus 固定为指定状态的 BrowserManager 代理 */
  function managerWithStatus(status: string): BrowserManager {
    return new Proxy(createFakeManager(new FakeDriver()), {
      get(target, prop, receiver): unknown {
        if (prop === "getStatus") {
          return () => status;
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as BrowserManager;
  }

  it("READY → 200 + Fake 目录 {models, currentModelKey}(A/B/C,当前 A)", async () => {
    const readyCtx = await setupTestContext({
      geminiAdapter: new FakeGeminiAdapter(),
      browserManager: managerWithStatus("READY"),
    });
    try {
      const res = await fetch(`${readyCtx.baseUrl}/api/provider/models`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: typeof FAKE_MODEL_CATALOG };
      expect(body.data).toEqual(FAKE_MODEL_CATALOG);
      expect(body.data.models.map((m) => m.key)).toEqual(["model-a", "model-b", "model-c"]);
      expect(body.data.currentModelKey).toBe("model-a");
    } finally {
      await readyCtx.close();
    }
  });

  it("LOGIN_REQUIRED → 401 PROVIDER_LOGIN_REQUIRED,adapter 0 call", async () => {
    const adapter = new FakeGeminiAdapter();
    const loginCtx = await setupTestContext({
      geminiAdapter: adapter,
      browserManager: managerWithStatus("LOGIN_REQUIRED"),
    });
    try {
      const res = await fetch(`${loginCtx.baseUrl}/api/provider/models`);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "PROVIDER_LOGIN_REQUIRED",
      );
      expect(adapter.listModelsCalls).toBe(0);
    } finally {
      await loginCtx.close();
    }
  });

  it.each(["BUSY", "STOPPED", "STARTING", "ERROR"] as const)(
    "%s → 500 PROVIDER_NOT_READY,adapter 0 call",
    async (status) => {
      const adapter = new FakeGeminiAdapter();
      const blockedCtx = await setupTestContext({
        geminiAdapter: adapter,
        browserManager: managerWithStatus(status),
      });
      try {
        const res = await fetch(`${blockedCtx.baseUrl}/api/provider/models`);
        expect(res.status).toBe(500);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
          "PROVIDER_NOT_READY",
        );
        expect(adapter.listModelsCalls).toBe(0);
      } finally {
        await blockedCtx.close();
      }
    },
  );

  it("默认 Fake Manager(STOPPED)→ 500 PROVIDER_NOT_READY(矩阵默认态回归)", async () => {
    const adapter = new FakeGeminiAdapter();
    const stoppedCtx = await setupTestContext({ geminiAdapter: adapter });
    try {
      const res = await fetch(`${stoppedCtx.baseUrl}/api/provider/models`);
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "PROVIDER_NOT_READY",
      );
      expect(adapter.listModelsCalls).toBe(0);
    } finally {
      await stoppedCtx.close();
    }
  });

  it("FIX-04: Adapter 抛普通 Error(未实现占位)→ 统一出口 500 INTERNAL_ERROR", async () => {
    const adapter = new FakeGeminiAdapter({
      listModelsError: new Error("model catalog reading is not implemented until M2"),
    });
    const failingCtx = await setupTestContext({
      geminiAdapter: adapter,
      browserManager: managerWithStatus("READY"),
    });
    try {
      const res = await fetch(`${failingCtx.baseUrl}/api/provider/models`);
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "INTERNAL_ERROR",
      );
      expect(adapter.listModelsCalls).toBe(1);
    } finally {
      await failingCtx.close();
    }
  });

  it("真实 GeminiAdapter.listModels M1 占位 → INTERNAL_ERROR(非 PROVIDER_MODEL_SWITCH_FAILED)", async () => {
    const { GeminiWebAdapter } = await import("../../src/providers/gemini/gemini.adapter.js");
    const { AppError } = await import("../../src/common/errors/app-error.js");
    const realAdapter = new GeminiWebAdapter({
      manager: createFakeManager(new FakeDriver()),
      baseUrl: "https://gemini.google.com/app",
      logger: createLogger("silent"),
      options: { responseTimeoutMs: 1000 },
    });
    const err = await realAdapter.listModels().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("INTERNAL_ERROR");
  });
});
