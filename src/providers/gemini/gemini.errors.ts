import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";

/**
 * Gemini 自动化层错误(prd §12.13 统一错误码)。
 * HTTP 状态由 error-code-map 按错误码统一推导,这里不再指定。
 *
 * 约定:message 只描述页面状态与选择器名,禁止包含 Prompt 原文、回答原文或未脱敏 URL
 * (prd §14 日志禁止记录)。完整原始异常放 cause,由统一错误出口只写服务端日志。
 */

/** 导航失败:打不开新会话首页或已保存的会话地址 */
export function navigationFailed(cause?: unknown): AppError {
  return new AppError(ErrorCodes.PROVIDER_NAVIGATION_FAILED, "Failed to open Gemini page", cause);
}

/** 登录态失效:自动化必须停止,由人工重新登录(原则 27),禁止代填 */
export function loginRequired(cause?: unknown): AppError {
  return new AppError(ErrorCodes.PROVIDER_LOGIN_REQUIRED, "Gemini login is required", cause);
}

/** 执行途中页面被关掉了:本次结果未知,禁止自动重试(原则 30) */
export function pageClosed(): AppError {
  return new AppError(ErrorCodes.PROVIDER_PAGE_CLOSED, "Gemini page was closed during execution");
}

/**
 * 页面结构与预期不符(输入框未出现、Prompt 未被接受、始终拿不到会话 URL 等)。
 * detail 只允许是选择器名/页面状态名,不得带用户内容。
 */
export function domChanged(detail: string, cause?: unknown): AppError {
  return new AppError(
    ErrorCodes.PROVIDER_DOM_CHANGED,
    `Gemini page does not match expected structure: ${detail}`,
    cause,
  );
}

/** 回答在上限内没有稳定下来 */
export function responseTimeout(timeoutMs: number): AppError {
  return new AppError(
    ErrorCodes.PROVIDER_RESPONSE_TIMEOUT,
    `Gemini answer did not settle within ${timeoutMs}ms`,
  );
}

/** 已保存的 Gemini 会话不可用(被删除 / 失效 / 被重定向);此时禁止自动新建会话 */
export function conversationUnavailable(): AppError {
  return new AppError(
    ErrorCodes.PROVIDER_CONVERSATION_UNAVAILABLE,
    "Gemini conversation is no longer available",
  );
}

/** Chromium 进程 / Context / renderer 崩溃(prd §12.2/§12.13) */
export function browserCrashed(fault: string, cause?: unknown): AppError {
  return new AppError(
    ErrorCodes.PROVIDER_BROWSER_CRASHED,
    `Browser crashed (${fault})`,
    cause,
  );
}

/** 已调用 Gemini stop 但在超时内无法确认真的停了 → FAILED + Browser 重建 */
export function cancellationUnconfirmed(): AppError {
  return new AppError(
    ErrorCodes.PROVIDER_CANCELLATION_UNCONFIRMED,
    "Could not confirm that Gemini stopped generating within the timeout",
  );
}

/** M1:请求的模型键不在当前模型目录中 */
export function modelUnavailable(key: string): AppError {
  return new AppError(ErrorCodes.PROVIDER_MODEL_UNAVAILABLE, `Model is not available: ${key}`);
}

/** M1:读取模型目录 / 切换模型失败(detail 只允许选择器名/页面状态名) */
export function modelSwitchFailed(detail: string, cause?: unknown): AppError {
  return new AppError(
    ErrorCodes.PROVIDER_MODEL_SWITCH_FAILED,
    `Gemini model menu operation failed: ${detail}`,
    cause,
  );
}

/**
 * Playwright 原始异常的「关闭族」检测(§8.8 竞态)。
 *
 * Context/浏览器崩溃断开、以及 Gemini Page 被单独关闭时,Playwright 都可能直接抛出
 * 这类文案(如 "Target page, context or browser has been closed")—— 文案无法区分
 * 两者,因此本函数只负责「是否属于关闭族」,归类由 Scheduler 结合 BrowserManager
 * 的 Page/Context 状态与 sticky fault 裁定(仅 Page 关闭 → PROVIDER_PAGE_CLOSED,
 * Context/浏览器崩溃断开 → PROVIDER_BROWSER_CRASHED)。
 * 检测下钻 cause 链(adapter 会把原始异常包进 domChanged/navigationFailed 的 cause)。
 * 只匹配框架文案,不匹配业务消息(pageClosed() 的 "Gemini page was closed" 等)。
 */
const CONTEXT_CLOSED_MARKERS = [
  "target closed",
  "target page, context or browser has been closed",
  "browser has been closed",
  "browser has disconnected",
  "target crashed",
  "page crashed",
  "session closed",
] as const;

/** cause 链下钻上限(err 本身之外再查 4 层),防构造环导致死循环 */
const CONTEXT_CLOSED_MAX_CAUSE_DEPTH = 4;

export function isContextClosedError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth <= CONTEXT_CLOSED_MAX_CAUSE_DEPTH; depth++) {
    if (!(current instanceof Error)) {
      return false;
    }
    const message = current.message.toLowerCase();
    if (CONTEXT_CLOSED_MARKERS.some((marker) => message.includes(marker))) {
      return true;
    }
    current = current.cause;
  }
  return false;
}
