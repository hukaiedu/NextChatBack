import { Router } from "express";

import type { Logger } from "../../common/logger/logger.js";

export type HealthProbe = () => Promise<void>;

export interface HealthDeps {
  probeDatabase: HealthProbe;
  logger: Logger;
}

/**
 * GET /api/health
 *
 * 200: { "data": { "status": "OK", "database": "OK" } }
 * 503: { "data": { "status": "ERROR", "database": "DOWN" } }
 */
export function createHealthRouter(deps: HealthDeps): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      await deps.probeDatabase();
      res.json({ data: { status: "OK", database: "OK" } });
    } catch (err) {
      deps.logger.error({ err }, "health check failed: database unreachable");
      res.status(503).json({ data: { status: "ERROR", database: "DOWN" } });
    }
  });

  return router;
}
