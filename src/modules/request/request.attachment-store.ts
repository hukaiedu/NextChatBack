import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import type { Logger } from "../../common/logger/logger.js";
import {
  ATTACHMENT_ORPHAN_SWEEP_MS,
  ATTACHMENT_RESERVED_GRACE_MS,
  ATTACHMENT_STORE_MAX_BYTES,
} from "../../config/constants.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { AttachmentFile } from "../message/attachment.js";
import type { RequestRepository } from "./request.repository.js";

/**
 * 附件字节的进程内容器(I0.1 §3、§6)。
 *
 * 图片字节**只在内存里活一次**:HTTP 请求解析出来 → 交给 Scheduler → Provider 注入完即删。
 * 数据库只记 `attachmentCount`(份数),字节永不落库,所以进程重启 = 附件永久丢失(§13)。
 *
 * 状态机:`reserve()` RESERVED →`attach()`→ READY →`take()`→ IN_USE →`drop()`→ 删除。
 * 唯一不变量:`liveBytes === Σ 所有 slot.byteSize`,任何时刻、任何方法返回后都必须成立。
 * 计量因此只有两个入口 —— reserve 加、drop 减;attach/take 只改状态,绝不重复计量。
 */
export type AttachmentSlotState = "RESERVED" | "READY" | "IN_USE";

export interface AttachmentStoreStats {
  slotCount: number;
  liveBytes: number;
  slots: Array<{ requestId: string; state: AttachmentSlotState; byteSize: number }>;
}

export interface AttachmentClock {
  /** unix 毫秒;测试注入固定时钟 */
  now(): number;
}

export interface AttachmentStoreDeps {
  prisma: PrismaClient;
  requestRepo: RequestRepository;
  logger: Logger;
  clock?: AttachmentClock;
  sweepIntervalMs?: number;
  maxBytes?: number;
}

interface AttachmentSlot {
  state: AttachmentSlotState;
  files: AttachmentFile[];
  byteSize: number;
  reservedAt: number;
}

export class AttachmentStore {
  private readonly slots = new Map<string, AttachmentSlot>();
  private readonly prisma: PrismaClient;
  private readonly requestRepo: RequestRepository;
  private readonly logger: Logger;
  private readonly clock: AttachmentClock;
  private readonly maxBytes: number;
  private liveBytes = 0;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(deps: AttachmentStoreDeps) {
    this.prisma = deps.prisma;
    this.requestRepo = deps.requestRepo;
    this.logger = deps.logger;
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.maxBytes = deps.maxBytes ?? ATTACHMENT_STORE_MAX_BYTES;
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, deps.sweepIntervalMs ?? ATTACHMENT_ORPHAN_SWEEP_MS);
    this.sweepTimer.unref();
  }

  /**
   * 占位:校验 requestId 与容量后创建 RESERVED slot 并计入 liveBytes。
   *
   * 两条拒绝路径(requestId 已存在 / 容量不足)都发生在**任何写入之前**,
   * 所以抛错后 slot 数与 liveBytes 与调用前逐字节相同。
   * 容量不足绝不淘汰既有附件 —— 入口拒绝(503),而不是把别人排队中的图丢掉。
   */
  reserve(requestId: string, files: AttachmentFile[]): void {
    if (this.slots.has(requestId)) {
      throw new AppError(
        ErrorCodes.INTERNAL_ERROR,
        `attachment slot for ${requestId} already exists`,
      );
    }
    const byteSize = files.reduce((sum, file) => sum + file.buffer.length, 0);
    if (this.liveBytes + byteSize > this.maxBytes) {
      throw new AppError(
        ErrorCodes.ATTACHMENT_CAPACITY_EXCEEDED,
        "Attachment capacity exceeded, retry later",
      );
    }
    this.slots.set(requestId, {
      state: "RESERVED",
      files,
      byteSize,
      reservedAt: this.clock.now(),
    });
    this.liveBytes += byteSize;
  }

  /** 事务提交后确认占位:RESERVED → READY。字节早在 reserve 时计过,这里不再增加。 */
  attach(requestId: string): boolean {
    const slot = this.slots.get(requestId);
    if (slot === undefined || slot.state !== "RESERVED") {
      return false;
    }
    slot.state = "READY";
    return true;
  }

  /** Scheduler 认领后取件:READY → IN_USE。只改状态,slot 与字节留给执行结束的 drop。 */
  take(requestId: string): AttachmentFile[] | undefined {
    const slot = this.slots.get(requestId);
    if (slot === undefined || slot.state !== "READY") {
      return undefined;
    }
    slot.state = "IN_USE";
    return slot.files;
  }

  /** 释放:删 slot 并扣回字节。不存在即 no-op,因此可以无条件放进 finally。 */
  drop(requestId: string): void {
    const slot = this.slots.get(requestId);
    if (slot === undefined) {
      return;
    }
    this.slots.delete(requestId);
    this.liveBytes -= slot.byteSize;
  }

  /**
   * 孤儿清理。判据是**数据库里的 Request 状态**,不是固定 TTL:
   * 附件只要还挂在 PENDING / PROCESSING / CANCELLING 上就永远有效,
   * 慢队列(前面排着长任务)不是把它丢掉的借口。
   *
   * - IN_USE:不扫。释放权只属于执行链的 finally, sweep 抢先删会让 finally 无从判断。
   * - RESERVED 且未过宽限期:不动。reserve 与事务提交在同一条链路里,DB 行可能尚未落定。
   * - 其余候选:DB 仍活动则保留;已不活动(终态/行不存在)说明再无人认领 → drop。
   */
  async sweep(): Promise<number> {
    const now = this.clock.now();
    const candidates: string[] = [];
    for (const [requestId, slot] of this.slots) {
      if (slot.state === "IN_USE") {
        continue;
      }
      if (
        slot.state === "RESERVED" &&
        now - slot.reservedAt < ATTACHMENT_RESERVED_GRACE_MS
      ) {
        continue;
      }
      candidates.push(requestId);
    }
    if (candidates.length === 0) {
      return 0;
    }

    let active: Set<string>;
    try {
      active = await this.requestRepo.findActiveByIds(this.prisma, candidates);
    } catch (err) {
      this.logger.error({ err }, "attachment sweep skipped: request lookup failed");
      return 0;
    }

    let removed = 0;
    for (const requestId of candidates) {
      if (active.has(requestId) || !this.slots.has(requestId)) {
        continue;
      }
      this.drop(requestId);
      removed++;
    }
    if (removed > 0) {
      this.logger.info(
        { removed, candidates: candidates.length, liveBytes: this.liveBytes },
        "attachment sweep removed orphan slots",
      );
    }
    return removed;
  }

  stats(): AttachmentStoreStats {
    const slots: AttachmentStoreStats["slots"] = [];
    for (const [requestId, slot] of this.slots) {
      slots.push({ requestId, state: slot.state, byteSize: slot.byteSize });
    }
    return { slotCount: this.slots.size, liveBytes: this.liveBytes, slots };
  }

  /** 停机:撤掉定时器并释放全部字节(进程本就要带走它们)。 */
  dispose(): void {
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    for (const requestId of [...this.slots.keys()]) {
      this.drop(requestId);
    }
  }
}
