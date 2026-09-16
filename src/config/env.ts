import { z } from "zod";

import { AppError } from "../common/errors/app-error.js";
import { ErrorCodes } from "../common/errors/error-codes.js";
import {
  ANONYMOUS_IP_LIMIT_PER_DAY,
  ANONYMOUS_IP_LIMIT_PER_HOUR,
  AUTH_ARGON2_MAX_CONCURRENCY,
  CHAT_SUBMIT_RATE_LIMIT_PER_MINUTE,
  GLOBAL_MAX_PENDING_REQUESTS,
  REGISTER_IP_MAX_ATTEMPTS,
  SESSION_TTL_REGISTERED_SECONDS,
  USER_LOGIN_IP_MAX_FAILURES,
  USER_MAX_ACTIVE_REQUESTS,
  USER_MAX_PENDING_REQUESTS,
} from "./constants.js";

/** "true"/"false" → boolean(z.coerce.boolean 会把 "false" 变 true,不能用) */
const boolFromString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

/** V1.3 §17:AUTH_ENABLED=false 的唯一合法监听地址集合 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  /** 仅 NODE_ENV=test 可显式开启的本地 E2E fake provider;生产环境 fail-closed */
  E2E_FAKE_PROVIDER: boolFromString.default("false"),
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

  // SEC-1 服务端鉴权(docs/SEC1_AUTH_DESIGN.md §3.3)+ V1.3 多用户 Session(docs/V13A_MULTIUSER_DESIGN.md §15)
  AUTH_ENABLED: boolFromString.default("false"),
  /** AUTH_ENABLED=true 时必填;min 12 门槛在 refine 中按开关条件执行 */
  AUTH_PASSWORD: z.string().optional(),
  /** V1.3 §15:ADMIN Session TTL(秒),滑动续期上限。B2 起本项语义从全局 TTL 改为 ADMIN TTL */
  AUTH_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(2_592_000)
    .default(604_800),
  /** V1.3 §15:ANONYMOUS Session TTL(秒),默认 30 天 */
  AUTH_SESSION_TTL_ANONYMOUS_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(2_592_000)
    .default(2_592_000),
  /**
   * V1.4 U2 §7:REGISTERED Session TTL(秒),默认 30 天。
   * 独立 env 是刻意的:数值与匿名相同不代表可以复用同一份契约 —— 身份等级不同,
   * 运维必须能单独收紧注册账号而不影响匿名访客。
   */
  AUTH_SESSION_TTL_REGISTERED_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(2_592_000)
    .default(SESSION_TTL_REGISTERED_SECONDS),
  /** V1.3 §13:滑动续期阈值(秒):lastSeenAt 超过该间隔才写库续期并重发 Set-Cookie */
  AUTH_SESSION_TOUCH_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(3_600),
  /** 只影响 req.ip(登录限流键/审计),不影响 Cookie Secure */
  AUTH_TRUST_PROXY: boolFromString.default("false"),
  /** 逗号分隔 Origin 白名单;每项规范化校验见 auth 模块(§7.2) */
  AUTH_ALLOWED_ORIGINS: z.string().optional(),
  /** D1C:进程内 Argon2 fail-fast 并发容量,不进数据库 */
  AUTH_ARGON2_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(AUTH_ARGON2_MAX_CONCURRENCY),

  // —— V1.3 P6 入口防刷与队列容量(§11/§12:全部 env → runtime config,不进数据库)——
  /** 同一 IP 每小时可新建多少个匿名身份(见任务书 Abuse-01:保护「创建」而非「使用」) */
  AUTH_ANONYMOUS_IP_LIMIT_PER_HOUR: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(ANONYMOUS_IP_LIMIT_PER_HOUR),
  /** 同一 IP 每 24 小时可新建多少个匿名身份(小时窗口防快刷,天窗口防慢刷) */
  AUTH_ANONYMOUS_IP_LIMIT_PER_DAY: z.coerce
    .number()
    .int()
    .min(1)
    .max(100_000)
    .default(ANONYMOUS_IP_LIMIT_PER_DAY),
  /**
   * V1.4 U2:同一 IP 在 Registered 登录窗口内允许多少次**失败**(用户名不存在与密码错误都算)。
   * 窗口长度沿用常量体系(USER_LOGIN_IP_MAX_FAILURES 对应的 USER_LOGIN_IP_WINDOW_MS);
   * 与 ADMIN 登录 limiter 是独立的两个桶。
   */
  AUTH_USER_LOGIN_IP_MAX_FAILURES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000)
    .default(USER_LOGIN_IP_MAX_FAILURES),
  /**
   * V1.4 U2:同一 IP 在注册窗口内允许多少次**尝试**。
   * 刻意计尝试而非失败:Argon2id 的 CPU 成本在进入请求时就已产生,与结果无关。
   */
  AUTH_REGISTER_IP_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000)
    .default(REGISTER_IP_MAX_ATTEMPTS),
  /** 单用户每分钟提交消息上限(键 = req.auth.userId,ADMIN/COMPAT 不绕过) */
  CHAT_SUBMIT_RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(CHAT_SUBMIT_RATE_LIMIT_PER_MINUTE),
  /** 单用户 PENDING Request 上限(队列容量,不是频率) */
  USER_MAX_PENDING_REQUESTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(USER_MAX_PENDING_REQUESTS),
  /** 单用户在飞(PROCESSING/CANCELLING)上限;单 worker 下 >1 不提高并行度,只是未来边界 */
  USER_MAX_ACTIVE_REQUESTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .default(USER_MAX_ACTIVE_REQUESTS),
  /** 全库 PENDING Request 上限(服务容量) */
  GLOBAL_MAX_PENDING_REQUESTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(GLOBAL_MAX_PENDING_REQUESTS),
}).refine(
  // V1.4 U2 §25:续期阈值必须严格小于 REGISTERED TTL,否则「滑动续期」名存实亡 ——
  // 需要写库续期的时点永远落在 Session 已过期之后,注册账号反而会比匿名更早掉线。
  (env) => env.AUTH_SESSION_TTL_REGISTERED_SECONDS > env.AUTH_SESSION_TOUCH_INTERVAL_SECONDS,
  {
    message:
      "AUTH_SESSION_TTL_REGISTERED_SECONDS must be greater than AUTH_SESSION_TOUCH_INTERVAL_SECONDS",
    path: ["AUTH_SESSION_TTL_REGISTERED_SECONDS"],
  },
).refine(
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
  (env) => !env.E2E_FAKE_PROVIDER || env.NODE_ENV === "test",
  {
    message: "E2E_FAKE_PROVIDER=true requires NODE_ENV=test",
    path: ["E2E_FAKE_PROVIDER"],
  },
)
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
// V1.3 §17:AUTH_ENABLED=false 只允许 loopback 监听 —— 免鉴权 + 网络可达 = 误暴露;
// 要绑 0.0.0.0 就必须启用 AUTH(不自动改 HOST,让开发者显式二选一)
.refine((env) => env.AUTH_ENABLED || LOOPBACK_HOSTS.has(env.HOST.trim().toLowerCase()), {
  message:
    "AUTH_ENABLED=false requires HOST to be loopback (127.0.0.1/::1/localhost): " +
    "refusing to expose the unauthenticated COMPAT mode on the network — enable AUTH or bind loopback",
  path: ["HOST"],
})
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
