/** Prisma 已知错误判定(duck-typing,避免依赖生成物的错误类型导出) */

export interface PrismaKnownError {
  code: string;
  meta?: { target?: unknown };
}

export function isPrismaError(err: unknown): err is PrismaKnownError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as PrismaKnownError).code === "string"
  );
}

/** unique 约束冲突(P2002),返回冲突目标列表 */
export function isUniqueViolation(
  err: unknown,
): err is PrismaKnownError & { code: "P2002" } {
  return isPrismaError(err) && err.code === "P2002";
}

export function uniqueViolationTargets(err: PrismaKnownError & { code: "P2002" }): string[] {
  const target = err.meta?.target;
  if (Array.isArray(target)) {
    return target.map(String);
  }
  if (typeof target === "string") {
    return [target];
  }
  return [];
}
