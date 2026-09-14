import type { ErrorRequestHandler } from "express";

import { REQUEST_ID_HEADER } from "../../config/constants.js";
import { Prisma } from "../../generated/prisma/client.js";
import { AppError, RetryAfterError } from "../errors/app-error.js";
import { ErrorCodes } from "../errors/error-codes.js";
import { errorExposureOf } from "../errors/error-exposure.js";
import { toPublicError } from "../errors/public-error.js";
import type { Logger } from "../logger/logger.js";

/** express.json() 解析失败抛出的 SyntaxError 特征 */
function isBodyParseError(err: unknown): err is SyntaxError & { body?: unknown; status?: number } {
  return (
    err instanceof SyntaxError && "body" in err && (err as { status?: number }).status === 400
  );
}

/**
 * 请求体超限:raw-body 的 PayloadTooLargeError。
 * 两个特征同时成立才算 —— 只认 status 会把别处来的 413 也一并改写。
 */
function isPayloadTooLargeError(err: unknown): boolean {
  const e = err as { status?: unknown; type?: unknown };
  return e?.status === 413 && e?.type === "entity.too.large";
}

/** Prisma/SQLite 运行时异常(业务层已处理的除外,如 P2002) */
function isDatabaseError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError ||
    err instanceof Prisma.PrismaClientUnknownRequestError ||
    err instanceof Prisma.PrismaClientInitializationError ||
    err instanceof Prisma.PrismaClientValidationError
  );
}

/**
 * 错误日志只接收这份投影,不把原始 Error/cause 交给 Pino。
 * body-parser 的 SyntaxError.body 是原始请求体,可能包含 password/currentPassword 等明文;
 * 其它错误对象也可能通过嵌套 cause 携带 token/cookie/hash,所以过滤必须递归且不修改原对象。
 */
const SENSITIVE_ERROR_KEY =
  /(?:body|password|token|cookie|authorization|secret|hash|api[_-]?key)/i;

function isSensitiveErrorKey(key: string): boolean {
  return key === "body" || key === "rawBody" || SENSITIVE_ERROR_KEY.test(key);
}

function safeErrorLogValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (value instanceof Error) {
    // 保留原 Error 的 prototype 供 Pino 推导 type,但所有实例字段都来自安全复制。
    const projected = Object.create(Object.getPrototypeOf(value)) as Error &
      Record<string, unknown>;
    Object.defineProperty(projected, "message", {
      value: value.message,
      enumerable: false,
      configurable: true,
    });
    if (value.stack !== undefined) {
      Object.defineProperty(projected, "stack", {
        value: value.stack,
        enumerable: false,
        configurable: true,
      });
    }
    for (const key of Object.keys(value)) {
      if (isSensitiveErrorKey(key) || key === "message" || key === "stack") continue;
      Object.defineProperty(projected, key, {
        value: safeErrorLogValue((value as unknown as Record<string, unknown>)[key], seen),
        enumerable: true,
        configurable: true,
      });
    }
    // Error.cause 通常是 non-enumerable;显式投影它,同时递归执行同一套过滤。
    if ("cause" in value && !Object.prototype.hasOwnProperty.call(projected, "cause")) {
      Object.defineProperty(projected, "cause", {
        value: safeErrorLogValue((value as Error & { cause?: unknown }).cause, seen),
        enumerable: true,
        configurable: true,
      });
    }
    return projected;
  }

  if (Array.isArray(value)) {
    return value.map((item) => safeErrorLogValue(item, seen));
  }

  const projected: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveErrorKey(key)) continue;
    projected[key] = safeErrorLogValue(item, seen);
  }
  return projected;
}

function safeErrorLogRepresentation(error: unknown): unknown {
  return safeErrorLogValue(error, new WeakSet<object>());
}

/**
 * 统一错误出口:
 * - AppError → 对应 statusCode + { error: { code, message, requestId } }
 * - 请求体超过 body limit → 413 PAYLOAD_TOO_LARGE
 * - 非法 JSON body → 400 VALIDATION_ERROR
 * - Prisma/SQLite 异常 → 500 DATABASE_ERROR(内部细节只进日志,不泄露到响应)
 * - 其他错误 → 500 INTERNAL_ERROR
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    let appErr: AppError;
    if (isPayloadTooLargeError(err)) {
      appErr = new AppError(ErrorCodes.PAYLOAD_TOO_LARGE, "Request body too large", err);
    } else if (isBodyParseError(err)) {
      appErr = new AppError(ErrorCodes.VALIDATION_ERROR, "Invalid JSON body", err);
    } else if (isDatabaseError(err)) {
      appErr = new AppError(ErrorCodes.DATABASE_ERROR, "Database error", err);
    } else {
      appErr =
        err instanceof AppError
          ? err
          : new AppError(ErrorCodes.INTERNAL_ERROR, "Internal server error", err);
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
        // 只写不含 raw body / credential 的错误投影,不修改 appErr 或其 cause 原对象。
        err: safeErrorLogRepresentation(appErr.cause ?? appErr),
      },
      "request failed",
    );

    // §18:日志与数据库留原始值,只有这条对外信封经统一映射。
    // FIX-02A:判据是「这条请求走的是哪个 API surface」,不是「调用者是谁」——
    // ADMIN 调 Public 路由同样只拿到 Public Error。admin 语义由 Admin surface
    // middleware(requireAdmin 授权通过时)写入 res.locals,default-deny:没标记就是 public。
    const exposed = toPublicError(appErr.code, appErr.message, {
      internal: errorExposureOf(res) === "admin",
    });

    // P6 §78:限额类拒绝固定携带退避秒数,其余错误不写这个头
    if (appErr instanceof RetryAfterError) {
      res.setHeader("Retry-After", String(appErr.retryAfterSeconds));
    }

    res.status(appErr.statusCode).json({
      error: {
        code: exposed.code,
        message: exposed.message,
        requestId,
      },
    });
  };
}
