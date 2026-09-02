import type { ErrorCode } from "./error-codes.js";

/** 业务错误:带错误码与 HTTP 状态,由 error-handler 统一输出 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  override readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, statusCode = 500, cause?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.cause = cause;
  }
}
