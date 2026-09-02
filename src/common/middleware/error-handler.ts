import type { ErrorRequestHandler } from "express";

import { REQUEST_ID_HEADER } from "../../config/constants.js";
import { AppError } from "../errors/app-error.js";
import { ErrorCodes } from "../errors/error-codes.js";
import type { Logger } from "../logger/logger.js";

/**
 * 统一错误出口:
 * - AppError → 对应 statusCode + { error: { code, message } }
 * - 其他错误 → 500 INTERNAL_ERROR(不向客户端泄露内部细节)
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    const appErr =
      err instanceof AppError
        ? err
        : new AppError(ErrorCodes.INTERNAL_ERROR, "Internal server error", 500, err);

    const requestId = req.header(REQUEST_ID_HEADER) ?? "-";

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
      },
    });
  };
}
