import type { ErrorCode } from "./error-codes.js";

/**
 * 错误码 → HTTP 状态码的唯一映射(第 9 阶段 §六)。
 *
 * 任何地方(Controller / Service / 错误出口)都不得自行决定错误响应的 HTTP 状态:
 * AppError 的 statusCode 一律由此表推导。新增错误码时必须在此登记,
 * 漏登记会在类型检查期报错(Record<ErrorCode, number> 强制全覆盖)。
 */
export const ERROR_CODE_HTTP_STATUS = {
  // 请求本身不合法
  VALIDATION_ERROR: 400,

  // 会话资源
  CONVERSATION_NOT_FOUND: 404,
  CONVERSATION_DELETED: 409,
  CONVERSATION_ARCHIVED: 409,
  CONVERSATION_REQUEST_IN_PROGRESS: 409,

  // Request 生命周期
  IDEMPOTENCY_KEY_REUSED: 409,
  REQUEST_NOT_FOUND: 404,
  REQUEST_NOT_CANCELLABLE: 409,
  SERVER_RESTARTED_DURING_PROCESSING: 500,
  SERVER_RESTARTED_DURING_CANCELLING: 500,
  STREAMING_UPDATE_FAILED: 500,
  SSE_CONNECTION_ERROR: 500,

  // Provider(自动化)侧
  PROVIDER_NOT_READY: 500,
  PROVIDER_LOGIN_REQUIRED: 401,
  PROVIDER_PROFILE_IN_USE: 500,
  PROVIDER_BROWSER_START_FAILED: 500,
  PROVIDER_PAGE_CLOSED: 500,
  PROVIDER_BROWSER_CRASHED: 500,
  PROVIDER_NAVIGATION_FAILED: 500,
  PROVIDER_DOM_CHANGED: 500,
  PROVIDER_RESPONSE_TIMEOUT: 500,
  PROVIDER_CONVERSATION_UNAVAILABLE: 409,
  PROVIDER_CANCELLATION_UNCONFIRMED: 500,
  PROVIDER_RATE_LIMITED: 429,
  // M1:模型键不在目录中 → 客户端可换一个键重试,与「会话不可用」同级冲突
  PROVIDER_MODEL_UNAVAILABLE: 409,
  // M1:目录读取 / 模型切换失败 → 服务端内部自动化故障
  PROVIDER_MODEL_SWITCH_FAILED: 500,

  // 兜底
  DATABASE_ERROR: 500,
  INTERNAL_ERROR: 500,
} as const satisfies Record<ErrorCode, number>;

/** 按错误码查 HTTP 状态;未知码防御性回落 500(正常情况下类型系统已保证全覆盖) */
export function httpStatusForCode(code: ErrorCode): number {
  return ERROR_CODE_HTTP_STATUS[code] ?? 500;
}
