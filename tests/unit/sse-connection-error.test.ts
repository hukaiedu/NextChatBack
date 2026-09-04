import { describe, expect, it } from "vitest";

import { ErrorCodes } from "../../src/common/errors/error-codes.js";
import { httpStatusForCode } from "../../src/common/errors/error-code-map.js";
import type { Logger } from "../../src/common/logger/logger.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import type { MessageRepository } from "../../src/modules/message/message.repository.js";
import type { RequestService } from "../../src/modules/request/request.service.js";
import { RequestEventEmitter } from "../../src/modules/sse/event-emitter.js";
import { RequestSseSession } from "../../src/modules/sse/sse.service.js";
import type { SseFrame } from "../../src/modules/sse/sse.service.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface WarnCall {
  fields: Record<string, unknown>;
  msg: string;
}

/** 捕获 logger.warn:RequestSseSession.fail() 把兜底错误码记在这里 */
function spyLogger(): { logger: Logger; calls: WarnCall[] } {
  const calls: WarnCall[] = [];
  const logger = {
    warn(fields: unknown, msg?: string) {
      calls.push({ fields: fields as Record<string, unknown>, msg: msg ?? "" });
    },
  } as unknown as Logger;
  return { logger, calls };
}

/**
 * ERROR-01 专项(ISSUE-04):SSE_CONNECTION_ERROR。
 *
 * 构造 SSE 内部无法完成兜底路径:向 HTTP 响应写帧时抛出一个「非 AppError」
 * (例如底层 socket 断裂)。RequestSseSession.fail() 必须把它兜底成
 * SSE_CONNECTION_ERROR、映射 HTTP 500、只结束这一条连接,并且——
 * 因为 SSE 是只读通道——绝不改写库内 Request / Message 状态。
 */
describe("ERROR-01 SSE_CONNECTION_ERROR 专项(ISSUE-04)", () => {
  it("写响应抛非 AppError → 兜底 SSE_CONNECTION_ERROR + 500,连接关闭,库状态不被改写", async () => {
    const { logger, calls } = spyLogger();
    const frames: SseFrame[] = [];
    const events = new RequestEventEmitter();

    // 冻结的库内状态:SSE 只读,这条连接不应改动其中任何字段
    const dbRequest = {
      id: "req_sse_err",
      assistantMessageId: "msg_a",
      status: "PROCESSING",
      errorCode: null as string | null,
      errorMessage: null as string | null,
    };
    const dbMessage = { content: "半成品", status: "STREAMING" };
    const requestSnapshot = { ...dbRequest };
    const messageSnapshot = { ...dbMessage };

    let finished = 0;
    let httpEnded = 0;

    const session = new RequestSseSession({
      prisma: {} as PrismaClient,
      requests: { getById: async () => dbRequest } as unknown as RequestService,
      messageRepo: { findById: async () => dbMessage } as unknown as MessageRepository,
      events,
      logger,
      requestId: "req_sse_err",
      // 兜底路径:内部写响应恒抛非 AppError(如 write after end / socket hang up)
      send: () => {
        throw new Error("write after end / socket hang up");
      },
      onFinished: () => {
        finished++;
      },
      onClosed: () => {
        httpEnded++;
      },
    });

    session.start();
    await sleep(0);
    await sleep(0);

    // connected 帧就写不出去 → fail() 兜底
    const failCall = calls.find((c) => c.msg === "sse connection terminated by error");
    expect(failCall).toBeTruthy();
    expect(failCall!.fields.code).toBe(ErrorCodes.SSE_CONNECTION_ERROR);

    // HTTP 映射:SSE_CONNECTION_ERROR → 500(唯一映射表,不允许抛出点自定)
    expect(httpStatusForCode(ErrorCodes.SSE_CONNECTION_ERROR)).toBe(500);

    // 连接已收尾:订阅者摘除,后续事件不再影响这条连接
    expect({ finished, httpEnded }).toEqual({ finished: 1, httpEnded: 1 });
    expect(events.listenerCount("req_sse_err")).toBe(0);
    events.publishContent("req_sse_err", "更多内容");
    events.publishStatus("req_sse_err");
    await sleep(0);
    expect(frames).toEqual([]);

    // SSE 只读:库内 Request / Message 状态一字未改
    expect(dbRequest).toEqual(requestSnapshot);
    expect(dbMessage).toEqual(messageSnapshot);
  });
});
