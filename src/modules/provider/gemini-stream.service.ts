import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import type { Logger } from "../../common/logger/logger.js";
import type { MessageService } from "../message/message.service.js";
import type { RequestEventEmitter } from "../sse/event-emitter.js";

/** 一次执行独占的流式写入器(每 Request 一个,不跨执行复用) */
export interface StreamingWriter {
  /** Adapter 每读到一次新文本调用一次:立即广播,按节流间隔落库 */
  push(text: string): Promise<void>;
  /** 执行结束时把内存里最后一段未落库的文本补写进去 */
  flush(): Promise<void>;
}

export interface GeminiStreamServiceDeps {
  messageService: MessageService;
  events: RequestEventEmitter;
  logger: Logger;
  options?: { updateIntervalMs?: number };
}

/**
 * 流式回答的业务层接缝(第 6 阶段 §4/§7):
 *
 * ```text
 * GeminiAdapter(onText) → 本服务 → 数据库(Assistant Message,节流)
 *                                ↘ 进程内事件总线(SSE,立即)
 * ```
 *
 * 两条出口的节奏刻意不同:数据库是**最终状态来源**,只需要每 `updateIntervalMs`
 * 留下一份可恢复的进度;事件总线是**传输加速**,每次文本变化都立刻广播。
 * 断线重连与终态判定一律回读数据库,所以丢一次广播不影响正确性。
 *
 * 本服务绝不改状态:Assistant Message 的状态由 RequestService 独占(§11.4),
 * 这里只写 content,且写不进(已离开 STREAMING)就当失败报出去。
 */
export class GeminiStreamService {
  private readonly updateIntervalMs: number;

  constructor(private readonly deps: GeminiStreamServiceDeps) {
    this.updateIntervalMs = deps.options?.updateIntervalMs ?? 300;
  }

  open(requestId: string, assistantMessageId: string): StreamingWriter {
    return new ExecutionStream(this.deps, this.updateIntervalMs, requestId, assistantMessageId);
  }
}

class ExecutionStream implements StreamingWriter {
  /** 最近一次广播过的完整文本(用于去重连续相同的读取) */
  private published: string | null = null;
  /** 已广播但还没落库的文本(节流期间的内存进度) */
  private pending: string | null = null;
  private lastUpdateAt = 0;

  constructor(
    private readonly deps: GeminiStreamServiceDeps,
    private readonly updateIntervalMs: number,
    private readonly requestId: string,
    private readonly assistantMessageId: string,
  ) {}

  async push(text: string): Promise<void> {
    if (text === this.published) {
      return;
    }
    this.published = text;
    this.deps.events.publishContent(this.requestId, text);

    if (Date.now() - this.lastUpdateAt >= this.updateIntervalMs) {
      await this.persist(text);
      return;
    }
    this.pending = text;
  }

  /**
   * 收尾补写。此时完整回答已在手上,紧接着的 `RequestService.complete()`
   * 会把最终内容一次性写定,所以补写失败只降级为日志,不该把已成功的执行判失败。
   */
  async flush(): Promise<void> {
    const pending = this.pending;
    if (pending === null) {
      return;
    }
    this.pending = null;
    try {
      await this.persist(pending);
    } catch (err) {
      this.deps.logger.warn(
        { err, requestId: this.requestId, contentLength: pending.length },
        "streaming tail flush failed; final answer is persisted by RequestService.complete",
      );
    }
  }

  private async persist(text: string): Promise<void> {
    this.pending = null;
    this.lastUpdateAt = Date.now();
    let persisted: boolean;
    try {
      persisted = await this.deps.messageService.saveStreamingContent(this.assistantMessageId, text);
    } catch (err) {
      this.deps.logger.error(
        { err, requestId: this.requestId, contentLength: text.length },
        "streaming content update failed",
      );
      throw new AppError(
        ErrorCodes.STREAMING_UPDATE_FAILED,
        "Assistant message streaming content update failed",
        err,
      );
    }
    if (!persisted) {
      // Assistant 已离开 STREAMING(watchdog 收尾 / 启动恢复改走):继续推没有意义
      throw new AppError(
        ErrorCodes.STREAMING_UPDATE_FAILED,
        "Assistant message is no longer STREAMING; streaming stopped",
      );
    }
  }
}
