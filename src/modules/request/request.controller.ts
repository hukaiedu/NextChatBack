import { Router } from "express";

import { parseOrThrow } from "../../common/utils/parse.js";
import { toPublicRequest } from "./request.public.js";
import { requestParamSchema } from "./request.schema.js";
import type { RequestService } from "./request.service.js";

export function createRequestRouter(service: RequestService): Router {
  const router = Router();

  // GET /api/requests/:id
  router.get("/:id", async (req, res) => {
    const params = parseOrThrow(requestParamSchema, req.params, "requestParams");
    const request = await service.getOwnedById(req.auth!.userId, params.id);
    res.json({ data: toPublicRequest(request) });
  });

  // POST /api/requests/:id/cancel(prd §8.9)
  router.post("/:id/cancel", async (req, res) => {
    const params = parseOrThrow(requestParamSchema, req.params, "requestParams");
    const outcome = await service.cancel(req.auth!.userId, params.id);
    if (outcome.kind === "cancelling") {
      res.status(202).json({ data: toPublicRequest(outcome.request) });
      return;
    }
    res.json({ data: toPublicRequest(outcome.request) });
  });

  return router;
}
