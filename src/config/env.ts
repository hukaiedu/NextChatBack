import { z } from "zod";

import { AppError } from "../common/errors/app-error.js";
import { ErrorCodes } from "../common/errors/error-codes.js";

/** "true"/"false" → boolean(z.coerce.boolean 会把 "false" 变 true,不能用) */
const boolFromString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3010),
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  // Browser Manager(第 3 阶段)
  BROWSER_PROFILE_DIR: z.string().min(1).default("./data/browser-profile"),
  BROWSER_HEADLESS: boolFromString.default("false"),
  GEMINI_BASE_URL: z.string().url().default("https://gemini.google.com/app"),
  /** 单次 Prompt 从发送到读回最终回答的等待上限 */
  GEMINI_RESPONSE_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  /**
   * Scheduler 单条 Request 执行 watchdog 上限。
   * 必须高于 GEMINI_RESPONSE_TIMEOUT_MS:正常情况下由 Adapter 自己的超时先报,
   * watchdog 只兜「执行器挂死连超时都不返回」,把 PROCESSING 判成 TIMEOUT。
   */
  REQUEST_EXECUTION_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  /**
   * 流式回答期间 Assistant Message 的最小写库间隔(ms,第 6 阶段)。
   * 只节流数据库压力:SSE 事件按每次回答文本变化立即推送,不等落库。
   */
  STREAMING_UPDATE_INTERVAL_MS: z.coerce.number().int().min(0).default(300),
}).refine(
  // 跨字段约束(ISSUE-03):执行 watchdog 上限必须严格高于单次 Prompt 响应上限,
  // 否则 watchdog 可能早于 Adapter 自身超时触发,把正常执行误判成 TIMEOUT。
  // 相等同样非法(必须严格大于)。违反 → VALIDATION_ERROR + fail-fast。
  (env) => env.REQUEST_EXECUTION_TIMEOUT_MS > env.GEMINI_RESPONSE_TIMEOUT_MS,
  {
    message:
      "REQUEST_EXECUTION_TIMEOUT_MS must be greater than GEMINI_RESPONSE_TIMEOUT_MS",
    path: ["REQUEST_EXECUTION_TIMEOUT_MS"],
  },
);

export type Env = z.infer<typeof envSchema>;

/** 解析并校验环境变量,失败抛 VALIDATION_ERROR */
export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `Invalid environment variables: ${detail}`,
    );
  }
  return result.data;
}
