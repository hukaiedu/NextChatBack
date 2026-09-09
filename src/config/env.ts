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
  /**
   * P8:可选显式浏览器代理(仅 Playwright Chromium 使用)。V1 只支持
   * http/https/socks5 且禁止携带 credentials;未设置 = 不传 Playwright proxy
   * (Windows 开发环境沿用 Chromium 继承的系统代理)。
   */
  BROWSER_PROXY_URL: z
    .string()
    .optional()
    .refine(isValidProxyUrl, {
      message:
        "BROWSER_PROXY_URL must use http, https, or socks5 and must not contain credentials",
    }),
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

  // SEC-1 服务端鉴权(docs/SEC1_AUTH_DESIGN.md §3.3)
  AUTH_ENABLED: boolFromString.default("false"),
  /** AUTH_ENABLED=true 时必填;min 12 门槛在 refine 中按开关条件执行 */
  AUTH_PASSWORD: z.string().optional(),
  /** AUTH_ENABLED=true 时必填;≥32 字符为最低门槛(HMAC-SHA256 签名密钥) */
  AUTH_SESSION_SECRET: z.string().optional(),
  AUTH_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(2_592_000)
    .default(604_800),
  /** 只影响 req.ip(登录限流键/审计),不影响 Cookie Secure */
  AUTH_TRUST_PROXY: boolFromString.default("false"),
  /** 逗号分隔 Origin 白名单;每项规范化校验见 auth 模块(§7.2) */
  AUTH_ALLOWED_ORIGINS: z.string().optional(),
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
)
// SEC-1 跨字段约束(docs/SEC1_AUTH_DESIGN.md §3.2):全部 fail-fast
.refine(
  (env) => env.NODE_ENV !== "production" || env.AUTH_ENABLED,
  {
    message:
      "AUTH_ENABLED must be true when NODE_ENV=production (refusing to run unauthenticated)",
    path: ["AUTH_ENABLED"],
  },
)
.refine(
  (env) =>
    !env.AUTH_ENABLED ||
    (env.AUTH_PASSWORD !== undefined && env.AUTH_PASSWORD.length >= 12),
  {
    message: "AUTH_ENABLED=true requires AUTH_PASSWORD (min 12 characters)",
    path: ["AUTH_PASSWORD"],
  },
)
.refine(
  (env) =>
    !env.AUTH_ENABLED ||
    (env.AUTH_SESSION_SECRET !== undefined &&
      env.AUTH_SESSION_SECRET.length >= 32),
  {
    message:
      "AUTH_ENABLED=true requires AUTH_SESSION_SECRET (min 32 characters)",
    path: ["AUTH_SESSION_SECRET"],
  },
)
.refine(
  (env) =>
    env.NODE_ENV !== "production" ||
    !env.AUTH_ENABLED ||
    (env.AUTH_ALLOWED_ORIGINS ?? "").trim().length > 0,
  {
    message:
      "AUTH_ENABLED=true in production requires a non-empty AUTH_ALLOWED_ORIGINS",
    path: ["AUTH_ALLOWED_ORIGINS"],
  },
)
.refine(
  (env) => {
    if (env.NODE_ENV !== "production" || !env.AUTH_ENABLED) return true;
    return (env.AUTH_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((item) => item.trim())
      .every((item) => item.length === 0 || item.startsWith("https://"));
  },
  {
    message:
      "AUTH_ALLOWED_ORIGINS must be https-only when NODE_ENV=production and AUTH_ENABLED=true",
    path: ["AUTH_ALLOWED_ORIGINS"],
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

const PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:"]);

/**
 * P8:BROWSER_PROXY_URL 校验 —— 只接受 http/https/socks5,且 URL 不得携带
 * username/password(V1 不支持 proxy credentials;错误消息不打印 URL 内容)。
 */
function isValidProxyUrl(value: string | undefined): boolean {
  if (value === undefined || value === "") {
    return true;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    PROXY_PROTOCOLS.has(url.protocol) && url.username === "" && url.password === ""
  );
}
