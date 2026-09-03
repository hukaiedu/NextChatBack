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
});

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
      500,
    );
  }
  return result.data;
}
