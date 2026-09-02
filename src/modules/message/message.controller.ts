import { Router } from "express";

import { parseOrThrow } from "../../common/utils/parse.js";
import {
  idempotencyKeyHeaderSchema,
  messageRouteParamSchema,
  sendMessageSchema,
} from "./message.schema.js";
import type { MessageService } from "./message.service.js";

/** 挂载路径:/api/conversations/:conversationId/messages */
export function createMessageRouter(service: MessageService): Router {
  // mergeParams: 继承父级挂载路径的 :conversationId 参数
  const router = Router({ mergeParams: true });

  // GET /api/conversations/:conversationId/messages
  router.get("/", async (req, res) => {
    const params = parseOrThrow(messageRouteParamSchema, req.params, "messageParams");
    const messages = await service.listMessages(params.conversationId);
    res.json({ data: messages });
  });

  // POST /api/conversations/:conversationId/messages
  router.post("/", async (req, res) => {
    const params = parseOrThrow(messageRouteParamSchema, req.params, "messageParams");
    const idempotencyKey = parseOrThrow(
      idempotencyKeyHeaderSchema,
      req.header("Idempotency-Key") ?? "",
      "Idempotency-Key header",
    );
    const body = parseOrThrow(sendMessageSchema, req.body ?? {}, "sendMessage");

    const result = await service.sendMessage(params.conversationId, body.content, idempotencyKey);
    // 幂等命中返回 200,首次成功创建 Request 返回 202 Accepted
    res.status(result.deduplicated ? 200 : 202).json({ data: result });
  });

  return router;
}
