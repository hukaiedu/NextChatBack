import type { ModelRequestModel } from "../../generated/prisma/models.js";
import { toPublicError } from "../../common/errors/public-error.js";

/**
 * V1.3-B3-2:Public Request DTO(GET /api/requests/:id、cancel、发送结果里的 request)。
 *
 * 禁止外发的是「服务端怎么实现的」:provider / requestedModelKey / resolvedModelKey /
 * resolvedModelLabel(自动化与模型解析细节)、idempotencyKey(客户端自造的键,回显等于
 * 替别人确认某个键已被使用)、requestFingerprint(内容指纹,可由明文重算)、
 * attemptCount / startedAt / completedAt(重试与执行时序)。
 * errorCode / errorMessage 保留键位但值经 toPublicError 收口(§18)。
 */
export interface PublicRequest {
  id: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  /** V1.2 I3.5:历史图片份数判据,前端占位渲染依赖它 */
  attachmentCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 失败原因的 Public 表达。errorCode 为 null = 没有错误,此时 errorMessage 也必须为 null,
 * 不能留下「无码有文」的形状。
 */
export function publicErrorOf(
  errorCode: string | null,
  errorMessage: string | null,
): { errorCode: string | null; errorMessage: string | null } {
  if (errorCode === null) {
    return { errorCode: null, errorMessage: null };
  }
  const mapped = toPublicError(errorCode, errorMessage ?? "");
  return { errorCode: mapped.code, errorMessage: mapped.message };
}

export function toPublicRequest(request: ModelRequestModel): PublicRequest {
  return {
    id: request.id,
    conversationId: request.conversationId,
    userMessageId: request.userMessageId,
    assistantMessageId: request.assistantMessageId,
    status: request.status,
    ...publicErrorOf(request.errorCode, request.errorMessage),
    attachmentCount: request.attachmentCount,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}
