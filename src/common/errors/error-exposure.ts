import type { Response } from "express";

/**
 * V1.3-B3 FIX-02A:错误暴露级别的**唯一**判据 = API surface,不是调用者身份。
 *
 * Public API 永远走 Public Error Mapping —— 即使请求带着 ADMIN Session;
 * 只有 Admin surface(canonical `/api/admin/*` 与 ADMIN-only compatibility alias)
 * 才有资格暴露运维原始错误语义。方向不能反:「这个用户是 ADMIN」不构成切换理由,
 * 因为 ADMIN 同样在聊天路由上,那里读到的错误面向所有前端。
 *
 * default-deny:`res.locals` 上没有任何标记时按 public 处理,新增路由默认拿不到内部码。
 */
export type ErrorExposure = "public" | "admin";

/** `res.locals` 的键;集中一处,避免各挂载点字面量拼错后静默降级成 public */
const ERROR_EXPOSURE_KEY = "errorExposure";

/** 只有 Admin surface middleware 调用;授权通过的瞬间即切到 admin 错误语义 */
export function markAdminErrorSurface(res: Response): void {
  res.locals[ERROR_EXPOSURE_KEY] = "admin" satisfies ErrorExposure;
}

/** 读取当前请求的暴露级别;未被显式标记即为 public */
export function errorExposureOf(res: Response): ErrorExposure {
  return res.locals[ERROR_EXPOSURE_KEY] === "admin" ? "admin" : "public";
}
