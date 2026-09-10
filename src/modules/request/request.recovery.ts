import type { Logger } from "../../common/logger/logger.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { findPairingViolations } from "./request.consistency.js";
import type { RequestRepository } from "./request.repository.js";
import type { RequestService } from "./request.service.js";

export interface RequestRecoveryDeps {
  prisma: PrismaClient;
  requestRepo: RequestRepository;
  requestService: RequestService;
  logger: Logger;
}

export interface RecoveryReport {
  /** 本次由 PROCESSING 强制转 FAILED 的条数 */
  processingFailed: number;
  /** 本次由 CANCELLING 强制转 FAILED 的条数 */
  cancellingFailed: number;
  /** V1.2 §十三:本次由「带附件的 PENDING」强制转 FAILED 的条数(附件字节已随上一进程丢失) */
  pendingAttachmentFailed: number;
  /** §六 配对违规数(只发现不修复) */
  pairingViolations: number;
}

/**
 * 服务启动时的 Request 恢复(prd §12.1),必须先于 Scheduler 启动完成。
 *
 * - 纯文本 PENDING:不动。Scheduler 首轮扫描自然重新入队。
 * - 带附件的 PENDING:FAILED + SERVER_RESTARTED_DURING_PROCESSING(V1.2 §十三)。
 *   附件字节只活在内存,新进程拿不到;放过去执行就是一条「只有文字」的降级请求。
 * - PROCESSING:FAILED + SERVER_RESTARTED_DURING_PROCESSING。
 * - CANCELLING:FAILED + SERVER_RESTARTED_DURING_CANCELLING(§8.9 残留 CANCELLING 是真 bug)。
 * - Assistant 一律 → FAILED(不落 CANCELLED,否则违反 §六)。
 *
 * 末尾跑一次 §六 配对检查,只记 error 不修复(修复会销毁证据)。
 */
export class RequestRecovery {
  constructor(private readonly deps: RequestRecoveryDeps) {}

  async run(): Promise<RecoveryReport> {
    // 两组残留各自按老到新取出;带附件的 PENDING 不依赖数据库外的状态,必须在
    // Scheduler 首次扫描之前判死,否则它会被当成普通 PENDING 认领。
    const stale = [
      ...(await this.deps.requestRepo.findStaleInFlight(this.deps.prisma)),
      ...(await this.deps.requestRepo.findStalePendingWithAttachments(this.deps.prisma)),
    ];
    let processingFailed = 0;
    let cancellingFailed = 0;
    let pendingAttachmentFailed = 0;
    for (const request of stale) {
      try {
        if (await this.deps.requestService.recoverStaleOne(request.id)) {
          if (request.status === "CANCELLING") {
            cancellingFailed++;
          } else if (request.status === "PENDING") {
            pendingAttachmentFailed++;
          } else {
            processingFailed++;
          }
        }
      } catch (err) {
        this.deps.logger.error(
          { err, requestId: request.id, conversationId: request.conversationId },
          "request recovery failed for one row",
        );
      }
    }
    if (stale.length > 0) {
      this.deps.logger.info(
        {
          processingFailed,
          cancellingFailed,
          pendingAttachmentFailed,
          scanned: stale.length,
        },
        "request recovery finished",
      );
    }

    // §六 配对检查:只发现不修复
    let pairingViolations = 0;
    try {
      const violations = await findPairingViolations(this.deps.prisma);
      pairingViolations = violations.length;
      for (const v of violations) {
        this.deps.logger.error(
          {
            requestId: v.requestId,
            requestStatus: v.requestStatus,
            assistantMessageId: v.assistantMessageId,
            assistantStatus: v.assistantStatus,
          },
          "request-assistant pairing violation detected",
        );
      }
    } catch (err) {
      this.deps.logger.error({ err }, "pairing violation check failed");
    }

    return { processingFailed, cancellingFailed, pendingAttachmentFailed, pairingViolations };
  }
}
