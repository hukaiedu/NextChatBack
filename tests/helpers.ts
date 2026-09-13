import type { Server } from "node:http";

import type { Express } from "express";

import { createApp } from "../src/app.js";
import type { AbuseProtectionConfig, AppHandle, SchedulerConfig, StreamingConfig } from "../src/app.js";
import { createLogger } from "../src/common/logger/logger.js";
import { ADMIN_USER_ID, AUTH_COOKIE_NAME, COMPAT_USER_ID } from "../src/config/constants.js";
import type { LoginRateLimiter } from "../src/modules/auth/auth.rate-limit.js";
import type { AuthSessionService } from "../src/modules/auth/auth.session.service.js";
import type { AuthDeps } from "../src/modules/auth/auth.types.js";
import type { PublicConversation } from "../src/modules/conversation/conversation.public.js";
import type { BrowserManager } from "../src/providers/gemini/browser-manager.js";
import type { GeminiAdapter } from "../src/providers/gemini/gemini.types.js";
import type { GeminiPromptService } from "../src/modules/provider/gemini-prompt.service.js";
import type { RequestScheduler } from "../src/modules/request/request.scheduler.js";
import type { AttachmentStore } from "../src/modules/request/request.attachment-store.js";
import type { RawAttachment } from "../src/modules/message/attachment.js";
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
  /** M3:执行器实例(直接驱动 execute,精确控制取消时点) */
  executor: GeminiPromptService;
  /** V1.2 I1:附件内存容器(断言 liveBytes 不变量 / 手动 sweep / 观察 slot 状态) */
  attachmentStore: AttachmentStore;
  /** V1.3-B2:DB Session 运行时(enabled 时非 null;测试直接驱动 sweepExpired) */
  authSessions: AuthSessionService | null;
  /** V1.3 P6:两个入口限流器(窗口推进 / 键数量清理断言;close() 统一 dispose) */
  rateLimits: AppHandle["rateLimits"];
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
  /** SEC-1:鉴权依赖;默认 null = 不鉴权(既有测试零语义变化) */
  auth?: AuthDeps | null;
  /** SEC-1 测试接缝:注入带假时钟的 limiter(AUTH-07 限流窗口推进) */
  loginRateLimiter?: LoginRateLimiter;
  /**
   * V1.3 P6:入口限额。默认放到 env 允许的最宽档 —— 这份 helper 被几十个既有测试文件共用,
   * 它们测的是业务流程而不是限流;P6 专项用例按需传窄值(或自己的假时钟),不改动别人的语义。
   */
  abuse?: AbuseProtectionConfig;
}): Promise<TestContext> {
  const prisma = await createPrismaClient(TEST_DATABASE_URL);
  const logger = createLogger("silent");

  // 默认注入"永不启动"的 Browser Manager stub(provider 测试才需要真实/可操纵实例)
  const browserManager = options?.browserManager ?? createFakeManager(new FakeDriver());

  const {
    app,
    scheduler,
    recovery,
    sse,
    events,
    cancellation,
    executor,
    attachmentStore,
    authSessions,
    rateLimits,
  } = createApp({
    prisma,
    probeDatabase: () => probeDatabase(prisma),
    logger,
    browserManager,
    auth: options?.auth ?? null,
    loginRateLimiter: options?.loginRateLimiter,
    abuse: {
      anonymousIpLimitPerHour: options?.abuse?.anonymousIpLimitPerHour ?? 10_000,
      anonymousIpLimitPerDay: options?.abuse?.anonymousIpLimitPerDay ?? 100_000,
      chatSubmitRatePerMinute: options?.abuse?.chatSubmitRatePerMinute ?? 10_000,
      userMaxPendingRequests: options?.abuse?.userMaxPendingRequests ?? 100,
      // 在飞上限保持生产默认 1:单 worker 下这是事实,不是可调参数
      userMaxActiveRequests: options?.abuse?.userMaxActiveRequests ?? 1,
      globalMaxPendingRequests: options?.abuse?.globalMaxPendingRequests ?? 10_000,
      clock: options?.abuse?.clock,
    },
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
    executor,
    attachmentStore,
    authSessions,
    rateLimits,

    sseConnections(): number {
      return sse.connectionCount();
    },

    async reset(): Promise<void> {
      // 附件字节活在进程里而不是数据库里:清库的同时必须清 slot,
      // 否则上一个用例留下的 liveBytes 会污染下一个用例的不变量断言。
      for (const slot of attachmentStore.stats().slots) {
        attachmentStore.drop(slot.requestId);
      }
      await prisma.modelRequest.deleteMany();
      await prisma.message.deleteMany();
      await prisma.conversation.deleteMany();
      // V1.3-B2:登录/匿名 bootstrap 会写 Session 与 User;ADMIN/COMPAT 哨兵行由 B1 migration
      // 建立,必须跨用例保留(Conversation FK RESTRICT 也依赖它们)
      await prisma.session.deleteMany();
      await prisma.user.deleteMany({
        where: { id: { notIn: [ADMIN_USER_ID, COMPAT_USER_ID] } },
      });
    },

    async close(): Promise<void> {
      scheduler.stop();
      // P6:两个入口限流器的 sweep 定时器与生产停机同一批撤掉
      rateLimits.anonymousIp.dispose();
      rateLimits.chatSubmit.dispose();
      // 附件容器的孤儿清理是定时任务:不撤掉,它可能在 $disconnect 之后才发起查询
      attachmentStore.dispose();
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

/**
 * V1.3-B3-3 §21/§22:运维端点(/api/admin/* 与旧 browser/provider 别名)ADMIN-only。
 * 需要 ADMIN 的集成测试共用这一份 AuthDeps;password 只活在测试进程内,不写 env。
 */
export const ADMIN_AUTH: AuthDeps = {
  enabled: true,
  password: "test-admin-password-123",
  ttlAnonymousSeconds: 7200,
  ttlAdminSeconds: 3600,
  touchIntervalSeconds: 60,
  allowedOrigins: null,
  trustProxy: false,
  cookieSecureAlways: false,
};

/** 登录为固定 ADMIN,返回 `personchat_session=…` Cookie 头值(失败直接抛,不在断言里静默) */
export async function loginAdmin(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: ADMIN_AUTH.password }),
  });
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
  if (res.status !== 200 || raw === undefined) {
    throw new Error(`loginAdmin failed: ${res.status} ${await res.text()}`);
  }
  return raw.split(";")[0]!;
}

/** 给请求补上 ADMIN Session Cookie,保留调用方已有的 headers */
export function withAdminCookie(cookie: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), Cookie: cookie },
  };
}

/**
 * §8 匿名 bootstrap:返回一个**已登录**匿名用户(CREATE 出 ANONYMOUS User + Session)的 Cookie 头值。
 * 与「不带 Cookie 的未认证请求(401)」是两类身份,B3-3 的权限矩阵必须分别验证。
 */
export async function loginAnonymous(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/anonymous`, { method: "POST" });
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
  if (res.status !== 200 || raw === undefined) {
    throw new Error(`loginAnonymous failed: ${res.status} ${await res.text()}`);
  }
  return raw.split(";")[0]!;
}

export async function createConversation(
  baseUrl: string,
  title?: string,
): Promise<PublicConversation> {
  const res = await fetch(`${baseUrl}/api/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(title !== undefined ? { title } : {}),
  });
  if (res.status !== 201) {
    throw new Error(`createConversation failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { data: PublicConversation };
  return body.data;
}

export async function sendMessage(
  baseUrl: string,
  conversationId: string,
  content: string,
  idempotencyKey: string,
  modelKey?: string,
  attachments?: RawAttachment[],
): Promise<Response> {
  const body: Record<string, unknown> = { content };
  if (modelKey !== undefined) {
    body.modelKey = modelKey;
  }
  // 缺省时不写这个键:纯文本请求的 body 与今天逐字节相同
  if (attachments !== undefined) {
    body.attachments = attachments;
  }
  return fetch(`${baseUrl}/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

/** POST /api/requests/:id/cancel(prd §8.9);init 用于带 Session Cookie */
export async function cancelRequest(
  baseUrl: string,
  requestId: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${baseUrl}/api/requests/${requestId}/cancel`, {
    ...init,
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

  static async connect(
    baseUrl: string,
    requestId: string,
    init?: RequestInit,
  ): Promise<SseTestClient> {
    const client = new SseTestClient();
    const res = await fetch(`${baseUrl}/api/requests/${requestId}/events`, {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        Accept: "text/event-stream",
      },
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
