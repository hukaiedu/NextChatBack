import type { ModelRequestModel } from "../../generated/prisma/models.js";
import type { DbClient } from "../../database/prisma.js";
import { REQUEST_ACTIVE_STATUSES, REQUEST_IN_FLIGHT_STATUSES } from "./request.types.js";

export interface ModelRequestCreateData {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  status: string;
  provider: string;
}

export class RequestRepository {
  async create(db: DbClient, data: ModelRequestCreateData): Promise<ModelRequestModel> {
    return db.modelRequest.create({ data });
  }

  async findById(db: DbClient, id: string): Promise<ModelRequestModel | null> {
    return db.modelRequest.findUnique({ where: { id } });
  }

  async findByIdempotencyKey(db: DbClient, key: string): Promise<ModelRequestModel | null> {
    return db.modelRequest.findUnique({ where: { idempotencyKey: key } });
  }

  async hasActive(db: DbClient, conversationId: string): Promise<boolean> {
    const found = await db.modelRequest.findFirst({
      where: {
        conversationId,
        status: { in: [...REQUEST_ACTIVE_STATUSES] },
      },
      select: { id: true },
    });
    return found !== null;
  }

  async listByConversation(db: DbClient, conversationId: string): Promise<ModelRequestModel[]> {
    return db.modelRequest.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });
  }

  /** 最老的 PENDING(Scheduler 取任务;id 兜底同毫秒稳定排序) */
  async findFirstPending(db: DbClient): Promise<ModelRequestModel | null> {
    return db.modelRequest.findFirst({
      where: { status: "PENDING" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  /** §12.1 启动恢复扫描:上一进程遗留的全部 PROCESSING|CANCELLING(老到新,顺序稳定) */
  async findStaleInFlight(db: DbClient): Promise<ModelRequestModel[]> {
    return db.modelRequest.findMany({
      where: { status: { in: [...REQUEST_IN_FLIGHT_STATUSES] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  /** 认领:PENDING → PROCESSING,返回 0 表示已被别的路径动过 */
  async claim(db: DbClient, id: string): Promise<number> {
    const result = await db.modelRequest.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "PROCESSING", startedAt: new Date(), attemptCount: { increment: 1 } },
    });
    return result.count;
  }

  /** 成功收尾:PROCESSING|CANCELLING → SUCCESS(§12.10 成功事务的 Request 侧) */
  async markSuccess(db: DbClient, id: string): Promise<number> {
    const result = await db.modelRequest.updateMany({
      where: { id, status: { in: [...REQUEST_IN_FLIGHT_STATUSES] } },
      data: { status: "SUCCESS", completedAt: new Date() },
    });
    return result.count;
  }

  /** 失败收尾:PROCESSING|CANCELLING → FAILED / TIMEOUT(§12.11、§11.1) */
  async markFailed(
    db: DbClient,
    id: string,
    status: "FAILED" | "TIMEOUT",
    errorCode: string,
    errorMessage: string,
  ): Promise<number> {
    const result = await db.modelRequest.updateMany({
      where: { id, status: { in: [...REQUEST_IN_FLIGHT_STATUSES] } },
      data: { status, errorCode, errorMessage, completedAt: new Date() },
    });
    return result.count;
  }

  /**
   * 受理取消:PROCESSING → CANCELLING(prd §8.9)。
   *
   * 只动 Request 一侧 —— §11.4 规定 CANCELLING ↔ STREAMING,assistant 保持 STREAMING,
   * 这样 Gemini 停止前已生成的尾部内容还能继续流式落库。
   */
  async markCancelling(db: DbClient, id: string): Promise<number> {
    const result = await db.modelRequest.updateMany({
      where: { id, status: "PROCESSING" },
      data: { status: "CANCELLING" },
    });
    return result.count;
  }

  /**
   * 取消落地:→ CANCELLED。一条原语覆盖 §8.9 的两个入口 ——
   * PENDING(尚未交给 Gemini,直接取消)与 CANCELLING(已确认真正停止)。
   */
  async markCancelled(db: DbClient, id: string): Promise<number> {
    const result = await db.modelRequest.updateMany({
      where: { id, status: { in: ["PENDING", "CANCELLING"] } },
      data: { status: "CANCELLED", completedAt: new Date() },
    });
    return result.count;
  }
}
