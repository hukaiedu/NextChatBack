import { EventEmitter } from "node:events";

/**
 * Request 的一次可观察变化。
 *
 * - `content`:回答文本增长了(携带当前完整文本)。这是**传输层加速**,
 *   数据库仍是最终状态来源:断线重连、终态判定一律回读数据库;
 * - `status`:Request / Assistant Message 状态可能变了(不带数据,订阅者回读数据库)。
 */
export type RequestNotification =
  | { type: "content"; content: string }
  | { type: "status" };

export type RequestNotificationListener = (notification: RequestNotification) => void;

/**
 * 进程内 Request 事件总线(第 6 阶段 §11:第一版不引入 Redis)。
 *
 * 事件名 = `request:${requestId}`,每个 SSE 连接挂自己的监听器,
 * 因此同一 Request 的多个订阅者都会各自收到完整事件流(§12),不存在「谁消费掉了」。
 * 监听器上限置 0:订阅数由客户端决定,不该被 Node 默认的 10 个警告线约束。
 */
export class RequestEventEmitter {
  private readonly events = new EventEmitter().setMaxListeners(0);

  publishContent(requestId: string, content: string): void {
    this.events.emit(channel(requestId), { type: "content", content } satisfies RequestNotification);
  }

  publishStatus(requestId: string): void {
    this.events.emit(channel(requestId), { type: "status" } satisfies RequestNotification);
  }

  /** 返回退订函数;监听器抛错只允许影响它自己的连接(订阅方自行保证异步隔离) */
  subscribe(requestId: string, listener: RequestNotificationListener): () => void {
    const name = channel(requestId);
    this.events.on(name, listener);
    return () => {
      this.events.off(name, listener);
    };
  }

  listenerCount(requestId: string): number {
    return this.events.listenerCount(channel(requestId));
  }

  /** 应用关闭:丢弃全部订阅,之后 publish 变为 no-op */
  close(): void {
    this.events.removeAllListeners();
  }
}

function channel(requestId: string): string {
  return `request:${requestId}`;
}
