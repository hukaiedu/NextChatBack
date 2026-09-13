/**
 * V1.3 P6 §35/§36:排队准入的进程内互斥。
 *
 * 临界区只包住「配额复核 + ModelRequest 创建事务」这一小段。计数的真相在数据库,
 * 这把锁只消除同一进程内的 TOCTOU(Abuse-05:两个请求同时看到 pending=4 然后都建成功),
 * 它不是分布式锁,也不打算变成其一 —— 部署形态就是一个 Node 进程。
 *
 * 刻意不复用 ProviderPageLock(§37):那把锁保护的是唯一的 Gemini 页面,
 * 把 DB 准入挂上去等于让「排队计数」等在一次真实生成之后,分钟级临界区。
 */
export class RequestAdmissionGate {
  private tail: Promise<void> = Promise.resolve();

  /** 按到达顺序一次只执行一个任务;前一个任务失败不会传染后一个 */
  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const running = this.tail.then(task);
    // 队尾只关心「这一节结束了没有」,所以两种结局都收敛成 resolved
    this.tail = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  }
}

/** 两级排队容量(P6 §33/§34);单位都是「PENDING 条数」 */
export interface QueueLimits {
  userMaxPending: number;
  globalMaxPending: number;
}
