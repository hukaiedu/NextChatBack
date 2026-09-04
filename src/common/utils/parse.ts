import type { z } from "zod";

import { AppError } from "../errors/app-error.js";
import { ErrorCodes } from "../errors/error-codes.js";

/** zod 校验失败统一转 400 VALIDATION_ERROR;返回 schema 的 output 类型(zod default 生效后) */
export function parseOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
  label: string,
): z.output<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `${label}: ${detail}`);
  }
  return result.data;
}
