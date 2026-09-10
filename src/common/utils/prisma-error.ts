/** Prisma 已知错误判定(duck-typing,避免依赖生成物的错误类型导出) */

export interface PrismaKnownError {
  code: string;
  meta?: {
    /** 旧 query-engine 形状:冲突列数组,或单个标识 */
    target?: unknown;
    /** Prisma 模型名;两种已知形状都带 */
    modelName?: unknown;
    /** 仅 driver adapter 形状有 */
    driverAdapterError?: unknown;
  };
}

/**
 * 一条唯一约束冲突的结构化信息:归属 + 冲突列。
 *
 * 刻意不带约束名 —— 实测两种已知形状都不返回它:driver adapter 只给 `table` + `fields`,
 * 旧 query-engine 的 `target` 给的也是列名。留一个恒为 undefined 的字段只会诱使调用方
 * 又去按索引名分类(I1.1 修掉的正是这个错觉)。
 */
export interface UniqueViolationInfo {
  modelName?: string;
  table?: string;
  fields: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** string[] 逐项转字符串,string 视作单列,其余一律空 —— 认不出就不给结论 */
function normalizeColumns(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  return typeof value === "string" ? [value] : [];
}

/**
 * 当前形状(@prisma/adapter-better-sqlite3):
 * `meta.driverAdapterError.cause` = { originalCode, kind, constraint: { fields }, table }
 */
function readAdapterViolation(driverAdapterError: unknown): { table?: string; fields: string[] } {
  if (!isRecord(driverAdapterError)) {
    return { fields: [] };
  }
  const cause = driverAdapterError.cause;
  if (!isRecord(cause)) {
    return { fields: [] };
  }
  const constraint = cause.constraint;
  return {
    table: optionalString(cause.table),
    fields: isRecord(constraint) ? normalizeColumns(constraint.fields) : [],
  };
}

export function isPrismaError(err: unknown): err is PrismaKnownError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as PrismaKnownError).code === "string"
  );
}

/** unique 约束冲突(P2002) */
export function isUniqueViolation(
  err: unknown,
): err is PrismaKnownError & { code: "P2002" } {
  return isPrismaError(err) && err.code === "P2002";
}

/**
 * 解析唯一约束冲突的归属与冲突列;非 P2002 一律空结论。
 *
 * 取值优先级固定:先旧 `meta.target`(退回 query engine 时仍然正确),再 driver adapter。
 * 只读结构化字段,绝不解析 message 文案 —— 那部分文案 Prisma 不承诺兼容。
 */
export function uniqueViolationInfo(err: unknown): UniqueViolationInfo {
  if (!isUniqueViolation(err)) {
    return { fields: [] };
  }
  const modelName = optionalString(err.meta?.modelName);
  const legacy = normalizeColumns(err.meta?.target);
  if (legacy.length > 0) {
    return { modelName, fields: legacy };
  }
  const adapter = readAdapterViolation(err.meta?.driverAdapterError);
  return { modelName, table: adapter.table, fields: adapter.fields };
}
