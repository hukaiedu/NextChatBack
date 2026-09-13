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

/**
 * 带退避建议的错误:统一错误出口据此写 `Retry-After`(V1.3 P6 §78)。
 *
 * 抛出点(Service / Repository)拿不到 res,所以秒数挂在错误对象上由出口集中写头 ——
 * 否则每个入口各自 setHeader,同一码的退避值就会开始分叉。
 */
export class RetryAfterError extends AppError {
  constructor(
    code: ErrorCode,
    message: string,
    readonly retryAfterSeconds: number,
    cause?: unknown,
  ) {
    super(code, message, cause);
    this.name = "AppError";
  }
}
