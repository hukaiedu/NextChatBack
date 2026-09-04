/**
 * 进程内取消通道:RequestService 只登记「要中止哪条 Request」,
 * Scheduler 在认领前登记 controller、执行时把 signal 透传给 Gemini Adapter。
 *
 * 拆成独立小类而不让 RequestService 直接持有 Scheduler 引用,是为了避开
 * RequestService ↔ RequestScheduler 的循环依赖(与第 6 阶段 RequestStatusEvents 同一手法)。
 *
 * 有界性:Scheduler 在 claim **之前** register、在 finally 里 unregister,
 * 因此「数据库里是 PROCESSING」⇒「本进程一定有一条已登记的 controller」,abort 不可能落空;
 * 单飞 Scheduler 下 Map 里最多 1 项。
 */
export class CancellationRegistry {
  private readonly controllers = new Map<string, AbortController>();

  /**
   * 返回 controller 而不只是 signal:执行超时(watchdog)与用户取消共用同一个 abort 通道,
   * 这样超时也走 Adapter 的 stopGeneration,不会「放弃等待但 Gemini 还在生成」。
   * 重复登记同一 id 直接覆盖(单飞下不会发生,覆盖也不丢状态)。
   */
  register(requestId: string): AbortController {
    const controller = new AbortController();
    this.controllers.set(requestId, controller);
    return controller;
  }

  /**
   * 中止在飞的执行。false = 该 Request 当前没有在本进程内执行
   * (PENDING 尚未认领,或已收尾注销)。调用方不据此分支落状态 ——
   * 状态一律由数据库的条件写决定,这里只是尽力把 signal 送到。
   */
  abort(requestId: string): boolean {
    const controller = this.controllers.get(requestId);
    if (!controller) {
      return false;
    }
    controller.abort();
    return true;
  }

  unregister(requestId: string): void {
    this.controllers.delete(requestId);
  }

  /** 停机时用:让所有在飞执行有机会走 stopGeneration,而不是被浏览器直接拔掉 */
  abortAll(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
  }

  size(): number {
    return this.controllers.size;
  }
}
