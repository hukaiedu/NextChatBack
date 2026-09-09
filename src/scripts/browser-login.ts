/**
 * P8 Provisioning CLI:在人工可见窗口(headless 强制 false)中完成 Google/Gemini
 * 登录并把登录态持久化进 BROWSER_PROFILE_DIR,供 Backend 后续复用。
 *
 * 编排(P8 设计文档 §31-E;Revision 3.1 §33 增加 ERROR 有界恢复):
 *   1. Backend 必须先停止(单 owner,同一 profile 同一时刻只允许一个持有者)
 *   2. yarn build → node dist/scripts/browser-login.js
 *   3. 打开 persistent Chromium → openGemini()
 *      READY          → already logged in → graceful stop → exit 0
 *      LOGIN_REQUIRED → 提示管理员在浏览器内登录;周期 checkGeminiSession()
 *                       → READY → success → graceful stop → exit 0
 *      ERROR          → 等待 5s 重试,最多 2 次重试(共 3 次尝试);仍 ERROR →
 *                       安全摘要(仅错误码,不输出 cookie/token/profile/HTML/代理 URL)
 *                       → graceful stop → exit 1
 *   4. 人工登录无固定超时;Ctrl+C / SIGTERM 时先 stop(close context、Chromium
 *      退出、profile flush)再退出(SIGINT → 130,SIGTERM → 143)。
 *
 * 边界:不 import main.ts、不初始化 Prisma/Scheduler/Express/Auth(浏览器专用);
 * 日志不输出 cookie/token/profile 内容/代理 URL。
 */
import type { Logger } from "../common/logger/logger.js";
import { createLogger } from "../common/logger/logger.js";
import { parseEnv } from "../config/env.js";
import type { BrowserProviderStatus } from "../providers/gemini/browser-driver.js";
import { BrowserManager } from "../providers/gemini/browser-manager.js";
import { createDriver } from "../providers/gemini/create-driver.js";

/** 人工登录期间对 checkGeminiSession 的轮询间隔(独立于 P8-FIX-01 的 250ms 水合轮询) */
const LOGIN_POLL_MS = 750;
/** openGemini 返回 ERROR 时的重试延迟(§33;测试可缩短) */
const ERROR_RETRY_DELAY_MS = 5_000;
/** openGemini ERROR 最大重试次数(§33;总尝试 = 1 + 重试次数,不无限重试) */
const MAX_ERROR_RETRIES = 2;

export type BrowserLoginOutcome = "READY" | "CANCELLED";

export interface BrowserLoginOptions {
  /** checkGeminiSession 轮询间隔(默认 750ms;测试可缩短) */
  pollIntervalMs?: number;
  /** openGemini 返回 ERROR 时的重试延迟(默认 5000ms;测试可缩短) */
  errorRetryDelayMs?: number;
  /** openGemini ERROR 最大重试次数(默认 2) */
  maxErrorRetries?: number;
  /** 返回 true = 已收到终止信号(调用方负责 stop + exit) */
  isCancelled?: () => boolean;
}

/**
 * Provisioning 业务编排(可单测;进程信号/退出码由 main() 负责)。
 * launch 抛错(profile 占用/环境类)原样上抛;openGemini 返回 ERROR 时进入
 * 有界重试(§33):最多 maxErrorRetries 次重试仍 ERROR → 抛安全摘要错误。
 */
export async function runBrowserLogin(
  manager: BrowserManager,
  logger: Logger,
  options: BrowserLoginOptions = {},
): Promise<BrowserLoginOutcome> {
  const pollMs = options.pollIntervalMs ?? LOGIN_POLL_MS;
  const errorRetryDelayMs = options.errorRetryDelayMs ?? ERROR_RETRY_DELAY_MS;
  const maxRetries = options.maxErrorRetries ?? MAX_ERROR_RETRIES;
  const cancelled = () => options.isCancelled?.() ?? false;

  let status: BrowserProviderStatus = "ERROR";
  for (let attempt = 0; ; attempt++) {
    status = await manager.openGemini();
    if (status !== "ERROR" || attempt >= maxRetries) {
      break;
    }
    if (cancelled()) {
      return "CANCELLED";
    }
    logger.warn(
      { attempt: attempt + 1, maxRetries, retryDelayMs: errorRetryDelayMs },
      "gemini open failed with ERROR; retrying",
    );
    await sleep(errorRetryDelayMs);
    if (cancelled()) {
      return "CANCELLED";
    }
  }
  if (status === "READY") {
    logger.info("already logged in; closing browser");
    return "READY";
  }
  if (status !== "LOGIN_REQUIRED") {
    // ERROR 重试耗尽的安全摘要:只带错误码,不含 cookie/token/profile/HTML/代理 URL
    const lastError = manager.getLastBrowserError();
    const code = lastError?.code ? ` (${lastError.code})` : "";
    throw new Error(
      `gemini browser open failed: ${status}${code}; check network/Gemini page state and re-run browser:login`,
    );
  }
  logger.info(
    "login required: please sign in to Google/Gemini in the browser window (Ctrl+C to abort)",
  );
  for (;;) {
    if (cancelled()) {
      return "CANCELLED";
    }
    const current = await manager.checkGeminiSession();
    if (current === "READY") {
      logger.info("success: Gemini login detected");
      return "READY";
    }
    if (current !== "LOGIN_REQUIRED") {
      if (cancelled()) {
        return "CANCELLED";
      }
      // 生命周期故障(STOPPED/ERROR):浏览器被关闭或崩溃,不是登录等待路径
      throw new Error(`unexpected browser status while waiting for login: ${current}`);
    }
    await sleep(pollMs);
  }
}

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const logger = createLogger(env.LOG_LEVEL);
  const manager = new BrowserManager({
    driver: createDriver(env),
    // Provisioning 强制 headed:人工登录需要可见窗口,不受 BROWSER_HEADLESS 影响
    profileDir: env.BROWSER_PROFILE_DIR,
    headless: false,
    geminiBaseUrl: env.GEMINI_BASE_URL,
    logger,
  });

  let stopping = false;
  const stopAndExit = async (exitCode: number): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    try {
      await manager.stop();
      logger.info("browser stopped");
    } catch (err) {
      logger.error({ err }, "error while stopping browser");
    }
    process.exit(exitCode);
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, "received signal; stopping browser");
    void stopAndExit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const outcome = await runBrowserLogin(manager, logger, {
      isCancelled: () => stopping,
    });
    if (outcome === "CANCELLED") {
      return; // 终止信号路径已由 stopAndExit 收口(exit 130/143)
    }
    await stopAndExit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "browser login failed");
    // profile ownership 类错误只报告,不删除 lock / 不重建 profile
    process.stderr.write(`browser login failed: ${message}\n`);
    await stopAndExit(1);
  }
}

// 仅当以 `node dist/scripts/browser-login.js` 直接启动时执行 main();
// vitest 单测 import 本模块不得触发浏览器 boot。dist 为 CJS 而 vitest 以 ESM
// 加载源码,require.main 与 import.meta 均不可移植,故按 argv[1] 路径尾部判定。
const argvEntry = process.argv[1];
if (argvEntry?.split(/[\\/]/).slice(-2).join("/") === "scripts/browser-login.js") {
  void main();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
