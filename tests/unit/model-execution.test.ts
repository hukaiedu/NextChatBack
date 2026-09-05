import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { AppError } from "../../src/common/errors/app-error.js";
import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import type { BrowserManager } from "../../src/providers/gemini/browser-manager.js";
import type {
  GeminiPromptRunInput,
  GeminiPromptResult,
  ResolvedGeminiModel,
} from "../../src/providers/gemini/gemini.types.js";
import { FakeDriver, FakeGeminiAdapter, createFakeManager } from "../fakes.js";
import type { FakeAdapterBehavior } from "../fakes.js";
import { cancelRequest, setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";

interface Seeded {
  conversationId: string;
  requestId: string;
  assistantMessageId: string;
}

/** providerConversationUrl 唯一:多条请求各给一个会话 URL(与 request-scheduler.test 同款) */
const CONV_URL_1 = "https://gemini.google.com/app/1111aaaa2222bbbb";
const CONV_URL_2 = "https://gemini.google.com/app/0a1b2c3d4e5f6071";

/**
 * Adapter 构造发生在 setupTestContext 之前,而 prisma/baseUrl 那时还不存在;
 * Adapter 方法都在 runOnce 之后才执行,届时 scope 已被 mount 填好。
 */
const scope: { prisma: PrismaClient | null; baseUrl: string; requestId: string } = {
  prisma: null,
  baseUrl: "",
  requestId: "",
};

/** 记录 ensureModel / runPrompt 的调用次序,并在 runPrompt 入口读一次 DB 的 resolved */
class OrderedAdapter extends FakeGeminiAdapter {
  readonly timeline: string[] = [];

  constructor(behavior: FakeAdapterBehavior = {}) {
    super(behavior);
  }

  override async ensureModel(key: string, signal?: AbortSignal): Promise<ResolvedGeminiModel> {
    const resolved = await super.ensureModel(key, signal);
    this.timeline.push(`ensure:${key}`);
    return resolved;
  }

  override async runPrompt(input: GeminiPromptRunInput): Promise<GeminiPromptResult> {
    // 在飞即当前正在执行的 Request;其余仍是 PENDING
    const row = await scope.prisma!.modelRequest.findFirst({ where: { status: "PROCESSING" } });
    this.timeline.push(
      `run:${input.prompt}@resolved=${row?.resolvedModelKey ?? null}/${row?.resolvedModelLabel ?? null}`,
    );
    return super.runPrompt(input);
  }
}

/** ensureModel 开跑前触发一次 HTTP 取消(时点 B:ensureModel 中途 abort) */
class CancelDuringEnsure extends FakeGeminiAdapter {
  override async ensureModel(key: string, signal?: AbortSignal): Promise<ResolvedGeminiModel> {
    await cancelRequest(scope.baseUrl, scope.requestId);
    return super.ensureModel(key, signal);
  }
}

/** ensureModel 成功返回前触发一次 HTTP 取消(时点 C:resolved 已落库、发送前 abort) */
class CancelAfterEnsure extends FakeGeminiAdapter {
  override async ensureModel(key: string, signal?: AbortSignal): Promise<ResolvedGeminiModel> {
    const resolved = await super.ensureModel(key, signal);
    await cancelRequest(scope.baseUrl, scope.requestId);
    return resolved;
  }
}

describe("M3 模型选择接入执行链路(GeminiPromptService + Scheduler,Fake Adapter + 真 SQLite)", () => {
  let ctx: TestContext;
  let manager: BrowserManager;
  let adapter: FakeGeminiAdapter;
  let sequence = 0;

  async function mountWithAdapter(
    makeAdapter: () => FakeGeminiAdapter,
    executionTimeoutMs?: number,
  ): Promise<void> {
    manager = createFakeManager(new FakeDriver());
    adapter = makeAdapter();
    ctx = await setupTestContext({
      browserManager: manager,
      geminiAdapter: adapter,
      // 不用 interval,统一 runOnce 手动驱动,断言确定性
      scheduler: { autoStart: false, executionTimeoutMs },
    });
    scope.prisma = ctx.prisma;
    scope.baseUrl = ctx.baseUrl;
    scope.requestId = "";
    await ctx.reset();
  }

  async function mount(behavior: FakeAdapterBehavior = {}, executionTimeoutMs?: number): Promise<void> {
    await mountWithAdapter(() => new FakeGeminiAdapter(behavior), executionTimeoutMs);
  }

  afterEach(async () => {
    await ctx.close();
  });

  /** 直接落一条 Request(绕过 HTTP;createdAt / requestedModelKey / 初始 status 可控) */
  async function seedPending(
    content: string,
    options: { createdAt?: Date; requestedModelKey?: string; status?: string } = {},
  ): Promise<Seeded> {
    sequence += 1;
    const conversation = await ctx.prisma.conversation.create({
      data: { title: `conv-${sequence}`, status: "ACTIVE", provider: "GEMINI_WEB" },
    });
    const userMessage = await ctx.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "USER",
        content,
        status: "COMPLETED",
        position: 1,
      },
    });
    const assistantMessage = await ctx.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "ASSISTANT",
        content: "",
        status: "PENDING",
        position: 2,
      },
    });
    const request = await ctx.prisma.modelRequest.create({
      data: {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        idempotencyKey: randomUUID(),
        requestFingerprint: randomUUID(),
        status: options.status ?? "PENDING",
        provider: "GEMINI_WEB",
        requestedModelKey: options.requestedModelKey ?? null,
        ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      },
    });
    return {
      conversationId: conversation.id,
      requestId: request.id,
      assistantMessageId: assistantMessage.id,
    };
  }

  async function getRequest(id: string) {
    return ctx.prisma.modelRequest.findUniqueOrThrow({ where: { id } });
  }

  async function getAssistant(id: string) {
    return ctx.prisma.message.findUniqueOrThrow({ where: { id } });
  }

  it("M3-01: requestedModelKey 为 null → 完全跳过 ensureModel,resolved 保持 null,指纹不变(V1 回归)", async () => {
    await mount({ answer: "最终回答" });
    const seeded = await seedPending("普通消息");
    const before = await getRequest(seeded.requestId);

    await ctx.scheduler!.runOnce();

    expect(adapter.ensureModelCalls).toEqual([]);
    expect(adapter.runCalls).toHaveLength(1);
    const after = await getRequest(seeded.requestId);
    expect(after.status).toBe("SUCCESS");
    expect(after.requestedModelKey).toBeNull();
    expect(after.resolvedModelKey).toBeNull();
    expect(after.resolvedModelLabel).toBeNull();
    // §十二:执行链路不触碰指纹
    expect(after.requestFingerprint).toBe(before.requestFingerprint);
  });

  it("M3-02: modelKey 非空 → 顺序 ensureModel → resolved 落库 → runPrompt(runPrompt 启动时 DB 已可见)", async () => {
    await mountWithAdapter(() => new OrderedAdapter({ answer: "回答" }));
    const seeded = await seedPending("换个模型", { requestedModelKey: "model-b" });
    scope.requestId = seeded.requestId;
    const before = await getRequest(seeded.requestId);

    await ctx.scheduler!.runOnce();

    expect(adapter.ensureModelCalls).toEqual(["model-b"]);
    expect((adapter as OrderedAdapter).timeline).toEqual([
      "ensure:model-b",
      // runPrompt 入口读库:resolved 必须已经写好 —— 顺序铁律的直接证据
      "run:换个模型@resolved=model-b/Model B",
    ]);
    const after = await getRequest(seeded.requestId);
    expect(after.status).toBe("SUCCESS");
    // resolved 取 ensureModel 的返回值(key + label),不从 requestedModelKey 复制
    expect(after.resolvedModelKey).toBe("model-b");
    expect(after.resolvedModelLabel).toBe("Model B");
    expect(after.requestFingerprint).toBe(before.requestFingerprint);
    expect(after.errorCode).toBeNull();
  });

  it("M3-03: 目标已是页面当前选中模型 → 仍调用 ensureModel 并落 resolved(幂等由 Adapter 层保证)", async () => {
    await mount({ answer: "回答" });
    // Fake 目录当前选中 model-a
    const seeded = await seedPending("就用这个", { requestedModelKey: "model-a" });

    await ctx.scheduler!.runOnce();

    expect(adapter.ensureModelCalls).toEqual(["model-a"]);
    const after = await getRequest(seeded.requestId);
    expect(after.status).toBe("SUCCESS");
    expect(after.resolvedModelKey).toBe("model-a");
    expect(after.resolvedModelLabel).toBe("Model A");
    expect(adapter.runCalls).toHaveLength(1);
  });

  it("M3-04: PROVIDER_MODEL_UNAVAILABLE → FAILED,Prompt 不发送,resolved 保持 null", async () => {
    await mount({
      ensureModelError: new AppError(
        ErrorCodes.PROVIDER_MODEL_UNAVAILABLE,
        "Model unknown-model is not available",
        400,
      ),
    });
    const seeded = await seedPending("用不存在的模型", { requestedModelKey: "unknown-model" });

    await ctx.scheduler!.runOnce();

    expect(adapter.ensureModelCalls).toEqual(["unknown-model"]);
    expect(adapter.runCalls).toEqual([]);
    const after = await getRequest(seeded.requestId);
    expect(after.status).toBe("FAILED");
    expect(after.errorCode).toBe(ErrorCodes.PROVIDER_MODEL_UNAVAILABLE);
    expect(after.resolvedModelKey).toBeNull();
    const assistant = await getAssistant(seeded.assistantMessageId);
    expect(assistant.status).toBe("FAILED");
  });

  it("M3-05: PROVIDER_MODEL_SWITCH_FAILED → FAILED,同样不发送 Prompt", async () => {
    await mount({
      ensureModelError: new AppError(
        ErrorCodes.PROVIDER_MODEL_SWITCH_FAILED,
        "Model selection could not be confirmed",
        500,
      ),
    });
    const seeded = await seedPending("切不过去", { requestedModelKey: "model-c" });

    await ctx.scheduler!.runOnce();

    expect(adapter.runCalls).toEqual([]);
    const after = await getRequest(seeded.requestId);
    expect(after.status).toBe("FAILED");
    expect(after.errorCode).toBe(ErrorCodes.PROVIDER_MODEL_SWITCH_FAILED);
    expect(after.resolvedModelKey).toBeNull();
  });

  it.each([ErrorCodes.PROVIDER_PAGE_CLOSED, ErrorCodes.PROVIDER_BROWSER_CRASHED])(
    "M3-06: %s 经 ensureModel 原样透传,不重包不吞掉",
    async (code) => {
      await mount({
        ensureModelError: new AppError(code, "page lifecycle broke during model menu", 500),
      });
      const seeded = await seedPending("问题", { requestedModelKey: "model-b" });

      await ctx.scheduler!.runOnce();

      const after = await getRequest(seeded.requestId);
      expect(after.status).toBe("FAILED");
      expect(after.errorCode).toBe(code);
      expect(after.resolvedModelKey).toBeNull();
      expect(adapter.runCalls).toEqual([]);
    },
  );

  it("M3-07: 取消时点 A(执行入口已 abort)→ cancelled,0 次 Provider DOM,resolved 保持 null", async () => {
    await mount();
    const seeded = await seedPending("还没开始就取消", { requestedModelKey: "model-b" });
    const request = await getRequest(seeded.requestId);
    const userMessage = await ctx.prisma.message.findUniqueOrThrow({
      where: { id: request.userMessageId },
    });

    const controller = new AbortController();
    controller.abort();
    const result = await ctx.executor.execute({
      request,
      userMessage,
      signal: controller.signal,
    });

    expect(result).toEqual({ conversationUrl: null, answer: "", cancelled: true });
    expect(adapter.openCalls).toEqual([]);
    expect(adapter.ensureModelCalls).toEqual([]);
    expect(adapter.runCalls).toEqual([]);
    const after = await getRequest(seeded.requestId);
    expect(after.resolvedModelKey).toBeNull();
  });

  it("M3-08: 取消时点 B(ensureModel 中途 abort)→ 既有 CANCELLED 终态,resolved null,Prompt 不发送", async () => {
    await mountWithAdapter(() => new CancelDuringEnsure());
    const seeded = await seedPending("切一半就停", { requestedModelKey: "model-b" });
    scope.requestId = seeded.requestId;

    await ctx.scheduler!.runOnce();

    expect(adapter.ensureModelCalls).toEqual(["model-b"]);
    expect(adapter.runCalls).toEqual([]);
    const after = await getRequest(seeded.requestId);
    // §十:AbortError 收敛到既有取消终态,绝不落 INTERNAL_ERROR
    expect(after.status).toBe("CANCELLED");
    expect(after.errorCode).toBeNull();
    expect(after.resolvedModelKey).toBeNull();
    const assistant = await getAssistant(seeded.assistantMessageId);
    expect(assistant.status).toBe("CANCELLED");
  });

  it("M3-09: 取消时点 C(resolved 落库后、发送前 abort)→ CANCELLED,resolved 保留,Prompt 不发送", async () => {
    await mountWithAdapter(() => new CancelAfterEnsure());
    const seeded = await seedPending("落库完就停", { requestedModelKey: "model-b" });
    scope.requestId = seeded.requestId;

    await ctx.scheduler!.runOnce();

    expect(adapter.ensureModelCalls).toEqual(["model-b"]);
    expect(adapter.runCalls).toEqual([]);
    const after = await getRequest(seeded.requestId);
    expect(after.status).toBe("CANCELLED");
    // resolved 已确认写入,必须保留(绝不回抹 null)
    expect(after.resolvedModelKey).toBe("model-b");
    expect(after.resolvedModelLabel).toBe("Model B");
    const assistant = await getAssistant(seeded.assistantMessageId);
    expect(assistant.status).toBe("CANCELLED");
    expect(assistant.content).toBe("");
  });

  it("M3-10: resolved 落库失败(行已离开在飞)→ 抛 INTERNAL_ERROR,Prompt 不发送(§七)", async () => {
    await mount({ answer: "不该出现的回答" });
    // 直接驱动 executor:行是终态(SUCCESS)→ markResolved 条件写 count=0
    const seeded = await seedPending("问题", { requestedModelKey: "model-b", status: "SUCCESS" });
    const request = await getRequest(seeded.requestId);
    const userMessage = await ctx.prisma.message.findUniqueOrThrow({
      where: { id: request.userMessageId },
    });

    const outcome = await ctx.executor
      .execute({ request, userMessage, signal: new AbortController().signal })
      .then(
        () => "unexpected-success" as const,
        (err: unknown) => err,
      );

    expect(outcome).toBeInstanceOf(AppError);
    expect((outcome as AppError).code).toBe(ErrorCodes.INTERNAL_ERROR);
    expect(adapter.ensureModelCalls).toEqual(["model-b"]);
    expect(adapter.runCalls).toEqual([]);
    const after = await getRequest(seeded.requestId);
    expect(after.resolvedModelKey).toBeNull();
  });

  it("M3-11: watchdog 超时 → TIMEOUT,resolved 保留(§六:发送后的失败不抹 resolved)", async () => {
    await mount({ hang: true }, 80);
    const seeded = await seedPending("挂死", { requestedModelKey: "model-b" });

    await ctx.scheduler!.runOnce();

    const after = await getRequest(seeded.requestId);
    expect(after.status).toBe("TIMEOUT");
    expect(after.errorCode).toBe(ErrorCodes.PROVIDER_RESPONSE_TIMEOUT);
    expect(after.resolvedModelKey).toBe("model-b");
    expect(after.resolvedModelLabel).toBe("Model B");
  });

  it("M3-12: 生成中取消(既有 stopGeneration 路径)→ CANCELLED,resolved 保留", async () => {
    await mountWithAdapter(
      () =>
        new FakeGeminiAdapter({
          streamTexts: ["部分一", "部分二"],
          cancelBehaviour: "cancelled",
          onStreamText: async (_text, index) => {
            if (index === 0) {
              const res = await cancelRequest(scope.baseUrl, scope.requestId);
              expect(res.status).toBe(202);
            }
          },
        }),
    );
    const seeded = await seedPending("边生成边停", { requestedModelKey: "model-b" });
    scope.requestId = seeded.requestId;

    await ctx.scheduler!.runOnce();

    expect(adapter.ensureModelCalls).toEqual(["model-b"]);
    const after = await getRequest(seeded.requestId);
    expect(after.status).toBe("CANCELLED");
    expect(after.resolvedModelKey).toBe("model-b");
    const assistant = await getAssistant(seeded.assistantMessageId);
    expect(assistant.status).toBe("CANCELLED");
    expect(assistant.content).toBe("部分二");
  });

  it("M3-13: 串行性(§十一):两条 modelKey 请求的 ensure→run 逐条完成,不互相插队", async () => {
    await mountWithAdapter(() =>
      new OrderedAdapter({ answer: "回答", conversationUrls: [CONV_URL_1, CONV_URL_2] }),
    );
    await seedPending("第一条", {
      createdAt: new Date(Date.now() - 60_000),
      requestedModelKey: "model-b",
    });
    await seedPending("第二条", { requestedModelKey: "model-c" });

    await ctx.scheduler!.runOnce();

    expect(adapter.ensureModelCalls).toEqual(["model-b", "model-c"]);
    expect((adapter as OrderedAdapter).timeline).toEqual([
      "ensure:model-b",
      "run:第一条@resolved=model-b/Model B",
      "ensure:model-c",
      "run:第二条@resolved=model-c/Model C",
    ]);
    const requests = await ctx.prisma.modelRequest.findMany({ orderBy: { createdAt: "asc" } });
    expect(requests.map((r) => [r.status, r.resolvedModelKey])).toEqual([
      ["SUCCESS", "model-b"],
      ["SUCCESS", "model-c"],
    ]);
  });
});
