import type { PrismaClient } from "../../generated/prisma/client.js";
import type { ModelRequestModel } from "../../generated/prisma/models.js";
import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import type { DbClient } from "../../database/prisma.js";
import { ConversationRepository } from "../conversation/conversation.repository.js";
import { MessageRepository } from "../message/message.repository.js";
import { RequestRepository } from "./request.repository.js";
import type { RequestStatusValue } from "./request.types.js";

/**
 * Request 状态流转唯一入口(prd §11.4:Request 与 Assistant Message 的状态同步
 * 只允许发生在这里,Adapter / Message Service / Controller 不得自行修改)。
 *
 * 边沿合法性由条件更新兜底:claim 只认 PENDING,complete/fail 只认 PROCESSING,
 * 不满足时 count=0 → 显式抛 INTERNAL_ERROR,绝不静默。
 */
export class RequestService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly requestRepo: RequestRepository,
    private readonly messageRepo: MessageRepository,
    private readonly conversationRepo: ConversationRepository,
  ) {}

  async getById(id: string): Promise<ModelRequestModel> {
    const request = await this.requestRepo.findById(this.prisma, id);
    if (!request) {
      throw new AppError(ErrorCodes.REQUEST_NOT_FOUND, "Request not found", 404);
    }
    return request;
  }

  /**
   * 认领:PENDING → PROCESSING(§11.4 映射 PROCESSING ↔ STREAMING 同步生效)。
   * 单事务完成 Request 与 Assistant Message 两侧状态;不可认领返回 false。
   */
  async claim(id: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const request = await this.requestRepo.findById(tx, id);
      if (!request) {
        return false;
      }
      if ((await this.requestRepo.claim(tx, id)) === 0) {
        return false;
      }
      await this.messageRepo.updateStatus(tx, request.assistantMessageId, "STREAMING");
      return true;
    });
  }

  /** 成功收尾(§12.10):一个事务提交 assistant 内容 + Request SUCCESS + 会话时间戳 */
  async complete(id: string, answer: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const request = await this.requireProcessing(tx, id);
      if ((await this.requestRepo.markSuccess(tx, id)) === 0) {
        throw new AppError(ErrorCodes.INTERNAL_ERROR, "Request left PROCESSING before success", 500);
      }
      await this.messageRepo.updateContentAndStatus(
        tx,
        request.assistantMessageId,
        answer,
        "COMPLETED",
      );
      // §12.10:Conversation.updated_at = now(空 patch 由 repo 刷新时间戳)
      await this.conversationRepo.update(tx, request.conversationId, {});
    });
  }

  /** 失败收尾(§12.11):保留 User Message;status 为 FAILED 或 TIMEOUT(§11.4 两者都映射 assistant FAILED) */
  async fail(
    id: string,
    status: Extract<RequestStatusValue, "FAILED" | "TIMEOUT">,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const request = await this.requireProcessing(tx, id);
      if ((await this.requestRepo.markFailed(tx, id, status, errorCode, errorMessage)) === 0) {
        throw new AppError(ErrorCodes.INTERNAL_ERROR, "Request left PROCESSING before failure", 500);
      }
      await this.messageRepo.updateStatus(tx, request.assistantMessageId, "FAILED");
    });
  }

  /**
   * 启动恢复(§12.1):上一进程遗留的 PROCESSING 一律 PROCESSING → FAILED。
   * 无法确认 Prompt 是否已提交给 Gemini,禁止自动重发;
   * User Message / Assistant Message / Request / providerConversationUrl 全部保留。
   * 行已被别的路径推进时返回 false(幂等,重复执行安全)。
   */
  async recoverProcessingOne(id: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const request = await this.requestRepo.findById(tx, id);
      if (!request || request.status !== "PROCESSING") {
        return false;
      }
      if (
        (await this.requestRepo.markFailed(
          tx,
          id,
          "FAILED",
          ErrorCodes.SERVER_RESTARTED_DURING_PROCESSING,
          "Server restarted while the request was processing; prompt delivery is unconfirmed",
        )) === 0
      ) {
        return false;
      }
      await this.messageRepo.updateStatus(tx, request.assistantMessageId, "FAILED");
      return true;
    });
  }

  private async requireProcessing(db: DbClient, id: string): Promise<ModelRequestModel> {
    const request = await this.requestRepo.findById(db, id);
    if (!request || request.status !== "PROCESSING") {
      throw new AppError(
        ErrorCodes.INTERNAL_ERROR,
        `Request ${id} is not PROCESSING (status: ${request?.status ?? "missing"})`,
        500,
      );
    }
    return request;
  }
}
