import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import type { Logger } from "../../common/logger/logger.js";
import type { BrowserProviderStatus } from "../../providers/gemini/browser-driver.js";
import type { BrowserManager } from "../../providers/gemini/browser-manager.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { MessageModel, ModelRequestModel } from "../../generated/prisma/models.js";
import type { MessageRepository } from "../message/message.repository.js";
import type { PromptExecutionResult, PromptExecutor } from "../provider/gemini-prompt.service.js";
import type { RequestRepository } from "./request.repository.js";
import type { RequestService } from "./request.service.js";
import type { CancellationRegistry } from "./request.cancellation.js";
import { isContextClosedError } from "../../providers/gemini/gemini.errors.js";

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
  options?: { scanIntervalMs?: number; executionTimeoutMs?: number };
}

/**
 * 单进程内存 Scheduler(prd 第 5 阶段;§12.1 内存队列重启即失,PENDING 靠启动扫描自然恢复)。
 *
 * - 只认领 PENDING,单飞串行:同一时刻最多一个 Gemini Request
 * - 执行期间 BrowserManager 置 BUSY,结束后以「页面真的静默了」为准释放(§三)
 * - Provider 未就绪 → PENDING 保留等待(§12.2);登录失效 → 认领后 FAILED
 * - 失败映射(§12.13):PROVIDER_RESPONSE_TIMEOUT → TIMEOUT,其余一律 FAILED;绝不自动重试(原则 30)
 * - 取消(第 8 阶段):register → claim → execute(signal) → cancelled/complete/fail → releaseSlot
 */
export class RequestScheduler {
  private readonly opts: { scanIntervalMs: number; executionTimeoutMs: number };
  private timer: NodeJS.Timeout | null = null;
  /** 单飞闸:drain 未结束前,notify/interval 的再入直接丢弃 */
  private draining = false;

  constructor(private readonly deps: RequestSchedulerDeps) {
    this.opts = {
      scanIntervalMs: deps.options?.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS,
      executionTimeoutMs: deps.options?.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
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
  }

  /** 发送事务提交后调用:新 PENDING 立即开工,不等下一个扫描周期(未启动时为 no-op) */
  notify(): void {
    if (this.timer !== null) {
      void this.drainSafely();
    }
  }

  /** 同步等 drain 跑完(测试与人工触发用) */
  async runOnce(): Promise<void> {
    await this.drainSafely();
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

  /** 处理一条任务;返回 true 表示还有工作可继续, false 表示本轮结束 */
  private async processNext(): Promise<boolean> {
    const pending = await this.deps.requestRepo.findFirstPending(this.deps.prisma);
    if (!pending) {
      return false;
    }

    const status = await this.gateProvider(pending.id);
    if (status === "WAIT") {
      return false;
    }
    if (status === "LOGIN_REQUIRED") {
      if (await this.deps.requestService.claim(pending.id)) {
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
      }
      return true;
    }

    // 在 claim 之前登记 controller:保证「PROCESSING ⇒ controller 已注册」是不变量,
    // cancel() 的 abort 不可能落空。
    const controller = this.deps.cancellation.register(pending.id);

    if (!(await this.deps.requestService.claim(pending.id))) {
      this.deps.cancellation.unregister(pending.id);
      return true;
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
      const outcome = await this.runGuarded(pending, userMessage, controller);
      if (outcome.timedOut) {
        // watchdog 触发:即使 adapter 返回了 cancelled:true,也优先落 TIMEOUT
        // (否则会出现「用户没取消但被标为 CANCELLED」)
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
            // prd §14 / ISSUE-02:不记未脱敏的 Provider 会话 URL(含 Gemini conversation id)。
            // 需定位时凭 conversationId 查库,日志只保留长度类非敏感字段。
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
    return true;
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
  ): Promise<{ timedOut: true } | { timedOut: false; result: PromptExecutionResult }> {
    const timeoutMs = this.opts.executionTimeoutMs;
    let timedOut = false;

    const work = this.deps.executor
      .execute({ request, userMessage, signal: controller.signal })
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
      const status = await this.deps.browserManager.openGemini();
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
