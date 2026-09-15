import type { Logger } from "../../common/logger/logger.js";
import { ADMIN_USER_ID, COMPAT_USER_ID } from "../../config/constants.js";
import type { PrismaClient } from "../../generated/prisma/client.js";

const ACTIVE_REQUEST_STATUSES = ["PENDING", "PROCESSING", "CANCELLING"] as const;
const PROTECTED_USER_IDS = [ADMIN_USER_ID, COMPAT_USER_ID] as const;

export interface AnonymousCleanupResult {
  scanned: number;
  deleted: number;
  deferred: number;
}

/** 清理已经失去有效匿名 Session 的匿名用户及其短期历史。 */
export class AnonymousDataCleanupService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
  ) {}

  async cleanupEligible(now = new Date()): Promise<AnonymousCleanupResult> {
    try {
      const candidates = await this.prisma.user.findMany({
        where: {
          type: "ANONYMOUS",
          id: { notIn: [...PROTECTED_USER_IDS] },
        },
        select: { id: true },
      });

      let deleted = 0;
      let deferred = 0;
      for (const candidate of candidates) {
        const result = await this.cleanupUser(candidate.id, now);
        if (result === "deleted") deleted += 1;
        if (result === "deferred") deferred += 1;
      }

      if (deleted > 0 || deferred > 0) {
        this.logger.info(
          { scanned: candidates.length, deleted, deferred },
          "anonymous data cleanup completed",
        );
      }
      return { scanned: candidates.length, deleted, deferred };
    } catch (err) {
      this.logger.error({ err }, "anonymous data cleanup failed");
      return { scanned: 0, deleted: 0, deferred: 0 };
    }
  }

  private async cleanupUser(
    userId: string,
    now: Date,
  ): Promise<"deleted" | "deferred" | "skipped"> {
    return this.prisma.$transaction(async (tx) => {
      const validSession = await tx.session.findFirst({
        where: { userId, expiresAt: { gt: now } },
        select: { id: true },
      });
      if (validSession !== null) return "skipped";

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { type: true, status: true },
      });
      if (
        user === null ||
        user.type !== "ANONYMOUS" ||
        PROTECTED_USER_IDS.includes(userId as (typeof PROTECTED_USER_IDS)[number])
      ) {
        return "skipped";
      }

      // 以 status=DISABLED 作为事务内的删除租约，阻止注册升级和新建会话在删除期间接受该用户。
      const claimed = await tx.user.updateMany({
        where: { id: userId, type: "ANONYMOUS", status: user.status },
        data: { status: "DISABLED" },
      });
      if (claimed.count !== 1) return "skipped";

      const conversations = await tx.conversation.findMany({
        where: { userId },
        select: { id: true },
      });
      const conversationIds = conversations.map(({ id }) => id);
      const activeRequest =
        conversationIds.length === 0
          ? null
          : await tx.modelRequest.findFirst({
              where: {
                conversationId: { in: conversationIds },
                status: { in: [...ACTIVE_REQUEST_STATUSES] },
              },
              select: { id: true },
            });
      if (activeRequest !== null) {
        await tx.user.updateMany({
          where: { id: userId, type: "ANONYMOUS", status: "DISABLED" },
          data: { status: user.status },
        });
        return "deferred";
      }

      if (conversationIds.length > 0) {
        // Foreign keys are restrictive, so dependents must be removed first.
        await tx.modelRequest.deleteMany({ where: { conversationId: { in: conversationIds } } });
        await tx.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
        await tx.conversation.deleteMany({
          where: { id: { in: conversationIds }, userId },
        });
      }

      const deletedUser = await tx.user.deleteMany({
        where: {
          id: userId,
          type: "ANONYMOUS",
          status: "DISABLED",
        },
      });
      return deletedUser.count === 1 ? "deleted" : "skipped";
    });
  }
}
