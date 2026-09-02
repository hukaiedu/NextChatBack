import type { ErrorRequestHandler } from "express";

import { REQUEST_ID_HEADER } from "../../config/constants.js";
import { AppError } from "../errors/app-error.js";
import { ErrorCodes } from "../errors/error-codes.js";
import type { Logger } from "../logger/logger.js";

/** express.json() 解析失败抛出的 SyntaxError 特征 */
function isBodyParseError(err: unknown): err is SyntaxError & { body?: unknown; status?: number } {
  return (
    err instanceof SyntaxError && "body" in err && (err as { status?: number }).status === 400
  );
}

/**
 * 统一错误出口:
 * - AppError → 对应 statusCode + { error: { code, message, requestId } }
 * - 非法 JSON body → 400 VALIDATION_ERROR
 * - 其他错误 → 500 INTERNAL_ERROR(不向客户端泄露内部细节)
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    let appErr: AppError;
    if (isBodyParseError(err)) {
      appErr = new AppError(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid JSON body",
        400,
        err,
      );
    } else {
      appErr =
        err instanceof AppError
          ? err
          : new AppError(ErrorCodes.INTERNAL_ERROR, "Internal server error", 500, err);
    }

    // requestId 必须与 x-request-id 响应头一致
    const requestId =
      (res.getHeader(REQUEST_ID_HEADER) as string | undefined) ??
      req.header(REQUEST_ID_HEADER) ??
      "-";

    logger.error(
      {
        requestId,
        code: appErr.code,
        statusCode: appErr.statusCode,
        message: appErr.message,
        err: appErr.cause ?? appErr,
      },
      "request failed",
    );

    res.status(appErr.statusCode).json({
      error: {
        code: appErr.code,
        message: appErr.message,
        requestId,
      },
    });
  };
}
