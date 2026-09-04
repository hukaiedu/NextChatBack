import type { Server } from "node:http";

import type { Express } from "express";

import { createApp } from "../src/app.js";
import type { SchedulerConfig, StreamingConfig } from "../src/app.js";
import { createLogger } from "../src/common/logger/logger.js";
import type { BrowserManager } from "../src/providers/gemini/browser-manager.js";
import type { GeminiAdapter } from "../src/providers/gemini/gemini.types.js";
import type { RequestScheduler } from "../src/modules/request/request.scheduler.js";
import type { RequestRecovery } from "../src/modules/request/request.recovery.js";
import type { RequestEventEmitter } from "../src/modules/sse/event-emitter.js";
import type { CancellationRegistry } from "../src/modules/request/request.cancellation.js";
import { TEST_DATABASE_URL } from "./global-setup.js";
import { createPrismaClient, probeDatabase } from "../src/database/prisma.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { FakeDriver, FakeGeminiAdapter, createFakeManager } from "./fakes.js";

export interface TestContext {
  prisma: PrismaClient;
  baseUrl: string;
  /** 仅当 setup 时开启 scheduler 才有值;autoStart=false 时可手动 runOnce 驱动 */
  scheduler: RequestScheduler | null;
  /** 启动恢复器;helper 不自动跑,测试用 run() 模拟「服务重启」 */
  recovery: RequestRecovery;
  /** 进程内 Request 事件总线:验证扇出、或直接发布事件 */
  events: RequestEventEmitter;
  /** 第 8 阶段:取消通道登记表(测试可断言 abort 次数 / 有界性) */
  cancellation: CancellationRegistry;
  /** 当前存活的 SSE 连接数 */
  sseConnections(): number;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** 每个测试文件独立 app + prisma(同一测试库),beforeEach 时 reset 数据 */
export async function setupTestContext(options?: {
  browserManager?: BrowserManager;
  geminiAdapter?: GeminiAdapter;
  /** 默认不启动 Scheduler(第 2 阶段行为测试不受影响);传入即启用,可 autoStart:false + runOnce 手动驱动 */
  scheduler?: SchedulerConfig;
  /** 第 6 阶段:流式内容写库节流间隔;SSE 集成测试传 0 让每次 delta 都立即落库 */
  streaming?: StreamingConfig;
}): Promise<TestContext> {
  const prisma = await createPrismaClient(TEST_DATABASE_URL);
  const logger = createLogger("silent");

  // 默认注入"永不启动"的 Browser Manager stub(provider 测试才需要真实/可操纵实例)
  const browserManager = options?.browserManager ?? createFakeManager(new FakeDriver());

  const { app, scheduler, recovery, sse, events, cancellation } = createApp({
    prisma,
    probeDatabase: () => probeDatabase(prisma),
    logger,
    browserManager,
    geminiAdapter: options?.geminiAdapter ?? new FakeGeminiAdapter(),
    scheduler: {
      scanIntervalMs: options?.scheduler?.scanIntervalMs ?? 25,
      executionTimeoutMs: options?.scheduler?.executionTimeoutMs,
      autoStart: options?.scheduler ? (options.scheduler.autoStart ?? true) : false,
    },
    streaming: options?.streaming,
  });

  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test server");
  }

  return {
    prisma,
    baseUrl: `http://127.0.0.1:${address.port}`,
    scheduler,
    recovery,
    events,
    cancellation,

    sseConnections(): number {
      return sse.connectionCount();
    },

    async reset(): Promise<void> {
      await prisma.modelRequest.deleteMany();
      await prisma.message.deleteMany();
      await prisma.conversation.deleteMany();
    },

    async close(): Promise<void> {
      scheduler.stop();
      // SSE 是长连接:不先结束掉,server.close() 会永远不回调
      sse.closeAll();
      // 测试拆台没有待收尾的请求:所有连接直接放掉。被 abort 的 fetch 套接字仍挂在服务端,
      // 只关空闲连接的话要等客户端 4s keep-alive 超时,每个 SSE 用例都会白等 4 秒。
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await prisma.$disconnect();
    },
  };
}

export async function createConversation(
  baseUrl: string,
  title?: string,
): Promise<{ id: string; title: string; status: string; provider: string }> {
  const res = await fetch(`${baseUrl}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(title !== undefined ? { title } : {}),
  });
  if (res.status !== 201) {
    throw new Error(`createConversation failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data: { id: string; title: string; status: string; provider: string } };
  return body.data;
}

export async function sendMessage(
  baseUrl: string,
  conversationId: string,
  content: string,
  idempotencyKey: string,
): Promise<Response> {
  return fetch(`${baseUrl}/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ content }),
  });
}

/** POST /api/requests/:id/cancel(prd §8.9) */
export async function cancelRequest(baseUrl: string, requestId: string): Promise<Response> {
  return fetch(`${baseUrl}/api/requests/${requestId}/cancel`, {
    method: "POST",
  });
}

export interface SseEventData {
  type?: string;
  content?: string;
  requestId?: string;
  /** Assistant Message 状态 */
  status?: string | null;
  /** Request 状态 */
  requestStatus?: string;
  code?: string;
  message?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface SseEvent {
  event: string;
  data: SseEventData;
}

/**
 * 测试用 SSE 客户端:后台解析帧入队,断言侧顺序取帧。
 * 只支持单消费者(测试按序 await),不做并发读取。
 */
export class SseTestClient {
  contentType = "";
  /** 已解析到的全部帧(含被 waitFor 跳过的),供整序断言 */
  readonly seen: SseEvent[] = [];
  private readonly queue: SseEvent[] = [];
  private wakeup: (() => void) | null = null;
  private ended = false;
  private readonly controller = new AbortController();

  static async connect(baseUrl: string, requestId: string): Promise<SseTestClient> {
    const client = new SseTestClient();
    const res = await fetch(`${baseUrl}/api/requests/${requestId}/events`, {
      headers: { Accept: "text/event-stream" },
      signal: client.controller.signal,
    });
    if (res.status !== 200) {
      throw new Error(`SSE connect failed: ${res.status} ${await res.text()}`);
    }
    client.contentType = res.headers.get("content-type") ?? "";
    if (res.body) {
      void client.read(res.body);
    }
    return client;
  }

  /** 取下一帧;流已结束返回 null,超时抛错 */
  async next(timeoutMs = 3000): Promise<SseEvent | null> {
    for (;;) {
      const frame = this.queue.shift();
      if (frame) {
        return frame;
      }
      if (this.ended) {
        return null;
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.wakeup = null;
          reject(new Error(`SSE frame timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        this.wakeup = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  /**
   * 顺序扫描到匹配的帧。`until` 用于设定边界:扫到第一个命中 until 的帧仍不匹配就报错,
   * 避免在「服务端还没发出的帧」上死等。
   */
  async waitFor(
    match: (event: SseEvent) => boolean,
    description: string,
    timeoutMs = 3000,
    until?: (event: SseEvent) => boolean,
  ): Promise<SseEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      const frame = await this.next(Math.max(remaining, 1));
      if (frame && match(frame)) {
        return frame;
      }
      if (frame && until?.(frame)) {
        throw new Error(`SSE frame '${description}' not found before ${JSON.stringify(frame.event)}`);
      }
      if (remaining <= 0) {
        throw new Error(`SSE timeout waiting for ${description}`);
      }
    }
  }

  /** 窗口内还能收到的帧(用于断言「没有更多事件」) */
  async drain(windowMs = 120): Promise<SseEvent[]> {
    const seen: SseEvent[] = [];
    const deadline = Date.now() + windowMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return seen;
      }
      const frame = await this.next(remaining).catch(() => null);
      if (frame === null) {
        return seen;
      }
      seen.push(frame);
    }
  }

  get isEnded(): boolean {
    return this.ended && this.queue.length === 0;
  }

  close(): void {
    this.controller.abort();
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseSseBlock(block);
          if (event) {
            this.seen.push(event);
            this.queue.push(event);
            this.wakeup?.();
            this.wakeup = null;
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // 客户端主动 abort:按「流已结束」处理
    } finally {
      this.ended = true;
      this.wakeup?.();
      this.wakeup = null;
    }
  }
}

function parseSseBlock(block: string): SseEvent | null {
  let event = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) {
      event = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      data += line.slice(6);
    }
  }
  if (!data) {
    return null;
  }
  return { event, data: JSON.parse(data) as SseEventData };
}
