import { ErrorCodes } from "./error-codes.js";
import type { ErrorCode } from "./error-codes.js";

/**
 * V1.3-B3-2:Public 错误抽象 —— 全仓唯一映射点。
 *
 * 数据库、日志、Scheduler、Provider 内部继续保留真实 errorCode / errorMessage(§18:
 * 管理员与线上调试要靠原始值,把 DB 也改成 CHAT_FAILED 等于自毁可观测性)。
 * 本模块只改变三处外部可见面:Public HTTP 错误信封、Public SSE 帧、Public DTO 字段。
 *
 * 禁止在 Controller / Service 里各写一份映射:新增内部码时只需在下方归类。
 */
export const PublicErrorCodes = {
  CHAT_FAILED: "CHAT_FAILED",
  SERVICE_BUSY: "SERVICE_BUSY",
  REQUEST_TIMEOUT: "REQUEST_TIMEOUT",
} as const;

export type PublicErrorCode =
  | ErrorCode
  | (typeof PublicErrorCodes)[keyof typeof PublicErrorCodes];

/** 稳定通用文本:绝不拼接 Provider 原始 message(§13) */
const GENERIC_MESSAGE: Record<keyof typeof PublicErrorCodes, string> = {
  CHAT_FAILED: "Chat request failed.",
  SERVICE_BUSY: "Service is busy. Please try again.",
  REQUEST_TIMEOUT: "Request timed out. Please try again.",
};

/**
 * 允许原样透传的码(§14:allowlist 由本仓 error-codes.ts 真实枚举产生)。
 * 判据是「这条错误本身就在描述用户能理解、且需要据此决策的客户端状态」,
 * 而不是「它像不像服务端故障」:身份与请求合法性、会话与 Request 的业务状态、
 * 幂等冲突、附件的请求侧限制都属此类。
 *
 * V1.3-C:Public 面 **PROVIDER_\* = 0**。曾经唯一的例外 PROVIDER_NOT_READY 是
 * 兼容窗口产物(FIX-02D),前端 canonical 迁移完成后已改归类 SERVICE_BUSY;
 * Provider/Browser 的实现细节一律折进三个通用码,原码只在 Admin surface 保留。
 */
const PASSTHROUGH: ReadonlySet<string> = new Set<string>([
  ErrorCodes.VALIDATION_ERROR,
  ErrorCodes.PAYLOAD_TOO_LARGE,
  ErrorCodes.AUTH_REQUIRED,
  ErrorCodes.AUTH_INVALID_CREDENTIALS,
  ErrorCodes.AUTH_RATE_LIMITED,
  ErrorCodes.AUTH_CSRF_REJECTED,
  ErrorCodes.AUTH_FORBIDDEN,
  ErrorCodes.CONVERSATION_NOT_FOUND,
  ErrorCodes.CONVERSATION_DELETED,
  ErrorCodes.CONVERSATION_ARCHIVED,
  ErrorCodes.CONVERSATION_REQUEST_IN_PROGRESS,
  ErrorCodes.REQUEST_NOT_FOUND,
  ErrorCodes.REQUEST_NOT_CANCELLABLE,
  ErrorCodes.IDEMPOTENCY_KEY_REUSED,
  ErrorCodes.ATTACHMENT_TOO_LARGE,
  ErrorCodes.UNSUPPORTED_ATTACHMENT_TYPE,
  // 三个通用码本身就是对外码:透传即恒等,保证映射可安全叠加(二次映射不会降级)
  PublicErrorCodes.CHAT_FAILED,
  PublicErrorCodes.SERVICE_BUSY,
  PublicErrorCodes.REQUEST_TIMEOUT,
]);

/** 容量 / 排队 / Provider 未就绪类:入口拒绝,用户稍后重试即可(§15;P6 配额尚未实现,不在此创建 quota 语义) */
const SERVICE_BUSY: ReadonlySet<string> = new Set<string>([
  ErrorCodes.PROVIDER_RATE_LIMITED,
  ErrorCodes.ATTACHMENT_CAPACITY_EXCEEDED,
  ErrorCodes.PROVIDER_NOT_READY,
]);

/** 超时类:同类统一(§16) */
const REQUEST_TIMEOUT: ReadonlySet<string> = new Set<string>([
  ErrorCodes.PROVIDER_RESPONSE_TIMEOUT,
  ErrorCodes.PROVIDER_CANCELLATION_UNCONFIRMED,
  ErrorCodes.PROVIDER_ATTACHMENT_TIMEOUT,
  ErrorCodes.BROWSER_RESTART_TIMEOUT,
]);

export interface PublicError {
  code: PublicErrorCode;
  message: string;
}

/**
 * 只改 code 与 message,不改 HTTP 状态:状态码仍由原始码经 error-code-map 推导,
 * 这样 502 / 503 / 504 的语义差别对客户端保持一致。
 *
 * internal=true 用于 **Admin API surface** 的 HTTP 错误信封:运维端点需要原码才能判断是
 * Profile 被占用还是重启超时(§32「ADMIN → 原正常行为」)。该分支只由 error-handler 依据
 * `errorExposureOf(res)` 打开(FIX-02A:判据是 surface,不是 userType)——
 * ADMIN 调 Public 路由不会走到这里。Public DTO 与 SSE 恒为 false。
 */
export function toPublicError(
  code: string,
  message: string,
  opts: { internal?: boolean } = {},
): PublicError {
  if (isPassthroughCode(code)) {
    return { code, message };
  }
  if (opts.internal === true) {
    // 唯一内部分支调用方是 error-handler,它传入的必定是 AppError.code(ErrorCode 枚举值)。
    // Admin surface 要看的是原码,这里不重新分类,也不新增码。
    return { code: code as ErrorCode, message };
  }
  const generic = classify(code);
  return { code: generic, message: GENERIC_MESSAGE[generic] };
}

/** 运行时事实(集合成员判定)→ 类型收窄,避免在透传路径上写断言 */
function isPassthroughCode(code: string): code is PublicErrorCode {
  return PASSTHROUGH.has(code);
}

function classify(code: string): keyof typeof PublicErrorCodes {
  if (SERVICE_BUSY.has(code)) {
    return PublicErrorCodes.SERVICE_BUSY;
  }
  if (REQUEST_TIMEOUT.has(code)) {
    return PublicErrorCodes.REQUEST_TIMEOUT;
  }
  // 其余 PROVIDER_* / BROWSER_* / STREAMING_* / SERVER_RESTARTED_* / DATABASE_* / INTERNAL_*
  return PublicErrorCodes.CHAT_FAILED;
}
