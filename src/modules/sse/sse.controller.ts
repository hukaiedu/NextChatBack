import { Router } from "express";

import { parseOrThrow } from "../../common/utils/parse.js";
import { requestParamSchema } from "../request/request.schema.js";
import type { SseService } from "./sse.service.js";
import { formatSseFrame } from "./sse.service.js";

/**
 * SSE API(prd 第 6 阶段 §8):
 *
 * GET /api/requests/:id/events   订阅一条 Request 的回答流(text/event-stream)
 *
 * 事件:`connected` / `delta` / `snapshot` / `status` / `error`。
 * 本层只做 HTTP 适配:设置流式响应头、把帧写进响应、把客户端断开映射成连接清理。
 * 不查业务、不改状态、不碰 Gemini —— 全部交给 SseService 与数据库(§2)。
 */
export function createSseRouter(sse: SseService): Router {
  const router = Router();

  router.get("/:id/events", async (req, res) => {
    const params = parseOrThrow(requestParamSchema, req.params, "requestParams");
    // 必须在写 SSE 头之前完成校验:否则 404 会被包成事件流,客户端拿不到正确状态码
    await sse.assertVisible(params.id);

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // 反向代理(Nginx)默认会缓冲,流式必须显式关掉
    res.flushHeaders();

    const session = sse.open(
      params.id,
      (frame) => {
        res.write(formatSseFrame(frame));
      },
      // 终态/断开/停机:会话结束就把响应收尾,否则 server.close() 会一直等这条长连接
      () => {
        if (!res.writableEnded) {
          res.end();
        }
      },
    );
    // 客户端断开 / 响应出错:只结束这条连接,Gemini 执行继续(§13)
    req.on("close", () => session.close());
    res.on("error", () => session.close());

    session.start();
  });

  return router;
}
