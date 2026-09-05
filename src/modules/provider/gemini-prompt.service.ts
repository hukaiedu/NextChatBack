import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import type { Logger } from "../../common/logger/logger.js";
import type { BrowserManager } from "../../providers/gemini/browser-manager.js";
import { conversationUnavailable } from "../../providers/gemini/gemini.errors.js";
import {
  extractConversationId,
  normalizeConversationUrl,
} from "../../providers/gemini/gemini.selectors.js";
import type {
  GeminiAdapter,
  GeminiPromptResult,
  ResolvedGeminiModel,
} from "../../providers/gemini/gemini.types.js";
import type { ConversationModel, MessageModel, ModelRequestModel } from "../../generated/prisma/models.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { ConversationService } from "../conversation/conversation.service.js";
import type { RequestRepository } from "../request/request.repository.js";
import type { GeminiStreamService } from "./gemini-stream.service.js";

export interface PromptExecutionInput {
  request: ModelRequestModel;
  /** USER 消息(content 即 Prompt,已 trim) */
  userMessage: MessageModel;
  /** 取消信号(第 8 阶段):被 abort 时 Adapter 尝试让 Gemini 停止生成 */
  signal?: AbortSignal;
}

export interface PromptExecutionResult {
  /** 本次执行使用的 Provider Conversation URL(规范化且已落库);取消时 URL 可能尚未出现 → null */
  conversationUrl: string | null;
  /** Provider 返回的最终回答文本 */
  answer: string;
  /**
   * true = 通过 stopGeneration 确认 Gemini 已停止生成(§11.3);
   * M3 起 Prompt 发送前(执行入口/模型选择段)被 abort 时同样为 true,此时无需停止生成。
   */
  cancelled?: boolean;
}

/** Scheduler 对执行器的窄接口(测试可注入替身) */
export interface PromptExecutor {
  execute(input: PromptExecutionInput): Promise<PromptExecutionResult>;
  /** 确认 Provider 页面当前没有正在进行的生成(槽位释放判据) */
  confirmIdle(): Promise<boolean>;
}

/**
 * Provider 执行器:已被 Scheduler 认领的 Request → Gemini 实际执行。
 *
 * 职责(prd §6.2 O→AF 段):打开已有/新会话 → [M3:requestedModelKey 非空时
 * ensureModel → resolved 立即落库] → 发 Prompt → URL 一确定立即落库 →
 * 生成期间的回答文本交给流式层(第 6 阶段)→ 读回最终回答。
 * 不做:Request 状态流转与 Assistant 收尾(§11.4 归 RequestService);
 * Provider 就绪门禁与 BUSY(Scheduler/BrowserManager 职责,本类执行时页面必已 READY/BUSY)。
 */
export class GeminiPromptService implements PromptExecutor {
  constructor(
    private readonly conversations: ConversationService,
    private readonly browserManager: BrowserManager,
    private readonly adapter: GeminiAdapter,
    private readonly logger: Logger,
    private readonly streams: GeminiStreamService,
    private readonly prisma: PrismaClient,
    private readonly requests: RequestRepository,
  ) {}

  async execute(input: PromptExecutionInput): Promise<PromptExecutionResult> {
    const { request, userMessage } = input;
    // 取消时点 A:执行入口已 abort → 不触碰任何 Provider DOM,resolved 保持 null
    if (input.signal?.aborted) {
      return this.cancelledBeforePrompt();
    }
    const conversation = await this.requireConversation(request.conversationId);

    const existingUrl = conversation.providerConversationUrl;
    await this.adapter.openConversation(existingUrl);

    // 模型选择段:requestedModelKey == null(V1 兼容)完全跳过 —— 不调 ensureModel、
    // 不做模型菜单 DOM 探测,resolved 保持 null,指纹与 V1 逐字节一致。
    let resolvedModelKey: string | null = null;
    let resolvedModelLabel: string | null = null;
    if (request.requestedModelKey !== null) {
      let resolved: ResolvedGeminiModel;
      try {
        resolved = await this.adapter.ensureModel(request.requestedModelKey, input.signal);
      } catch (err) {
        // 取消时点 B:ensureModel 中途 abort —— 不发送 Prompt,也绝不猜测/补写 resolved
        if (input.signal?.aborted) {
          return this.cancelledBeforePrompt();
        }
        throw err;
      }
      // resolved 只取 ensureModel 的返回值(key 与 label),不从 requestedModelKey 复制;
      // 落库失败(含行已离开在飞)必须阻止发送 Prompt —— 审计完整性优先
      const written = await this.requests.markResolved(
        this.prisma,
        request.id,
        resolved.key,
        resolved.label,
      );
      if (written === 0) {
        throw new AppError(
          ErrorCodes.INTERNAL_ERROR,
          `Request ${request.id} is not in-flight; resolved model was not persisted`,
        );
      }
      resolvedModelKey = resolved.key;
      resolvedModelLabel = resolved.label;

      // 取消时点 C:resolved 已落库必须保留,但 Prompt 不再发送
      if (input.signal?.aborted) {
        return this.cancelledBeforePrompt();
      }
    }

    // 每次执行一个流式写入器:广播走事件总线,落库按节流间隔,收尾补写剩余文本
    const stream = this.streams.open(request.id, request.assistantMessageId);
    const savedMappings: { url: string; at: string }[] = [];
    let result: GeminiPromptResult;
    try {
      result = await this.adapter.runPrompt({
        prompt: userMessage.content,
        existingUrl,
        signal: input.signal,
        // URL 一确定就落库;落库失败会一路抛出去,绝不允许"没存下 URL 还继续读回答"(§6.3)
        onConversationUrl: async (observed) => {
          const normalized = normalizeConversationUrl(observed);
          if (!normalized || extractConversationId(normalized) === null) {
            throw conversationUnavailable();
          }
          await this.conversations.saveProviderConversationUrl(conversation.id, normalized);
          savedMappings.push({ url: normalized, at: new Date().toISOString() });
        },
        onText: (text) => stream.push(text),
      });
    } finally {
      // 失败执行也要补写:重连时读到的 DB 内容才和 SSE 已经推过的一致(flush 自身只降级为日志)
      await stream.flush();
    }
    const saved = savedMappings[savedMappings.length - 1];
    if (!saved && !result.cancelled) {
      // GeminiAdapter 是可注入接缝,「成功返回前必已落库」这条契约必须校验而不是假设。
      // 取消例外:URL 要等模型开始响应才出现,取消点可能早于它 —— 此时没有会话映射可写
      throw new AppError(
        ErrorCodes.PROVIDER_DOM_CHANGED,
        "Provider conversation url was not saved",
      );
    }

    // prd §14:只记 id、长度、耗时与错误码,不记 Prompt / 回答原文 / 未脱敏 URL
    this.logger.info(
      {
        requestId: request.id,
        conversationId: conversation.id,
        promptLength: userMessage.content.length,
        answerLength: result.answer.length,
        urlDetectedElapsedMs: result.urlDetectedElapsedMs,
        answerElapsedMs: result.answerElapsedMs,
        reusedConversation: existingUrl !== null,
        resolvedModelKey,
      },
      "gemini prompt completed",
    );

    return { conversationUrl: saved?.url ?? null, answer: result.answer, cancelled: result.cancelled };
  }

  /**
   * Prompt 发送前的取消收尾(时点 A/B/C 共用):URL 为 null(尚未出现)、无回答。
   * 由 Scheduler 既有分派(result.cancelled → requestService.cancelled)落 CANCELLED 终态,
   * AbortError 绝不进入 classifyExecutorError(否则被兜底成 INTERNAL_ERROR)。
   */
  private cancelledBeforePrompt(): PromptExecutionResult {
    return { conversationUrl: null, answer: "", cancelled: true };
  }

  async confirmIdle(): Promise<boolean> {
    return this.adapter.confirmIdle();
  }

  /** 归档/删除校验:活动 Request 期间数据库 trigger 已挡住归档删除,这里只作兜底 */
  private async requireConversation(conversationId: string): Promise<ConversationModel> {
    const conversation = await this.conversations.getWritableById(conversationId);
    if (conversation.status === "ARCHIVED") {
      throw new AppError(
        ErrorCodes.CONVERSATION_ARCHIVED,
        "Conversation is archived, restore it before sending messages",
      );
    }
    return conversation;
  }
}
