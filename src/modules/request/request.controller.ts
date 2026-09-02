import { Router } from "express";

import { parseOrThrow } from "../../common/utils/parse.js";
import { requestParamSchema } from "./request.schema.js";
import type { RequestService } from "./request.service.js";

export function createRequestRouter(service: RequestService): Router {
  const router = Router();

  // GET /api/requests/:id
  router.get("/:id", async (req, res) => {
    const params = parseOrThrow(requestParamSchema, req.params, "requestParams");
    const request = await service.getById(params.id);
    res.json({ data: request });
  });

  return router;
}
