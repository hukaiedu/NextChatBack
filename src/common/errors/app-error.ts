import type { ErrorCode } from "./error-codes.js";
import { httpStatusForCode } from "./error-code-map.js";

/**
 * 业务错误:带错误码与 HTTP 状态,由 error-handler 统一输出。
 * statusCode 一律由 error-code-map 按错误码推导(第 9 阶段 §六),
 * 抛出点不再允许自行决定 HTTP 状态。
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  override readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = httpStatusForCode(code);
    this.cause = cause;
  }
}
