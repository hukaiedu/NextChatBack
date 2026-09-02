/**
 * 统一错误码。
 *
 * 第 1 阶段只注册实际用到的错误码。
 * 后续阶段按 prd.md §12.13 扩充。
 */
export const ErrorCodes = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  DATABASE_ERROR: "DATABASE_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
