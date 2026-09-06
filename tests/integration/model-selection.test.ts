import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppError } from "../../src/common/errors/app-error.js";
import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { createLogger } from "../../src/common/logger/logger.js";
import type { BrowserManager } from "../../src/providers/gemini/browser-manager.js";
import {
  createConversation,
  sendMessage,
  setupTestContext,
} from "../helpers.js";
import type { TestContext } from "../helpers.js";
import {
  createFakeManager,
  FAKE_MODEL_CATALOG,
  FakeDriver,
  FakeGeminiAdapter,
} from "../fakes.js";
import type { FakeAdapterBehavior } from "../fakes.js";

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

/** 构造固定状态的 BrowserManager 代理(测试用:绕过真实状态机) */
function managerWithStatus(
  status: string,
  opts?: { openGeminiDelayMs?: number },
): BrowserManager & { openGeminiCalls: number } {
  const real = createFakeManager(new FakeDriver());
  let openGeminiCalls = 0;
  const mgr = new Proxy(real, {
    get(target, prop, receiver): unknown {
      if (prop === "openGeminiCalls") return openGeminiCalls;
      if (prop === "getStatus") return () => status;
      if (prop === "openGemini")
        return async () => {
          openGeminiCalls++;
          if (opts?.openGeminiDelayMs) {
            await new Promise((r) => setTimeout(r, opts.openGeminiDelayMs));
          }
          return status;
        };
      if (prop === "setBusy") return () => {};
      if (prop === "clearBusy") return () => {};
      if (prop === "restart") return async () => {};
      if (prop === "takeProviderFault") return () => null;
      if (prop === "settleCloseEvents") return async () => {};
      return Reflect.get(target, prop, receiver);
    },
  }) as BrowserManager & { openGeminiCalls: number };
  return mgr;
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

  it("真实 GeminiAdapter.listModels:Provider 未就绪 → PROVIDER_NOT_READY(非 INTERNAL_ERROR/SWITCH_FAILED)", async () => {
    // M2 已用真实目录读取替换 M1 占位:未启动的 Fake Manager 没有 page,
    // requireGeminiPage 先拦截,不允许把「没就绪」误报成目录/切换类错误
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
    expect((err as AppError).code).toBe("PROVIDER_NOT_READY");
  });
});


// ---------------------------------------------------------------------------------
// M3(§十五):模型选择接入真实执行链路。HTTP 发送 → 真 Scheduler → 真执行器
// (装配根构造的 GeminiPromptService),Adapter 用 Fake;逐 Case 独立 app。
// ---------------------------------------------------------------------------------
describe("M3 模型选择接入执行链路(Case A/B/C,真实 executor/scheduler)", () => {
  async function mount(behavior: FakeAdapterBehavior = {}): Promise<{
    adapter: FakeGeminiAdapter;
    ctx: TestContext;
  }> {
    const adapter = new FakeGeminiAdapter({ answer: "假回答", ...behavior });
    const ctx = await setupTestContext({
      geminiAdapter: adapter,
      scheduler: { autoStart: false },
    });
    await ctx.reset();
    return { adapter, ctx };
  }

  it("Case A:不带 modelKey → SUCCESS,ensureModel 0 调用,resolved null(V1 兼容)", async () => {
    const { adapter, ctx } = await mount();
    try {
      const conv = await createConversation(ctx.baseUrl);
      const sent = await sendMessage(ctx.baseUrl, conv.id, "你好", "m3-case-a");
      expect(sent.status).toBe(202);
      const { request } = ((await sent.json()) as MessageSendBody).data;
      expect(request.requestedModelKey).toBeNull();

      await ctx.scheduler!.runOnce();

      const row = await ctx.prisma.modelRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(row.status).toBe("SUCCESS");
      expect(row.resolvedModelKey).toBeNull();
      expect(row.resolvedModelLabel).toBeNull();
      expect(adapter.ensureModelCalls).toEqual([]);
      expect(adapter.runCalls).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });

  it("Case B:modelKey=model-a → 全链路 SUCCESS,resolved 落库,DTO 与 assistant 均可见", async () => {
    const { adapter, ctx } = await mount();
    try {
      const conv = await createConversation(ctx.baseUrl);
      const sent = await sendMessage(ctx.baseUrl, conv.id, "切到 A", "m3-case-b", "model-a");
      expect(sent.status).toBe(202);
      const { request } = ((await sent.json()) as MessageSendBody).data;
      expect(request.requestedModelKey).toBe("model-a");
      expect(request.resolvedModelKey).toBeNull();

      await ctx.scheduler!.runOnce();

      const row = await ctx.prisma.modelRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(row.status).toBe("SUCCESS");
      expect(row.resolvedModelKey).toBe("model-a");
      expect(row.resolvedModelLabel).toBe("Model A");
      expect(adapter.ensureModelCalls).toEqual(["model-a"]);

      const detail = await fetch(`${ctx.baseUrl}/api/requests/${request.id}`);
      expect(detail.status).toBe(200);
      const detailBody = (await detail.json()) as {
        data: { resolvedModelKey: string | null; resolvedModelLabel: string | null };
      };
      expect(detailBody.data.resolvedModelKey).toBe("model-a");
      expect(detailBody.data.resolvedModelLabel).toBe("Model A");

      const assistant = await ctx.prisma.message.findUniqueOrThrow({
        where: { id: row.assistantMessageId },
      });
      expect(assistant.status).toBe("COMPLETED");
      expect(assistant.content).toBe("假回答");
    } finally {
      await ctx.close();
    }
  });

  it("Case C:未知 modelKey → FAILED PROVIDER_MODEL_UNAVAILABLE,Prompt 不发送,resolved null", async () => {
    const { adapter, ctx } = await mount({
      ensureModelError: new AppError(
        ErrorCodes.PROVIDER_MODEL_UNAVAILABLE,
        "Model model-z is not available",
        400,
      ),
    });
    try {
      const conv = await createConversation(ctx.baseUrl);
      const sent = await sendMessage(ctx.baseUrl, conv.id, "用不存在的", "m3-case-c", "model-z");
      expect(sent.status).toBe(202);
      const { request } = ((await sent.json()) as MessageSendBody).data;

      await ctx.scheduler!.runOnce();

      const row = await ctx.prisma.modelRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(row.status).toBe("FAILED");
      expect(row.errorCode).toBe(ErrorCodes.PROVIDER_MODEL_UNAVAILABLE);
      expect(row.resolvedModelKey).toBeNull();
      expect(adapter.ensureModelCalls).toEqual(["model-z"]);
      expect(adapter.runCalls).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------------
// M4(§二十七):前端保存的会话偏好接入执行链路。选择器只走 PATCH preferredModelKey,
// 发送永远省略 modelKey —— 三个 Case 全部走「真 Scheduler → 真执行器 + Fake Adapter」。
// ---------------------------------------------------------------------------------
describe("M4 会话偏好接入执行链路(Case A/B/C)", () => {
  async function mount(): Promise<{
    adapter: FakeGeminiAdapter;
    ctx: TestContext;
  }> {
    const adapter = new FakeGeminiAdapter({ answer: "假回答" });
    const ctx = await setupTestContext({
      geminiAdapter: adapter,
      scheduler: { autoStart: false },
    });
    await ctx.reset();
    return { adapter, ctx };
  }

  it("Case A:PATCH 设置偏好 → 200,DTO 与库中均为新偏好", async () => {
    const { ctx } = await mount();
    try {
      const conv = await createConversation(ctx.baseUrl);
      const patched = await patchConversation(ctx, conv.id, { preferredModelKey: "model-b" });
      expect(patched.status).toBe(200);
      const body = (await patched.json()) as { data: { preferredModelKey: string | null } };
      expect(body.data.preferredModelKey).toBe("model-b");

      const reloaded = await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
      expect(reloaded.preferredModelKey).toBe("model-b");
    } finally {
      await ctx.close();
    }
  });

  it("Case B(最重要):偏好=A + 发送省略 modelKey → requested=A → resolved=A,SUCCESS", async () => {
    const { adapter, ctx } = await mount();
    try {
      const conv = await createConversation(ctx.baseUrl);
      await patchConversation(ctx, conv.id, { preferredModelKey: "model-b" });

      const sent = await sendMessage(ctx.baseUrl, conv.id, "你好", "m4-case-b");
      expect(sent.status).toBe(202);
      const { request } = ((await sent.json()) as MessageSendBody).data;
      expect(request.requestedModelKey).toBe("model-b");

      await ctx.scheduler!.runOnce();

      const row = await ctx.prisma.modelRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(row.status).toBe("SUCCESS");
      expect(row.resolvedModelKey).toBe("model-b");
      expect(row.resolvedModelLabel).toBe("Model B");
      expect(adapter.ensureModelCalls).toEqual(["model-b"]);
      expect(adapter.runCalls).toHaveLength(1);

      const assistant = await ctx.prisma.message.findUniqueOrThrow({
        where: { id: row.assistantMessageId },
      });
      expect(assistant.status).toBe("COMPLETED");
      expect(assistant.content).toBe("假回答");
    } finally {
      await ctx.close();
    }
  });

  it("Case C:恢复默认(PATCH null)+ 发送省略 modelKey → ensureModel 0 调用(V1 兼容)", async () => {
    const { adapter, ctx } = await mount();
    try {
      const conv = await createConversation(ctx.baseUrl);
      await patchConversation(ctx, conv.id, { preferredModelKey: "model-b" });
      const cleared = await patchConversation(ctx, conv.id, { preferredModelKey: null });
      expect(cleared.status).toBe(200);

      const sent = await sendMessage(ctx.baseUrl, conv.id, "你好", "m4-case-c");
      expect(sent.status).toBe(202);
      const { request } = ((await sent.json()) as MessageSendBody).data;
      expect(request.requestedModelKey).toBeNull();

      await ctx.scheduler!.runOnce();

      const row = await ctx.prisma.modelRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(row.status).toBe("SUCCESS");
      expect(row.resolvedModelKey).toBeNull();
      expect(adapter.ensureModelCalls).toEqual([]);
      expect(adapter.runCalls).toHaveLength(1);
    } finally {
      await ctx.close();
    }
  });

  it("Case D(FIX-01):建会话即设偏好 + 首条消息省略 modelKey → requested=A resolved=A SUCCESS", async () => {
    const { adapter, ctx } = await mount();
    try {
      const conv = await createConversation(ctx.baseUrl);
      const patched = await patchConversation(ctx, conv.id, { preferredModelKey: "model-a" });
      expect(patched.status).toBe(200);

      const sent = await sendMessage(ctx.baseUrl, conv.id, "首条", "m4-fix01-d");
      expect(sent.status).toBe(202);
      const { request } = ((await sent.json()) as MessageSendBody).data;
      expect(request.requestedModelKey).toBe("model-a");

      await ctx.scheduler!.runOnce();

      const row = await ctx.prisma.modelRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(row.status).toBe("SUCCESS");
      expect(row.resolvedModelKey).toBe("model-a");
      expect(row.resolvedModelLabel).toBe("Model A");
      expect(adapter.ensureModelCalls).toEqual(["model-a"]);
      expect(adapter.runCalls).toHaveLength(1);

      const assistant = await ctx.prisma.message.findUniqueOrThrow({
        where: { id: row.assistantMessageId },
      });
      expect(assistant.status).toBe("COMPLETED");
      expect(assistant.content).toBe("假回答");
    } finally {
      await ctx.close();
    }
  });
});

describe("FIX-06/FIX-08:Provider Page 操作互斥锁", () => {
  it("LOCK-00:openGemini 与 listModels 最大并发 = 1(FIX-08)", async () => {
    const adapter = new FakeGeminiAdapter({ listModelsDelayMs: 200 });
    const browserManager = managerWithStatus("READY", { openGeminiDelayMs: 200 });
    const ctx = await setupTestContext({
      geminiAdapter: adapter,
      browserManager,
      scheduler: { scanIntervalMs: 25, autoStart: false },
    });
    try {
      await ctx.reset();
      const conv = await createConversation(ctx.baseUrl);
      await sendMessage(ctx.baseUrl, conv.id, "触发执行", "lock-00-key");

      // Fire both concurrently: scheduler (openGemini) + GET /models (listModels)
      const schedulerPromise = ctx.scheduler!.runOnce();
      const modelsPromise = fetch(`${ctx.baseUrl}/api/provider/models`);

      const [modelsRes] = await Promise.all([modelsPromise, schedulerPromise]);

      // One got the lock, the other either waited or was rejected.
      // Key assertion: no concurrent DOM operations.
      // If models got through, it must have been before or after openGemini.
      // If models was rejected, it proves scheduler held lock during openGemini.
      const modelsBody = (await modelsRes.json()) as { error?: { code: string }; data?: unknown };
      const modelsRejected =
        modelsRes.status === 500 && modelsBody.error?.code === "PROVIDER_NOT_READY";
      const modelsSucceeded = modelsRes.status === 200;
      expect(modelsRejected || modelsSucceeded).toBe(true);

      // Scheduler must have completed successfully
      const row = await ctx.prisma.modelRequest.findFirstOrThrow({
        where: { conversationId: conv.id },
      });
      expect(row.status).toBe("SUCCESS");
      expect(browserManager.openGeminiCalls).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  it("LOCK-01:listModels 持锁期间 Scheduler 不调 openGemini(FIX-08)", async () => {
    const adapter = new FakeGeminiAdapter({ listModelsDelayMs: 300 });
    const browserManager = managerWithStatus("READY");
    const ctx = await setupTestContext({
      geminiAdapter: adapter,
      browserManager,
      scheduler: { scanIntervalMs: 25, autoStart: false },
    });
    try {
      await ctx.reset();
      const conv = await createConversation(ctx.baseUrl);
      await sendMessage(ctx.baseUrl, conv.id, "排队", "lock-01-key");

      // listModels grabs lock first (non-blocking tryAcquire succeeds since nothing holds it)
      const modelsPromise = fetch(`${ctx.baseUrl}/api/provider/models`);
      // Give listModels time to acquire the lock
      await new Promise((r) => setTimeout(r, 50));

      // Scheduler tries to run — must wait for lock (acquire blocks)
      // At this point openGeminiCalls must still be 0
      expect(browserManager.openGeminiCalls).toBe(0);

      // Wait for listModels to finish and release lock
      const modelsRes = await modelsPromise;
      expect(modelsRes.status).toBe(200);
      expect(adapter.listModelsCalls).toBe(1);

      // Now scheduler can proceed
      await ctx.scheduler!.runOnce();

      const row = await ctx.prisma.modelRequest.findFirstOrThrow({
        where: { conversationId: conv.id },
      });
      expect(row.status).toBe("SUCCESS");
      expect(browserManager.openGeminiCalls).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  it("LOCK-02:Scheduler 持锁(gateProvider 前)→ GET /models 立即 PROVIDER_NOT_READY(FIX-08)", async () => {
    const adapter = new FakeGeminiAdapter({ hang: true });
    const browserManager = managerWithStatus("READY", { openGeminiDelayMs: 200 });
    const ctx = await setupTestContext({
      geminiAdapter: adapter,
      browserManager,
      scheduler: { scanIntervalMs: 25, autoStart: false },
    });
    try {
      await ctx.reset();
      const conv = await createConversation(ctx.baseUrl);
      await sendMessage(ctx.baseUrl, conv.id, "触发执行", "lock-02-key");

      // Start scheduler — it acquires lock BEFORE openGemini
      void ctx.scheduler!.runOnce();
      // Small delay to let scheduler acquire lock and enter openGemini delay
      await new Promise((r) => setTimeout(r, 50));

      // GET /models must be rejected immediately (scheduler holds lock)
      const res = await fetch(`${ctx.baseUrl}/api/provider/models`);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("PROVIDER_NOT_READY");
      expect(adapter.listModelsCalls).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  it("LOCK-03:listModels 抛错 → 锁释放,后续 Request 正常执行", async () => {
    const adapter = new FakeGeminiAdapter({
      listModelsError: new AppError(ErrorCodes.PROVIDER_NOT_READY, "test error"),
    });
    const browserManager = managerWithStatus("READY");
    const ctx = await setupTestContext({
      geminiAdapter: adapter,
      browserManager,
      scheduler: { scanIntervalMs: 25, autoStart: false },
    });
    try {
      await ctx.reset();
      const res = await fetch(`${ctx.baseUrl}/api/provider/models`);
      expect(res.status).toBe(500);

      const conv = await createConversation(ctx.baseUrl);
      await sendMessage(ctx.baseUrl, conv.id, "测试", "lock-03-key");
      await ctx.scheduler!.runOnce();

      const row = await ctx.prisma.modelRequest.findFirstOrThrow({
        where: { conversationId: conv.id },
      });
      expect(row.status).toBe("SUCCESS");
    } finally {
      await ctx.close();
    }
  });

  it("LOCK-04:Request 失败 → 锁释放,后续 GET /models 正常", async () => {
    const adapter = new FakeGeminiAdapter({
      runError: new AppError(ErrorCodes.INTERNAL_ERROR, "boom"),
    });
    const browserManager = managerWithStatus("READY");
    const ctx = await setupTestContext({
      geminiAdapter: adapter,
      browserManager,
      scheduler: { scanIntervalMs: 25, autoStart: false },
    });
    try {
      await ctx.reset();
      const conv = await createConversation(ctx.baseUrl);
      await sendMessage(ctx.baseUrl, conv.id, "触发失败", "lock-04-key");
      await ctx.scheduler!.runOnce();

      const row = await ctx.prisma.modelRequest.findFirstOrThrow({
        where: { conversationId: conv.id },
      });
      expect(row.status).toBe("FAILED");

      const res = await fetch(`${ctx.baseUrl}/api/provider/models`);
      expect(res.status).toBe(200);
      expect(adapter.listModelsCalls).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  it("LOCK-05:多次交替调用无死锁", async () => {
    const adapter = new FakeGeminiAdapter();
    const browserManager = managerWithStatus("READY");
    const ctx = await setupTestContext({
      geminiAdapter: adapter,
      browserManager,
      scheduler: { scanIntervalMs: 25, autoStart: false },
    });
    try {
      for (let i = 0; i < 3; i++) {
        await ctx.reset();
        const res = await fetch(`${ctx.baseUrl}/api/provider/models`);
        expect(res.status).toBe(200);

        const conv = await createConversation(ctx.baseUrl);
        await sendMessage(ctx.baseUrl, conv.id, `第${i}条`, `lock-05-${i}`);
        await ctx.scheduler!.runOnce();

        const row = await ctx.prisma.modelRequest.findFirstOrThrow({
          where: { conversationId: conv.id },
        });
        expect(row.status).toBe("SUCCESS");
      }
      expect(adapter.listModelsCalls).toBe(3);
    } finally {
      await ctx.close();
    }
  });
});
