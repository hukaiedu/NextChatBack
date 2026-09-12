import { Router } from "express";
import type { RequestHandler } from "express";

import { clearSessionCookie } from "../auth/auth.middleware.js";
import type { AuthSessionService } from "../auth/auth.session.service.js";
import type { BrowserStatusHandlers } from "../browser/browser-status.controller.js";
import type { ProviderHandlers } from "../provider/provider.controller.js";

/**
 * V1.3-B3-3 §23:canonical Admin API。
 *
 * GET  /api/admin/browser/status
 * POST /api/admin/browser/restart
 * GET  /api/admin/provider/status
 * POST /api/admin/provider/open
 * POST /api/admin/provider/restart
 * POST /api/admin/sessions/revoke-all
 *
 * 整条前缀 = requireAuth(app.ts 全局已挂)→ requireAdmin(router.use)。
 * 运维 handler 与旧路径共用同一份实现:alias 只是前缀 + 同一 guard,没有第二套逻辑。
 * 注意 `/api/provider/models` **不在**这里 —— 模型目录是普通聊天用户的能力(§24)。
 */
export interface AdminRouterDeps {
  browser: BrowserStatusHandlers;
  provider: ProviderHandlers;
  /** COMPAT 模式(AUTH_ENABLED=false)没有 Session 运行时:该分支下所有路由先被 requireAdmin 403 */
  sessions: AuthSessionService | null;
  requireAdmin: RequestHandler;
}

export function createAdminRouter(deps: AdminRouterDeps): Router {
  const router = Router();

  router.use(deps.requireAdmin);

  router.get("/browser/status", deps.browser.status);
  router.post("/browser/restart", deps.browser.restart);
  router.get("/provider/status", deps.provider.status);
  router.post("/provider/open", deps.provider.open);
  router.post("/provider/restart", deps.provider.restart);

  router.post("/sessions/revoke-all", async (req, res) => {
    // §29:吊销对象是调用者所属 ADMIN User 的全部 Session,含当前这一条。
    // 匿名用户不在此范围内 —— 按 userId 等值删除,不可能碰到别人的 Session。
    // sessions 的非空性是已证不变量:能过 requireAdmin ⇒ Session 由 DB 解析 ⇒ authRuntime 存在
    // (COMPAT 注入的是 ANONYMOUS,恒 403),与 req.auth! 同一类断言。
    const revoked = await deps.sessions!.revokeAllForUser(req.auth!.userId);
    // §30:删库成功才清 Cookie。上面一旦抛出就走统一错误出口,Cookie 保持原样,
    // 也不会返回一个假的 revoked 数字。
    clearSessionCookie(res);
    res.json({ data: { revoked } });
  });

  return router;
}
