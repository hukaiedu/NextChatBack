import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import type { Logger } from "../../common/logger/logger.js";
import { USER_MAX_ACTIVE_REQUESTS } from "../../config/constants.js";
import type { BrowserProviderStatus } from "../../providers/gemini/browser-driver.js";
import type { BrowserManager } from "../../providers/gemini/browser-manager.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { MessageModel, ModelRequestModel } from "../../generated/prisma/models.js";
import type { MessageRepository } from "../message/message.repository.js";
import type { AttachmentFile } from "../message/attachment.js";
import type { AttachmentStore } from "./request.attachment-store.js";
import type {
  PromptExecutionInput,
  PromptExecutionResult,
  PromptExecutor,
} from "../provider/gemini-prompt.service.js";
import type { RequestRepository } from "./request.repository.js";
import type { RequestService } from "./request.service.js";
import type { CancellationRegistry } from "./request.cancellation.js";
import { isContextClosedError } from "../../providers/gemini/gemini.errors.js";
import type { ProviderPageLock } from "../../providers/gemini/provider-page-lock.js";

const DEFAULT_SCAN_INTERVAL_MS = 1_000;
/**
 * 执行 watchdog 默认 10 分钟:高于 Adapter 自己的 5 分钟回答上限,
 * 因此正常 Provider 故障都由 Adapter 先报;watchdog 只兜「执行器挂死,连超时都不返回」这一类。
 */
const DEFAULT_EXECUTION_TIMEOUT_MS = 600_000;
/**
 * watchdog 触发后给 stopGeneration 的宽限期(ms)。
 * 必须 > STOP_CONFIRM_TIMEOUT_MS(10s),让「点停止 + 确认」有机会跑完。
 */
const ABANDON_GRACE_MS = 15_000;
/** confirmIdle 超时(ms):页面僵死时不能让 releaseSlot 永久挂住 */
const CONFIRM_IDLE_TIMEOUT_MS = 5_000;
/**
 * 关闭族异常分类的事件收敛窗口(ms):close/crash 事件是异步的,执行异常可能先到
 * (§8.8,长稳实测事件在异常后 ~27ms 落地)。仅「关闭族」原始异常才等待,
 * 正常失败路径零延迟。
 */
const SETTLE_CLOSE_EVENTS_MS = 250;

export interface RequestSchedulerDeps {
  prisma: PrismaClient;
  requestRepo: RequestRepository;
  messageRepo: MessageRepository;
  requestService: RequestService;
  executor: PromptExecutor;
  browserManager: BrowserManager;
  logger: Logger;
  cancellation: CancellationRegistry;
  pageLock: ProviderPageLock;
  /** V1.2 I1:附件内存容器;claim 后取件、执行结束在同一条 finally 释放 */
  attachmentStore: AttachmentStore;
  options?: {
    scanIntervalMs?: number;
    executionTimeoutMs?: number;
    /** P7 §57 + FIX-01A:单用户在飞上限,按数据库 PROCESSING/CANCELLING 条数强制;单 worker 下不提高并行度 */
    userMaxActiveRequests?: number;
  };
}

/**
 * 单进程内存 Scheduler(prd 第 5 阶段;§12.1 内存队列重启即失,PENDING 靠启动扫描自然恢复)。
 *
 * - 只认领 PENDING,单飞串行:同一时刻最多一个 Gemini Request
 * - 执行期间 BrowserManager 置 BUSY,结束后以「页面真的静默了」为准释放(§三)
 * - Provider 未就绪 → PENDING 保留等待(§12.2);登录失效 → 认领后 FAILED
 * - 失败映射(§12.13):PROVIDER_RESPONSE_TIMEOUT → TIMEOUT,其余一律 FAILED;绝不自动重试(原则 30)
 * - 取消(第 8 阶段):register → claim → execute(signal) → cancelled/complete/fail → releaseSlot
 *
 * V1.3 P7 §43~§48:取任务不再是「全局最老一条」,而是 **每用户一条 FIFO + 用户之间轮转**:
 *
 * ```text
 * perUser         Map<userId, requestId[]>   每用户内部严格 FIFO(§45)
 * readyUsers      userId[]                   轮转次序,一个用户至多一项(§48)
 * queuedRequestIds Set<requestId>            入队去重,含正在执行的那一条(§49)
 * current         { requestId, userId } | null  唯一在飞槽位(§44)
 * ```
 *
 * 队列是**派生状态**:每轮开始都跟数据库对账一次(§53),所以 notify 丢失、PENDING 被取消、
 * 上一进程遗留都不会让队列跑偏。配额真相在数据库、公平真相在这里(§75/§76)。
 * 桶上的 userId 只是分桶用的路由元数据:所有权仍是 Request→Conversation.userId,
 * 执行判据也仍然是数据库里的那一行(§51/§52),它绝不参与任何授权决定。
 */
export class RequestScheduler {
  private readonly opts: {
    scanIntervalMs: number;
    executionTimeoutMs: number;
    userMaxActiveRequests: number;
  };
  private timer: NodeJS.Timeout | null = null;
  /** 单飞闸:drain 未结束前,notify/interval 的再入直接丢弃 */
  private draining = false;
  /** P7 §44:每用户一条 FIFO;桶清空即删键,不积累空桶 */
  private readonly perUser = new Map<string, string[]>();
  /** P7 §44/§48:轮转次序;正在执行的用户临时不在其中(§47) */
  private readonly readyUsers: string[] = [];
  /** P7 §49:已入队(含正在执行)的 id,防重复入队与重复执行 */
  private readonly queuedRequestIds = new Set<string>();
  /** P7 §44:当前占用唯一 worker 的一条(至多一条) */
  private current: { requestId: string; userId: string } | null = null;
  /** P7 §57 + FIX-01A:本进程内每用户在飞计数;只是双条件的内存半边,DB 在飞计数才是真相 */
  private readonly activeByUser = new Map<string, number>();

  constructor(private readonly deps: RequestSchedulerDeps) {
    this.opts = {
      scanIntervalMs: deps.options?.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS,
      executionTimeoutMs: deps.options?.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
      userMaxActiveRequests: deps.options?.userMaxActiveRequests ?? USER_MAX_ACTIVE_REQUESTS,
    };
  }

  /** 启动周期扫描 + 立即扫一遍(服务启动时兜走历史 PENDING,§12.1) */
  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      void this.drainSafely();
    }, this.opts.scanIntervalMs);
    this.timer.unref();
    void this.drainSafely();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // P7 §198:内存队列是派生状态,停机即弃 —— 重启后由数据库对账重建,不留残桶
    this.perUser.clear();
    this.readyUsers.length = 0;
    this.queuedRequestIds.clear();
    this.activeByUser.clear();
    this.current = null;
  }

  /**
   * 发送事务提交后调用:新 PENDING 立即开工,不等下一个扫描周期(未启动时为 no-op)。
   *
   * P7 §50:除 id 外还带 req.auth.userId,只用来决定进哪个用户的 FIFO 桶;
   * §52:它不是授权依据 —— 认领/执行只看数据库里的那一行。
   */
  notify(requestId: string, userId: string): void {
    this.enqueue(requestId, userId);
    if (this.timer !== null) {
      void this.drainSafely();
    }
  }

  /** 同步等 drain 跑完(测试与人工触发用) */
  async runOnce(): Promise<void> {
    await this.drainSafely();
  }

  /**
   * 测试专用快照(§203:公平性必须可断言):轮转次序 + 每用户队首,全部来自内存。
   * 不进任何对外接口,也不参与调度判定。
   */
  snapshotQueue(): {
    readyUsers: string[];
    perUser: Record<string, string[]>;
    queuedRequestIds: string[];
    current: { requestId: string; userId: string } | null;
    activeByUser: Record<string, number>;
  } {
    const perUser: Record<string, string[]> = {};
    for (const [userId, bucket] of this.perUser) {
      perUser[userId] = [...bucket];
    }
    const activeByUser: Record<string, number> = {};
    for (const [userId, count] of this.activeByUser) {
      activeByUser[userId] = count;
    }
    return {
      readyUsers: [...this.readyUsers],
      perUser,
      queuedRequestIds: [...this.queuedRequestIds],
      current: this.current === null ? null : { ...this.current },
      activeByUser,
    };
  }

  // ---------------------------------------------------------------------------
  // 内部实现
  // ---------------------------------------------------------------------------

  private get logger(): Logger {
    return this.deps.logger;
  }

  private async drainSafely(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (await this.processNext()) {
        // 队列清空为止
      }
    } catch (err) {
      this.logger.error({ err }, "scheduler drain aborted");
    } finally {
      this.draining = false;
    }
  }

  /** 处理一条任务;返回 true 表示还有工作可继续, false 表示本轮结束(退出 drain) */
  private async processNext(): Promise<boolean> {
    // P7 §53:每轮先与数据库对账(notify 丢失、排队中被取消、上一进程遗留都在这里收敛),
    // 再按「用户轮转 + 每用户 FIFO」挑下一条候选。
    await this.reconcile();
    const candidate = await this.nextCandidate();
    if (candidate === null) {
      return false;
    }
    // §52:候选只是「该去看哪一行」的提示,能不能执行一律由数据库这一行说话
    const pending = await this.deps.requestRepo.findById(this.deps.prisma, candidate.requestId);
    if (pending === null || pending.status !== "PENDING") {
      // 排队期间被取消(§63)或已被别的路径收尾:就地出列,绝不执行,继续看下一条
      this.dropQueued(candidate);
      return true;
    }

    // FIX-08:锁必须在第一次 Provider Page 操作(ensureReady)之前获得,
    // 否则 gateProvider.ensureReady() 与 listModels() 存在并发窗口。
    // claimed / attachments 是跨 try 的所有权标记:只有认领过的附件才归本次执行释放。
    let claimed = false;
    let attachments: AttachmentFile[] | undefined;
    await this.deps.pageLock.acquire();
    try {
      const status = await this.gateProvider(pending.id);
      if (status === "WAIT") {
        return false;
      }
      if (status === "LOGIN_REQUIRED") {
        claimed = await this.deps.requestService.claim(pending.id);
        if (claimed) {
          this.beginExecution(candidate);
          await this.deps.requestService.fail(
            pending.id,
            "FAILED",
            ErrorCodes.PROVIDER_LOGIN_REQUIRED,
            "Gemini login is required",
          );
          this.logger.warn(
            { requestId: pending.id, conversationId: pending.conversationId, code: ErrorCodes.PROVIDER_LOGIN_REQUIRED },
            "request failed before execution",
          );
        } else {
          this.dropQueued(candidate);
        }
        return true;
      }

      // 在 claim 之前登记 controller:保证「PROCESSING ⇒ controller 已注册」是不变量,
      // cancel() 的 abort 不可能落空。
      const controller = this.deps.cancellation.register(pending.id);

      claimed = await this.deps.requestService.claim(pending.id);
      if (!claimed) {
        // 这一行已被别的路径动过(取消 / 恢复 / 并发认领):摘掉队列项,不再占轮转
        this.dropQueued(candidate);
        this.deps.cancellation.unregister(pending.id);
        return true;
      }
      // P7 §47:从此该用户暂时不在 readyUsers 里,执行期间晚到的用户排在它前面
      this.beginExecution(candidate);

      // §十 附件守卫(纯文本零成本:attachmentCount==0 时根本不碰 Store):
      // 字节没拿到 / 份数对不上,一律在执行器之前 FAILED。降级发一条「只有文字」的请求
      // 比失败更糟 —— 用户以为 Gemini 看到了图,实际没有。
      if (pending.attachmentCount > 0) {
        const files = this.deps.attachmentStore.take(pending.id);
        if (files === undefined || files.length !== pending.attachmentCount) {
          await this.deps.requestService.fail(
            pending.id,
            "FAILED",
            ErrorCodes.PROVIDER_ATTACHMENT_FAILED,
            files === undefined
              ? "Attachments are no longer available in memory"
              : `Expected ${pending.attachmentCount} attachments but found ${files.length}`,
          );
          this.deps.cancellation.unregister(pending.id);
          return true;
        }
        attachments = files;
      }

      const userMessage = await this.deps.messageRepo.findById(this.deps.prisma, pending.userMessageId);
      if (!userMessage) {
        await this.deps.requestService.fail(
          pending.id,
          "FAILED",
          ErrorCodes.DATABASE_ERROR,
          "request references missing user message",
        );
        this.deps.cancellation.unregister(pending.id);
        return true;
      }

      this.deps.browserManager.setBusy();
      try {
        const outcome = await this.runGuarded(pending, userMessage, controller, attachments);
        if (outcome.timedOut) {
          const code = this.deps.browserManager.takeProviderFault() ?? ErrorCodes.PROVIDER_RESPONSE_TIMEOUT;
          await this.deps.requestService.fail(
            pending.id,
            "TIMEOUT",
            code,
            `Request execution exceeded ${this.opts.executionTimeoutMs}ms`,
          );
          this.logger.warn(
            { requestId: pending.id, code },
            "request timed out",
          );
        } else if (outcome.result.cancelled) {
          await this.deps.requestService.cancelled(pending.id, outcome.result.answer);
          this.logger.info(
            { requestId: pending.id, answerLength: outcome.result.answer.length },
            "request cancelled",
          );
        } else {
          this.logger.info(
            {
              requestId: pending.id,
              conversationId: pending.conversationId,
              answerLength: outcome.result.answer.length,
            },
            "request completed",
          );
        }
      } catch (err) {
        const appErr = err instanceof AppError ? err : undefined;
        const code = await this.classifyExecutorError(err, appErr);
        const message =
          appErr?.message ??
          (err instanceof Error ? err.message : "unexpected executor failure");
        const nextStatus = code === ErrorCodes.PROVIDER_RESPONSE_TIMEOUT ? "TIMEOUT" : "FAILED";
        try {
          await this.deps.requestService.fail(pending.id, nextStatus, code, message);
        } finally {
          this.logger.warn(
            {
              requestId: pending.id,
              conversationId: pending.conversationId,
              code,
              requestStatus: nextStatus,
            },
            "request failed",
          );
        }
      } finally {
        this.deps.cancellation.unregister(pending.id);
        await this.releaseSlot();
      }
    } finally {
      // §十一 附件释放与页面锁同级:凡是本次真的认领过的附件,无论成功/失败/超时/崩溃/取消都收回。
      // 未认领(WAIT / claim 落空)一律不动 —— 那条 PENDING 稍后还要靠这份字节跑。
      if (claimed && pending.attachmentCount > 0) {
        this.deps.attachmentStore.drop(pending.id);
      }
      this.deps.pageLock.release();
      // P7 §47:本次执行结束(成功/失败/超时/取消都算)才把该用户放回轮转末尾,
      // 于是执行期间晚到的用户排在它前面。没认领成功时这一步是 no-op。
      this.finishExecution();
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // 公平队列(P7 §44~§49):内存状态只在 drain 内被改写,单飞闸保证不交叉
  // ---------------------------------------------------------------------------

  /**
   * 与数据库对账(§53):把库里还挂着 PENDING 的行补进内存,把已经不是 PENDING 的摘掉。
   *
   * 刻意「只追加、不重排」:已经在队列里的 id 保持原位(§45 的用户内 FIFO 由入队顺序决定),
   * 新出现的用户排到轮转末尾(§47)。因此 notify 丢了、或 Scheduler 停止期间有人发了消息,
   * 下一轮都能靠这条查询自愈,而不会把公平次序打乱。
   */
  private async reconcile(): Promise<void> {
    const rows = await this.deps.requestRepo.findPendingWithOwner(this.deps.prisma);
    const stillPending = new Set<string>();
    const dbOwnerById = new Map<string, string>();
    for (const row of rows) {
      stillPending.add(row.id);
      if (row.userId === null) {
        // §56:owner 取不到 = 库内部一致性异常。绝不塞进共享桶,也绝不执行未知归属的行
        this.logger.error(
          { requestId: row.id, code: ErrorCodes.INTERNAL_ERROR },
          "pending request has no resolvable owner; skipped",
        );
        continue;
      }
      dbOwnerById.set(row.id, row.userId);
    }
    // §153:内存桶与数据库 owner 不一致(只可能是程序 bug)时,两个都不采信 —— 先摘掉错挂的那条,
    // 让下面那次播种按数据库 owner 重新入队。少排一轮可以接受,拿错误的桶多排一条不行。
    for (const [requestId, bucketedAs] of this.bucketedOwner()) {
      const owner = dbOwnerById.get(requestId);
      if (owner === undefined || owner === bucketedAs || requestId === this.current?.requestId) {
        continue;
      }
      this.logger.error(
        { requestId, code: ErrorCodes.INTERNAL_ERROR },
        "queued request is bucketed under a user that disagrees with its db owner; re-bucketed",
      );
      this.forget(requestId);
    }
    for (const row of rows) {
      if (row.userId === null || this.queuedRequestIds.has(row.id)) {
        continue;
      }
      this.enqueue(row.id, row.userId);
    }
    // 已经不 PENDING(被取消 / 已认领 / 已终态)的队列项:摘掉,别占着轮转
    for (const requestId of [...this.queuedRequestIds]) {
      if (!stillPending.has(requestId) && requestId !== this.current?.requestId) {
        this.forget(requestId);
      }
    }
  }

  /** 队列项当前挂在哪个用户名下(§153 对账用);条数由 P6 全局容量封顶,不构成额外热点 */
  private bucketedOwner(): Map<string, string> {
    const owner = new Map<string, string>();
    for (const [userId, bucket] of this.perUser) {
      for (const requestId of bucket) {
        owner.set(requestId, userId);
      }
    }
    return owner;
  }

  /** P7 §45/§48:追加到该用户队尾;新用户进 readyUsers 末尾;重复 id 直接丢弃 */
  private enqueue(requestId: string, userId: string): void {
    if (this.queuedRequestIds.has(requestId)) {
      return;
    }
    this.queuedRequestIds.add(requestId);
    const bucket = this.perUser.get(userId);
    if (bucket === undefined) {
      this.perUser.set(userId, [requestId]);
      // §47/§48:正在执行的用户此刻不在轮转里,也不能被这条新请求提前拽回去 ——
      // 它由 finishExecution 在收尾时放回末尾,晚到的用户因此排在它前面。
      if (this.current?.userId !== userId) {
        this.readyUsers.push(userId);
      }
      return;
    }
    bucket.push(requestId);
  }

  /**
   * 按轮转取下一条可派发的候选(§46),并跳过在飞已达上限的用户(§57/§59)。
   *
   * FIX-01A 是**双条件**:内存 `activeByUser` 只挡本 Scheduler 自己的瞬时重复派发,
   * 数据库在飞计数(`PROCESSING` + `CANCELLING`,owner 取 `Conversation.userId`)才是最终真相 ——
   * 重启遗留、恢复路径、外部写入留下的在飞行只有它看得见。两个条件任一达到上限就跳过该用户,
   * 别的用户照常派发(上限是 per-user,不是全局)。
   *
   * 每个 ready 用户每轮至多查一次,全部被挡即返回 null 由调用方退出 drain —— 原地反复 count
   * 就是 §60 禁止的自旋。计数查询失败**一路抛出**(§9):把「查不到」当「没有」就是放行,
   * 宁可这一轮不推进,也不能违反在飞上限。
   *
   * 只 peek 不出列:Provider 未就绪时这一条必须留在原地等下一轮。
   */
  private async nextCandidate(): Promise<{ requestId: string; userId: string } | null> {
    for (const userId of this.readyUsers) {
      if ((this.activeByUser.get(userId) ?? 0) >= this.opts.userMaxActiveRequests) {
        continue;
      }
      const requestId = this.perUser.get(userId)?.[0];
      if (requestId === undefined) {
        continue;
      }
      const dbActive = await this.deps.requestRepo.countActiveForUser(this.deps.prisma, userId);
      if (dbActive >= this.opts.userMaxActiveRequests) {
        continue;
      }
      return { requestId, userId };
    }
    return null;
  }

  /** 认领成功:队首出列、该用户暂时退出轮转(§47)、在飞 +1、占住 current */
  private beginExecution(candidate: { requestId: string; userId: string }): void {
    const bucket = this.perUser.get(candidate.userId);
    if (bucket !== undefined) {
      const at = bucket.indexOf(candidate.requestId);
      if (at >= 0) {
        bucket.splice(at, 1);
      }
      if (bucket.length === 0) {
        this.perUser.delete(candidate.userId);
      }
    }
    this.removeFromRotation(candidate.userId);
    this.activeByUser.set(candidate.userId, (this.activeByUser.get(candidate.userId) ?? 0) + 1);
    this.current = candidate;
  }

  /** 一条执行收尾:摘掉在飞计数与去重标记,若该用户还有排队则回到轮转末尾(§47) */
  private finishExecution(): void {
    const current = this.current;
    if (current === null) {
      return;
    }
    this.current = null;
    this.queuedRequestIds.delete(current.requestId);
    const remaining = (this.activeByUser.get(current.userId) ?? 1) - 1;
    if (remaining > 0) {
      this.activeByUser.set(current.userId, remaining);
    } else {
      this.activeByUser.delete(current.userId);
    }
    if (this.perUser.has(current.userId) && !this.readyUsers.includes(current.userId)) {
      this.readyUsers.push(current.userId);
    }
  }

  /** 把一条已离开 PENDING 的候选从队列里彻底摘掉(不碰 current) */
  private dropQueued(candidate: { requestId: string; userId: string }): void {
    const bucket = this.perUser.get(candidate.userId);
    if (bucket !== undefined) {
      const at = bucket.indexOf(candidate.requestId);
      if (at >= 0) {
        bucket.splice(at, 1);
      }
      if (bucket.length === 0) {
        this.perUser.delete(candidate.userId);
        this.removeFromRotation(candidate.userId);
      }
    }
    this.queuedRequestIds.delete(candidate.requestId);
  }

  /** 按 id 摘掉队列项(reconcile 发现它已不 PENDING 时用) */
  private forget(requestId: string): void {
    this.queuedRequestIds.delete(requestId);
    for (const [userId, bucket] of this.perUser) {
      const at = bucket.indexOf(requestId);
      if (at < 0) {
        continue;
      }
      bucket.splice(at, 1);
      if (bucket.length === 0) {
        this.perUser.delete(userId);
        this.removeFromRotation(userId);
      }
      return;
    }
  }

  /** §48:一个用户在轮转里至多一项,移除时全删 */
  private removeFromRotation(userId: string): void {
    for (let i = this.readyUsers.length - 1; i >= 0; i -= 1) {
      if (this.readyUsers[i] === userId) {
        this.readyUsers.splice(i, 1);
      }
    }
  }

  /**
   * 执行异常 → 错误码(§8.8 Context 关闭竞态)。
   *
   * ① 粘性故障码:Context/Page close/crash 事件已先于异常落地(读并清);
   * ② 非「关闭族」异常:AppError 用自带码,否则兜底 INTERNAL_ERROR;
   * ③ 「关闭族」原始异常(Playwright "Target page, context or browser has been closed"
   *    等文案为 Page 单独关闭与 Context 崩溃共用,不得按文案归类):给 Manager 的
   *    close/crash 事件一个有界收敛窗口后按状态裁定 —— Context 已死/有粘性码 →
   *    PROVIDER_BROWSER_CRASHED;仅 Gemini Page 关闭 → PROVIDER_PAGE_CLOSED;
   *    窗口内无信号 → 按 AppError 码或兜底(维持旧语义)。
   */
  private async classifyExecutorError(
    err: unknown,
    appErr: AppError | undefined,
  ): Promise<string> {
    const sticky = this.deps.browserManager.takeProviderFault();
    if (sticky !== null) {
      return sticky;
    }
    if (!isContextClosedError(err)) {
      return appErr?.code ?? ErrorCodes.INTERNAL_ERROR;
    }
    const outcome = await this.deps.browserManager.settleCloseEvents(SETTLE_CLOSE_EVENTS_MS);
    if (outcome === "crashed") {
      this.deps.browserManager.takeProviderFault();
      return ErrorCodes.PROVIDER_BROWSER_CRASHED;
    }
    if (outcome === "page-closed") {
      return ErrorCodes.PROVIDER_PAGE_CLOSED;
    }
    return appErr?.code ?? ErrorCodes.INTERNAL_ERROR;
  }

  /**
   * 执行 + watchdog + 取消信号。
   *
   * 返回 discriminated result:{timedOut:true} 表示 watchdog 先于执行完成触发;
   * {result} 表示执行正常完成(可能是 cancelled:true)。
   * 抛出 = 执行本身抛错(由 processNext catch 处理)。
   *
   * watchdog 触发时先 abort controller(让 adapter 走 stopGeneration),
   * 再给 ABANDON_GRACE_MS 宽限期让确认跑完;宽限期内仍没 settle 才真正放弃。
   */
  private async runGuarded(
    request: ModelRequestModel,
    userMessage: MessageModel,
    controller: AbortController,
    attachments?: AttachmentFile[],
  ): Promise<{ timedOut: true } | { timedOut: false; result: PromptExecutionResult }> {
    const timeoutMs = this.opts.executionTimeoutMs;
    let timedOut = false;

    // 纯文本入参逐字保持原样(不多一个键);附件只送到执行器门口,I2-B 才消费
    const input: PromptExecutionInput =
      attachments === undefined
        ? { request, userMessage, signal: controller.signal }
        : { request, userMessage, signal: controller.signal, attachments };
    const work = this.deps.executor
      .execute(input)
      .then(async (result) => {
        // 只有非取消的成功路径在这里写终态;取消和超时由 processNext 分派
        if (!result.cancelled && !timedOut) {
          await this.deps.requestService.complete(request.id, result.answer);
        }
        return result;
      });
    // 防止 unhandled rejection:work 的错误由 processNext 的 catch 处理
    work.catch(() => undefined);

    try {
      const result = await new Promise<PromptExecutionResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          timedOut = true;
          this.logger.error(
            { requestId: request.id, executionTimeoutMs: timeoutMs },
            "request execution watchdog fired",
          );
          // 先 abort:让 adapter 走 stopGeneration,而不是「放弃等待但 Gemini 还在生成」
          controller.abort();

          // 给 stopGeneration 一个宽限期
          setTimeout(() => {
            reject(
              new AppError(
                ErrorCodes.PROVIDER_RESPONSE_TIMEOUT,
                `Request execution exceeded ${timeoutMs}ms`,
              ),
            );
          }, ABANDON_GRACE_MS);
        }, timeoutMs);

        work.then(
          (r) => {
            clearTimeout(timer);
            resolve(r);
          },
          (err) => {
            clearTimeout(timer);
            reject(err);
          },
        );
      });

      if (timedOut) {
        return { timedOut: true };
      }
      return { timedOut: false, result };
    } catch (err) {
      if (timedOut) {
        return { timedOut: true };
      }
      throw err;
    }
  }

  /**
   * 槽位释放(§三:取消后槽位不能立即释放,只有 Gemini 确认停止或明确失败才能 clearBusy)。
   *
   * idle → clearBusy(下一条可以开始);
   * !idle → restart(Browser 重建,Scheduler 暂停到 READY,gateProvider 已实现)。
   */
  private async releaseSlot(): Promise<void> {
    let idle: boolean;
    try {
      idle = await withTimeout(
        this.deps.executor.confirmIdle(),
        CONFIRM_IDLE_TIMEOUT_MS,
      );
    } catch {
      idle = false;
    }

    if (idle) {
      this.deps.browserManager.clearBusy();
    } else {
      this.logger.warn(
        { code: ErrorCodes.PROVIDER_CANCELLATION_UNCONFIRMED },
        "provider not idle after execution, restarting browser",
      );
      try {
        await this.deps.browserManager.restart();
      } catch (err) {
        this.logger.error({ err }, "browser restart after non-idle failed");
      }
    }
  }

  /**
   * Provider 门禁(在认领之前,§12.2:Browser 未就绪时 PENDING 继续等待):
   * READY → 放行;LOGIN_REQUIRED → 稳定失败;启动/导航等瞬时故障 → 本轮等待。
   */
  private async gateProvider(requestId: string): Promise<BrowserProviderStatus | "WAIT"> {
    try {
      const status = await this.deps.browserManager.ensureReady();
      if (status === "READY" || status === "LOGIN_REQUIRED") {
        return status;
      }
      return "WAIT";
    } catch (err) {
      this.logger.warn(
        { requestId, err },
        "scheduler waits: provider is not available",
      );
      return "WAIT";
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
