import { Router } from "express";

import { parseOrThrow } from "../../common/utils/parse.js";
import {
  createConversationSchema,
  listConversationsQuerySchema,
  patchConversationSchema,
} from "./conversation.schema.js";
import type { ConversationService } from "./conversation.service.js";

export function createConversationRouter(service: ConversationService): Router {
  const router = Router();

  // POST /api/conversations
  router.post("/", async (req, res) => {
    const input = parseOrThrow(createConversationSchema, req.body ?? {}, "createConversation");
    const conversation = await service.create(input);
    res.status(201).json({ data: conversation });
  });

  // GET /api/conversations?status=ACTIVE&limit=30&cursor=...
  router.get("/", async (req, res) => {
    const query = parseOrThrow(listConversationsQuerySchema, req.query, "listConversations");
    const result = await service.list(query);
    res.json({ data: result.items, meta: { nextCursor: result.nextCursor } });
  });

  // GET /api/conversations/:id
  router.get("/:id", async (req, res) => {
    const conversation = await service.getById(req.params.id);
    res.json({ data: conversation });
  });

  // PATCH /api/conversations/:id
  router.patch("/:id", async (req, res) => {
    const input = parseOrThrow(patchConversationSchema, req.body ?? {}, "patchConversation");
    const conversation = await service.update(req.params.id, input);
    res.json({ data: conversation });
  });

  // DELETE /api/conversations/:id → 204 软删除
  router.delete("/:id", async (req, res) => {
    await service.softDelete(req.params.id);
    res.status(204).end();
  });

  return router;
}
