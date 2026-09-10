import type { ModelRequestModel } from "../../generated/prisma/models.js";
import { ATTACHMENT_SWEEP_CHUNK_SIZE } from "../../config/constants.js";
import type { DbClient } from "../../database/prisma.js";
import { REQUEST_ACTIVE_STATUSES, REQUEST_IN_FLIGHT_STATUSES } from "./request.types.js";

export interface ModelRequestCreateData {
  /** 缺省 = 用 schema 的 @default(uuid());附件请求必须显式传入,与 AttachmentStore 的占位 id 对齐 */
  id?: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  status: string;
  provider: string;
  /** M1:客户端显式提交的模型键快照;未提交为 null,创建后不再变更 */
  requestedModelKey?: string | null;
  /** V1.2 I1:附件份数(字节只在内存,永不落库);缺省 = 数据库默认 0 */
  attachmentCount?: number;
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

  /** PAG-2:Message 分页 Request 摘要 —— 只按页内 assistantMessageId 查,空入参不发 IN [] */
  async findByAssistantIds(db: DbClient, ids: string[]): Promise<ModelRequestModel[]> {
    if (ids.length === 0) {
      return [];
    }
    return db.modelRequest.findMany({ where: { assistantMessageId: { in: ids } } });
  }

  /**
   * §六 附件孤儿判据:候选 requestId 里哪些仍处于活动态(PENDING / PROCESSING / CANCELLING)。
   *
   * AttachmentStore 因此不按固定 TTL 删附件 —— 只要数据库还说这个 Request 没跑完,
   * 内存里的字节就必须留着。分片查询避开 SQLite 的 IN 参数上限。
   */
  async findActiveByIds(db: DbClient, ids: string[]): Promise<Set<string>> {
    const active = new Set<string>();
    for (let offset = 0; offset < ids.length; offset += ATTACHMENT_SWEEP_CHUNK_SIZE) {
      const chunk = ids.slice(offset, offset + ATTACHMENT_SWEEP_CHUNK_SIZE);
      const rows = await db.modelRequest.findMany({
        where: { id: { in: chunk }, status: { in: [...REQUEST_ACTIVE_STATUSES] } },
        select: { id: true },
      });
      for (const row of rows) {
        active.add(row.id);
      }
    }
    return active;
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

  /**
   * V1.2 §十三 启动恢复扫描:上一进程遗留的「带附件 PENDING」。
   *
   * 纯文本 PENDING 不在其中 —— 它不依赖内存,重启后照旧由 Scheduler 首轮扫描接走(硬回归条件)。
   */
  async findStalePendingWithAttachments(db: DbClient): Promise<ModelRequestModel[]> {
    return db.modelRequest.findMany({
      where: { status: "PENDING", attachmentCount: { gt: 0 } },
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
   * V1.2 §十三:启动恢复专用的 PENDING → FAILED 条件写。
   *
   * 刻意不与 markFailed 合并:后者只认 PROCESSING|CANCELLING(§12.11「执行中才会失败」),
   * 把 PENDING 并进去等于放弃这条边沿合法性。本方法只由启动恢复调用一次。
   */
  async markFailedFromPending(
    db: DbClient,
    id: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<number> {
    const result = await db.modelRequest.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "FAILED", errorCode, errorMessage, completedAt: new Date() },
    });
    return result.count;
  }

  /**
   * M3:resolved 落库(ensureModel 成功后、发送 Prompt 前)。
   * 条件写接受 PROCESSING|CANCELLING:切换成功瞬间用户可能已点停止(§8.9),
   * 此时 resolved 同样要保留;返回 0 表示行已离开在飞,调用方必须阻止发送 Prompt。
   */
  async markResolved(
    db: DbClient,
    id: string,
    resolvedModelKey: string,
    resolvedModelLabel: string,
  ): Promise<number> {
    const result = await db.modelRequest.updateMany({
      where: { id, status: { in: [...REQUEST_IN_FLIGHT_STATUSES] } },
      data: { resolvedModelKey, resolvedModelLabel },
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
