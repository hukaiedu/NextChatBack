import { describe, expect, it } from "vitest";

import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { createLogger } from "../../src/common/logger/logger.js";
import type { MessageRepository } from "../../src/modules/message/message.repository.js";
import type { RequestService } from "../../src/modules/request/request.service.js";
import { RequestEventEmitter } from "../../src/modules/sse/event-emitter.js";
import { RequestSseSession } from "../../src/modules/sse/sse.service.js";
import type { SseFrame } from "../../src/modules/sse/sse.service.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MountOptions {
  status: string;
  content?: string;
  messageStatus?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  events?: RequestEventEmitter;
  /** 覆盖 send:模拟客户端断开时 res.write 抛错 */
  send?: (frame: SseFrame) => void;
}

/**
 * 用桩替换 RequestService / MessageRepository:只验证 SSE 连接的帧序与生命周期,
 * 数据库读写交给集成测试(本文件不碰 SQLite)。
 */
function mount(opts: MountOptions) {
  const frames: SseFrame[] = [];
  const events = opts.events ?? new RequestEventEmitter();
  const state = {
    request: {
      id: "req_1",
      assistantMessageId: "msg_a",
      status: opts.status,
      errorCode: opts.errorCode ?? null,
      errorMessage: opts.errorMessage ?? null,
    },
    message: { content: opts.content ?? "", status: opts.messageStatus ?? "STREAMING" },
  };
  let finished = 0;
  let httpEnded = 0;

  const session = new RequestSseSession({
    prisma: {} as PrismaClient,
    requests: { getById: async () => state.request } as unknown as RequestService,
    messageRepo: {
      findById: async (_db: PrismaClient, _id: string) => state.message,
    } as unknown as MessageRepository,
    events,
    logger: createLogger("silent"),
    requestId: "req_1",
    send: opts.send ?? ((frame) => frames.push(frame)),
    onFinished: () => {
      finished++;
    },
    onClosed: () => {
      httpEnded++;
    },
  });

  return {
    frames,
    events,
    session,
    state,
    eventsSeen: () => frames.map((frame) => frame.event),
    async start() {
      session.start();
      await sleep(0);
    },
    /** 让 post 队列里的数据库回读跑完 */
    settle: () => sleep(0),
    counts: () => ({ finished, httpEnded }),
  };
}

describe("RequestSseSession:帧序与生命周期(§9/§10)", () => {
  it("已完成的 Request:连接后立即给出最终状态并关闭", async () => {
    const h = mount({ status: "SUCCESS", content: "你好世界", messageStatus: "COMPLETED" });
    await h.start();

    expect(h.eventsSeen()).toEqual(["connected", "snapshot", "status"]);
    expect(h.frames[1]!.data).toEqual({ type: "snapshot", content: "你好世界" });
    expect(h.frames[2]!.data).toMatchObject({
      requestId: "req_1",
      status: "COMPLETED",
      requestStatus: "SUCCESS",
    });
    expect(h.counts()).toEqual({ finished: 1, httpEnded: 1 });
  });

  it("断线重连:库里已有的进度整段 snapshot 给出,不重放历史 delta", async () => {
    const h = mount({ status: "PROCESSING", content: "你好" });
    await h.start();

    expect(h.eventsSeen()).toEqual(["connected", "snapshot", "status"]);
    expect(h.frames[1]!.data).toEqual({ type: "snapshot", content: "你好" });
    // 仍在生成:连接保持
    expect(h.counts()).toEqual({ finished: 0, httpEnded: 0 });
  });

  it("PENDING 连接:只有 connected + status,没有内容帧", async () => {
    const h = mount({ status: "PENDING", content: "", messageStatus: "PENDING" });
    await h.start();

    expect(h.eventsSeen()).toEqual(["connected", "status"]);
    expect(h.frames[1]!.data).toMatchObject({ status: "PENDING", requestStatus: "PENDING" });
  });

  it("内容增长按本连接前缀推导 delta", async () => {
    const h = mount({ status: "PROCESSING" });
    await h.start();

    h.events.publishContent("req_1", "abc");
    h.events.publishContent("req_1", "abcd");
    await h.settle();

    expect(h.eventsSeen()).toEqual(["connected", "status", "delta", "delta"]);
    expect(h.frames.slice(2).map((f) => f.data.content)).toEqual(["abc", "d"]);
  });

  it("前文被改写:snapshot 覆盖而不是拼错", async () => {
    const h = mount({ status: "PROCESSING" });
    await h.start();

    h.events.publishContent("req_1", "abc");
    h.events.publishContent("req_1", "axbc");
    await h.settle();

    expect(h.frames.slice(2).map((f) => [f.event, f.data.content])).toEqual([
      ["delta", "abc"],
      ["snapshot", "axbc"],
    ]);
  });

  it("数据库进度滞后(节流):不回退已经推给前端的文本", async () => {
    const h = mount({ status: "PROCESSING", content: "你好" });
    await h.start();
    h.state.message.content = "你好世界";
    h.events.publishContent("req_1", "你好世界");
    await h.settle();

    // 状态通知回读数据库:库里只落到「你好」,不能把已发的整段替换回退
    h.events.publishStatus("req_1");
    await h.settle();

    expect(h.frames.slice(1).map((f) => [f.event, f.data.content ?? null])).toEqual([
      ["snapshot", "你好"],
      ["status", null],
      ["delta", "世界"],
      ["status", null],
    ]);
    expect(h.counts()).toEqual({ finished: 0, httpEnded: 0 });
  });

  it("PROCESSING → SUCCESS:回读数据库补上最终内容,发 status 后关闭", async () => {
    const h = mount({ status: "PROCESSING" });
    await h.start();
    h.events.publishContent("req_1", "你好");
    await h.settle();

    h.state.request.status = "SUCCESS";
    h.state.message.status = "COMPLETED";
    h.state.message.content = "你好世界";
    h.events.publishStatus("req_1");
    await h.settle();

    expect(h.eventsSeen()).toEqual(["connected", "status", "delta", "delta", "status"]);
    expect(h.frames[4]!.data).toMatchObject({ status: "COMPLETED", requestStatus: "SUCCESS" });
    expect(h.counts()).toEqual({ finished: 1, httpEnded: 1 });
  });

  it("FAILED:error 帧在前,status 兜底,然后关闭", async () => {
    const h = mount({ status: "PROCESSING" });
    await h.start();

    h.state.request.status = "FAILED";
    h.state.request.errorCode = ErrorCodes.PROVIDER_DOM_CHANGED;
    h.state.request.errorMessage = "Gemini page does not match expected structure";
    h.state.message.status = "FAILED";
    h.events.publishStatus("req_1");
    await h.settle();

    expect(h.eventsSeen()).toEqual(["connected", "status", "error", "status"]);
    expect(h.frames[2]!.data).toMatchObject({ code: ErrorCodes.PROVIDER_DOM_CHANGED });
    expect(h.frames[3]!.data).toMatchObject({ status: "FAILED", requestStatus: "FAILED" });
    expect(h.counts()).toEqual({ finished: 1, httpEnded: 1 });
  });

  it("TIMEOUT 同样回 error 帧", async () => {
    const h = mount({
      status: "TIMEOUT",
      content: "半成品",
      messageStatus: "FAILED",
      errorCode: ErrorCodes.PROVIDER_RESPONSE_TIMEOUT,
      errorMessage: "timeout",
    });
    await h.start();

    expect(h.eventsSeen()).toEqual(["connected", "snapshot", "error", "status"]);
    expect(h.frames[2]!.data).toMatchObject({ code: ErrorCodes.PROVIDER_RESPONSE_TIMEOUT });
  });

  it("写响应抛错(客户端断开):只结束这条连接", async () => {
    const h = mount({
      status: "PROCESSING",
      send: () => {
        throw new Error("socket destroyed");
      },
    });
    await h.start();

    expect(h.counts()).toEqual({ finished: 1, httpEnded: 1 });
    // 已结束的订阅者不再收后续事件,也不影响别的连接
    h.events.publishContent("req_1", "abc");
    h.events.publishStatus("req_1");
    await h.settle();
    expect(h.frames).toEqual([]);
    expect(h.events.listenerCount("req_1")).toBe(0);
  });

  it("多个客户端同时订阅:各自收到完整事件,不存在谁消费掉", async () => {
    const events = new RequestEventEmitter();
    const a = mount({ status: "PROCESSING", events });
    await a.start();
    const b = mount({ status: "PROCESSING", events });
    await b.start();

    expect(events.listenerCount("req_1")).toBe(2);
    events.publishContent("req_1", "你好");
    await a.settle();

    expect(a.frames.slice(1).map((f) => [f.event, f.data.content ?? null])).toEqual([
      ["status", null],
      ["delta", "你好"],
    ]);
    expect(b.frames.slice(1).map((f) => [f.event, f.data.content ?? null])).toEqual([
      ["status", null],
      ["delta", "你好"],
    ]);

    a.session.close();
    expect(events.listenerCount("req_1")).toBe(1);
  });
});

describe("RequestEventEmitter:进程内总线(§11)", () => {
  it("退订后不再收到事件", () => {
    const events = new RequestEventEmitter();
    const seen: string[] = [];
    const unsubscribe = events.subscribe("req_1", (notification) => {
      const { type, content } = notification as { type: string; content?: string };
      seen.push(`${type}:${content ?? ""}`);
    });

    events.publishContent("req_1", "a");
    events.publishStatus("req_1");
    unsubscribe();
    events.publishContent("req_1", "b");

    expect(seen).toEqual(["content:a", "status:"]);
    expect(events.listenerCount("req_1")).toBe(0);
  });

  it("事件按 requestId 隔离,不串会话", () => {
    const events = new RequestEventEmitter();
    const seen: string[] = [];
    events.subscribe("req_1", (n) => seen.push(`1:${n.type}`));
    events.subscribe("req_2", (n) => seen.push(`2:${n.type}`));

    events.publishStatus("req_2");
    expect(seen).toEqual(["2:status"]);
  });

  it("close 丢弃全部订阅:停机后发布变为 no-op", () => {
    const events = new RequestEventEmitter();
    const seen: string[] = [];
    events.subscribe("req_1", (n) => seen.push(n.type));

    events.close();
    events.publishContent("req_1", "a");
    expect(seen).toEqual([]);
  });
});
