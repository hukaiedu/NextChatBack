import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import type { Logger } from "../../common/logger/logger.js";
import type { ModelRequestModel } from "../../generated/prisma/models.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { MessageRepository } from "../message/message.repository.js";
import type { RequestService } from "../request/request.service.js";
import { REQUEST_ACTIVE_STATUSES } from "../request/request.types.js";
import { computeContentUpdate } from "./content-delta.js";
import type { ContentUpdate } from "./content-delta.js";
import type { RequestEventEmitter, RequestNotification } from "./event-emitter.js";

export type SseEventName = "connected" | "delta" | "snapshot" | "status" | "error";

export interface SseFrame {
  event: SseEventName;
  data: Record<string, unknown>;
}

/**
 * SSE 线格式:`event:` 命名事件 + `data:` 单行 JSON,空行结束一帧。
 * JSON 序列化会把换行转义,所以 data 永远单行,不需要多行 data 分支。
 */
export function formatSseFrame(frame: SseFrame): string {
  return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

export interface RequestSseSessionDeps {
  prisma: PrismaClient;
  requests: RequestService;
  messageRepo: MessageRepository;
  events: RequestEventEmitter;
  logger: Logger;
  requestId: string;
  /** 由 controller 注入:写进 HTTP 响应 */
  send: (frame: SseFrame) => void;
  /** 连接结束回调(从服务注册表摘除) */
  onFinished: () => void;
  /** 连接已结束:controller 在此收尾 HTTP 响应,否则长连接会让 server.close() 永远等 */
  onClosed: () => void;
}

const ACTIVE_STATUSES: readonly string[] = REQUEST_ACTIVE_STATUSES;

/**
 * 一个 SSE 连接的状态机(prd 第 6 阶段 §8/§9/§10)。
 *
 * 只读不写:本类**从不**修改 Request / Message,只回读数据库 + 转发事件。
 * 帧序:`connected` → (`snapshot` | `delta`)* → `status`(终态时前置 `error`)→ 关闭。
 *
 * 两条内容通道:
 * - `content` 通知带完整当前文本(内存广播,立即),按**本连接已发前缀**推导 delta,
 *   前缀不成立(Gemini 改了前文)就整段 snapshot 覆盖;
 * - `status` 通知不带数据,一律回读数据库:终态内容以数据库为准,
 *   保证漏收过广播的连接(含断线重连)最终一致。
 */
export class RequestSseSession {
  private closed = false;
  /** 本连接已经发出去的完整文本前缀(delta 推导的基准) */
  private sentContent = "";
  private unsubscribe: (() => void) | null = null;
  /** 串行化异步处理:并发到达的事件不会交错插帧 */
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RequestSseSessionDeps) {}

  /** 订阅事件、发 connected、把初始状态读取排进队列 */
  start(): void {
    if (this.closed) {
      return;
    }
    // 先订阅再读库:两次读之间发生的状态变化不会漏掉
    this.unsubscribe = this.deps.events.subscribe(this.deps.requestId, (notification) =>
      this.onNotification(notification),
    );
    this.emit({ event: "connected", data: { requestId: this.deps.requestId } });
    // connected 就写不出去:连接已被 fail 关闭,别再排队读库(订阅已在 close 里退掉)
    if (this.closed) {
      return;
    }
    this.post(() => this.syncFromDatabase(true));
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.deps.onFinished();
    this.deps.onClosed();
  }

  // ---------------------------------------------------------------------------

  private onNotification(notification: RequestNotification): void {
    if (this.closed) {
      return;
    }
    if (notification.type === "content") {
      // 纯同步推导,不排队也不会与自身乱序
      this.applyContent(notification.content);
      return;
    }
    this.post(() => this.syncFromDatabase());
  }

  private post(task: () => Promise<void>): void {
    this.tail = this.tail.then(task).catch((err) => {
      this.fail(err);
    });
  }

  /** 读数据库 → 补齐内容差异 → 发 error/status → 终态则关闭连接 */
  private async syncFromDatabase(first = false): Promise<void> {
    if (this.closed) {
      return;
    }
    const request = await this.deps.requests.getById(this.deps.requestId);
    const message = await this.deps.messageRepo.findById(this.deps.prisma, request.assistantMessageId);
    const content = message?.content ?? "";
    const status = request.status;
    const terminal = !ACTIVE_STATUSES.includes(status);

    // 首次读取就是「断线重连恢复」:数据库里已有的进度整段快照给出,不重放历史 delta(§10)
    this.applyContent(content, { terminal, fullSnapshot: first });

    if (terminal && (status === "FAILED" || status === "TIMEOUT")) {
      this.emit({
        event: "error",
        data: {
          code: request.errorCode ?? ErrorCodes.INTERNAL_ERROR,
          message: request.errorMessage ?? "Request failed",
        },
      });
    }
    this.emit({
      event: "status",
      data: {
        requestId: request.id,
        // 文档示例用的是消息态(PENDING/STREAMING/COMPLETED/FAILED);Request 态一并给出
        status: message?.status ?? null,
        requestStatus: status,
        errorCode: request.errorCode,
        errorMessage: request.errorMessage,
      },
    });
    if (terminal) {
      this.close();
    }
  }

  /**
   * 让「本连接已发前缀」追上目标文本。
   *
   * 非终态时数据库只是节流后的滞后进度,可能比内存广播落后一段:
   * 那种情况下不回退已发内容(否则前端会看到文本变短);
   * 终态则以数据库为唯一可信来源,必要时整段覆盖。
   */
  private applyContent(
    content: string,
    opts: { terminal?: boolean; fullSnapshot?: boolean } = {},
  ): void {
    if (content === this.sentContent) {
      return;
    }
    const update: ContentUpdate = opts.fullSnapshot
      ? { type: "snapshot", content }
      : computeContentUpdate(this.sentContent, content);
    if (update.type === "snapshot" && !opts.terminal && this.sentContent.startsWith(content)) {
      return;
    }
    if (update.type === "delta" && update.content.length === 0) {
      return;
    }
    this.emit({ event: update.type, data: { type: update.type, content: update.content } });
    this.sentContent = content;
  }

  private emit(frame: SseFrame): void {
    if (this.closed) {
      return;
    }
    try {
      this.deps.send(frame);
    } catch (err) {
      // 客户端断开/写失败只影响这条连接,绝不影响 Gemini 执行(§13)
      this.fail(err);
    }
  }

  private fail(err: unknown): void {
    const code = err instanceof AppError ? err.code : ErrorCodes.SSE_CONNECTION_ERROR;
    this.deps.logger.warn(
      { err, requestId: this.deps.requestId, code },
      "sse connection terminated by error",
    );
    this.close();
  }
}

export interface SseServiceDeps {
  prisma: PrismaClient;
  requests: RequestService;
  messageRepo: MessageRepository;
  events: RequestEventEmitter;
  logger: Logger;
}

/**
 * SSE 连接管理器:登记当前所有连接,供多标签页扇出(§12)与应用关闭时释放(§11)。
 * 没有任何数据库写权限,状态读取一律经 RequestService / MessageRepository。
 */
export class SseService {
  private readonly sessions = new Set<RequestSseSession>();

  constructor(private readonly deps: SseServiceDeps) {}

  /** 写 SSE 头之前先确认 Request 存在:未知 id 抛 REQUEST_NOT_FOUND,由统一错误出口回 404 */
  assertVisible(requestId: string): Promise<ModelRequestModel> {
    return this.deps.requests.getById(requestId);
  }

  open(
    requestId: string,
    send: (frame: SseFrame) => void,
    onClosed: () => void = () => undefined,
  ): RequestSseSession {
    const session = new RequestSseSession({
      prisma: this.deps.prisma,
      requests: this.deps.requests,
      messageRepo: this.deps.messageRepo,
      events: this.deps.events,
      logger: this.deps.logger,
      requestId,
      send,
      onFinished: () => {
        this.sessions.delete(session);
      },
      onClosed,
    });
    this.sessions.add(session);
    return session;
  }

  connectionCount(): number {
    return this.sessions.size;
  }

  /** 应用关闭:主动结束所有长连接,让 server.close() 能走完 */
  closeAll(): void {
    for (const session of [...this.sessions]) {
      session.close();
    }
    this.sessions.clear();
  }
}
