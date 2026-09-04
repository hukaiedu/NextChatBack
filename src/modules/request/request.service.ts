import type { PrismaClient } from "../../generated/prisma/client.js";
import type { ModelRequestModel } from "../../generated/prisma/models.js";
import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import type { DbClient } from "../../database/prisma.js";
import { ConversationRepository } from "../conversation/conversation.repository.js";
import { MessageRepository } from "../message/message.repository.js";
import { RequestRepository } from "./request.repository.js";
import type { RequestStatusValue } from "./request.types.js";
import { REQUEST_IN_FLIGHT_STATUSES } from "./request.types.js";
import { expectedAssistantStatus } from "./request.consistency.js";
import type { CancellationRegistry } from "./request.cancellation.js";

/**
 * 状态变化通知出口(第 6 阶段给 SSE 用)。
 *
 * 单向、不带数据:实现方(进程内事件总线)只被告知「这条 Request 状态可能变了」,
 * 一切状态仍以数据库为准,SSE 收到通知后回读。RequestService 不接收任何反向调用。
 */
export interface RequestStatusEvents {
  publishStatus(requestId: string): void;
}

/**
 * cancel() 的三种结果,controller 据此决定 HTTP status。
 *
 * - cancelled: PENDING → CANCELLED,直接落终态,200
 * - cancelling: PROCESSING → CANCELLING,已受理但终态稍后经 SSE 到达,202
 * - noop: 已是 CANCELLING/CANCELLED,幂等重放(双击停止是正常用户行为),200
 */
export type CancelOutcome =
  | { kind: "cancelled"; request: ModelRequestModel }
  | { kind: "cancelling"; request: ModelRequestModel }
  | { kind: "noop"; request: ModelRequestModel };

/**
 * Request 状态流转唯一入口(prd §11.4:Request 与 Assistant Message 的状态同步
 * 只允许发生在这里,Adapter / Message Service / Controller 不得自行修改)。
 *
 * 边沿合法性由条件更新兜底:claim 只认 PENDING,complete/fail 只认 PROCESSING|CANCELLING,
 * cancel 只认 PROCESSING/PENDING/CANCELLING;不满足时 count=0 → 显式抛 INTERNAL_ERROR 或
 * 按新状态如实分派,绝不静默。
 */
export class RequestService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly requestRepo: RequestRepository,
    private readonly messageRepo: MessageRepository,
    private readonly conversationRepo: ConversationRepository,
    private readonly events?: RequestStatusEvents,
    private readonly cancellation?: CancellationRegistry,
  ) {}

  async getById(id: string): Promise<ModelRequestModel> {
    const request = await this.requestRepo.findById(this.prisma, id);
    if (!request) {
      throw new AppError(ErrorCodes.REQUEST_NOT_FOUND, "Request not found");
    }
    return request;
  }

  /**
   * 认领:PENDING → PROCESSING(§11.4 映射 PROCESSING ↔ STREAMING 同步生效)。
   * 单事务完成 Request 与 Assistant Message 两侧状态;不可认领返回 false。
   */
  async claim(id: string): Promise<boolean> {
    const claimed = await this.prisma.$transaction(async (tx) => {
      const request = await this.requestRepo.findById(tx, id);
      if (!request) {
        return false;
      }
      if ((await this.requestRepo.claim(tx, id)) === 0) {
        return false;
      }
      await this.messageRepo.updateStatus(
        tx,
        request.assistantMessageId,
        expectedAssistantStatus("PROCESSING"),
      );
      return true;
    });
    if (claimed) {
      this.events?.publishStatus(id);
    }
    return claimed;
  }

  /** 成功收尾(§12.10):一个事务提交 assistant 内容 + Request SUCCESS + 会话时间戳 */
  async complete(id: string, answer: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const request = await this.requireInFlight(tx, id);
      if ((await this.requestRepo.markSuccess(tx, id)) === 0) {
        throw new AppError(ErrorCodes.INTERNAL_ERROR, "Request left in-flight before success");
      }
      await this.messageRepo.updateContentAndStatus(
        tx,
        request.assistantMessageId,
        answer,
        expectedAssistantStatus("SUCCESS"),
      );
      // §12.10:Conversation.updated_at = now(空 patch 由 repo 刷新时间戳)
      await this.conversationRepo.update(tx, request.conversationId, {});
    });
    this.events?.publishStatus(id);
  }

  /** 失败收尾(§12.11):保留 User Message;status 为 FAILED 或 TIMEOUT(§11.4 两者都映 assistant FAILED) */
  async fail(
    id: string,
    status: Extract<RequestStatusValue, "FAILED" | "TIMEOUT">,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const request = await this.requireInFlight(tx, id);
      if ((await this.requestRepo.markFailed(tx, id, status, errorCode, errorMessage)) === 0) {
        throw new AppError(ErrorCodes.INTERNAL_ERROR, "Request left in-flight before failure");
      }
      await this.messageRepo.updateStatus(
        tx,
        request.assistantMessageId,
        expectedAssistantStatus(status),
      );
    });
    this.events?.publishStatus(id);
  }

  /**
   * 受理取消(prd §8.9)。
   *
   * 最多两轮:第一轮的条件写可能撞上 Scheduler 认领或执行收尾(count=0),
   * 重读一次按新状态如实分派,不做无界重试(原则 30)。
   *
   * 终态一律由数据库条件写决定,registry.abort 只是尽力把 signal 送到 ——
   * 即使 abort 返回 false(PENDING 尚未认领),markCancelled 仍会把行推到 CANCELLED。
   */
  async cancel(id: string): Promise<CancelOutcome> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await this.requestRepo.findById(this.prisma, id);
      if (!current) {
        throw new AppError(ErrorCodes.REQUEST_NOT_FOUND, "Request not found");
      }

      if (current.status === "PENDING") {
        const n = await this.prisma.$transaction(async (tx) => {
          if ((await this.requestRepo.markCancelled(tx, id)) === 0) {
            return 0;
          }
          const req = await this.requestRepo.findById(tx, id);
          if (!req) {
            return 0;
          }
          await this.messageRepo.updateStatus(
            tx,
            req.assistantMessageId,
            expectedAssistantStatus("CANCELLED"),
          );
          return 1;
        });
        if (n > 0) {
          this.events?.publishStatus(id);
          return { kind: "cancelled", request: await this.getById(id) };
        }
        continue;
      }

      if (current.status === "PROCESSING") {
        const n = await this.prisma.$transaction(async (tx) => {
          if ((await this.requestRepo.markCancelling(tx, id)) === 0) {
            return 0;
          }
          return 1;
        });
        if (n > 0) {
          this.cancellation?.abort(id);
          this.events?.publishStatus(id);
          return { kind: "cancelling", request: await this.getById(id) };
        }
        continue;
      }

      return this.settledOutcome(current);
    }
    return this.settledOutcome(await this.getById(id));
  }

  /**
   * 取消落地:CANCELLING → CANCELLED(§8.9「确认真正停止」之后)。
   * 与 complete 对称:同事务写 markCancelled + assistant 内容与状态 + 会话时间戳。
   */
  async cancelled(id: string, partialAnswer: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const request = await this.requireInFlight(tx, id);
      if ((await this.requestRepo.markCancelled(tx, id)) === 0) {
        throw new AppError(ErrorCodes.INTERNAL_ERROR, "Request left in-flight before cancel");
      }
      await this.messageRepo.updateContentAndStatus(
        tx,
        request.assistantMessageId,
        partialAnswer,
        expectedAssistantStatus("CANCELLED"),
      );
      await this.conversationRepo.update(tx, request.conversationId, {});
    });
    this.events?.publishStatus(id);
  }

  /**
   * 启动恢复(§12.1):上一进程遗留的 PROCESSING|CANCELLING 一律 → FAILED。
   * 按行状态选错误码:PROCESSING → SERVER_RESTARTED_DURING_PROCESSING,
   * CANCELLING → SERVER_RESTARTED_DURING_CANCELLING。
   * Assistant 一律 → FAILED(不落 CANCELLED,否则会出现 Request FAILED + Assistant CANCELLED)。
   * 行已被别的路径推进时返回 false(幂等,重复执行安全)。
   */
  async recoverStaleOne(id: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const request = await this.requestRepo.findById(tx, id);
      if (!request) {
        return false;
      }
      const errorCode =
        request.status === "CANCELLING"
          ? ErrorCodes.SERVER_RESTARTED_DURING_CANCELLING
          : request.status === "PROCESSING"
            ? ErrorCodes.SERVER_RESTARTED_DURING_PROCESSING
            : null;
      if (!errorCode) {
        return false;
      }
      if (
        (await this.requestRepo.markFailed(
          tx,
          id,
          "FAILED",
          errorCode,
          `Server restarted while the request was ${request.status.toLowerCase()}; prompt delivery is unconfirmed`,
        )) === 0
      ) {
        return false;
      }
      await this.messageRepo.updateStatus(
        tx,
        request.assistantMessageId,
        expectedAssistantStatus("FAILED"),
      );
      return true;
    });
  }

  /** @deprecated 使用 recoverStaleOne */
  async recoverProcessingOne(id: string): Promise<boolean> {
    return this.recoverStaleOne(id);
  }

  private settledOutcome(request: ModelRequestModel): CancelOutcome {
    if (request.status === "CANCELLING" || request.status === "CANCELLED") {
      return { kind: "noop", request };
    }
    throw new AppError(
      ErrorCodes.REQUEST_NOT_CANCELLABLE,
      `Request ${request.id} is already ${request.status} and cannot be cancelled`,
    );
  }

  /**
   * 在飞守卫:complete/fail/cancelled 共用。
   * 接受 PROCESSING|CANCELLING —— §11.1 允许 CANCELLING → SUCCESS/FAILED 竞态边。
   */
  private async requireInFlight(db: DbClient, id: string): Promise<ModelRequestModel> {
    const request = await this.requestRepo.findById(db, id);
    const inFlight: readonly string[] = REQUEST_IN_FLIGHT_STATUSES;
    if (!request || !inFlight.includes(request.status)) {
      throw new AppError(
        ErrorCodes.INTERNAL_ERROR,
        `Request ${id} is not in-flight (status: ${request?.status ?? "missing"})`,
      );
    }
    return request;
  }
}
