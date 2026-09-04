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

/**
 * Playwright 原始异常中「Context/浏览器进程已关闭或崩溃」的识别(§8.8 竞态)。
 *
 * Context 崩溃时,BrowserManager 的 PROVIDER_BROWSER_CRASHED 粘性故障码要等
 * onClose/onCrash 事件异步写入;执行异常可能先于事件到达 Scheduler,只认粘性码
 * 会漏成 INTERNAL_ERROR(长稳 108 轮出现 1 次)。按 Playwright 关闭/崩溃文案识别,
 * 并下钻 cause 链(adapter 会把原始异常包进 domChanged/navigationFailed 的 cause),
 * 让「事件先到」与「异常先到」两种顺序都稳定归类 PROVIDER_BROWSER_CRASHED。
 * 只匹配框架文案,不匹配业务消息(pageClosed() 的 "Gemini page was closed" 等),
 * 主动关页不会误判成进程崩溃。
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
