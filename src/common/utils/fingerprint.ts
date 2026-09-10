import { createHash } from "node:crypto";

/**
 * Idempotency fingerprint:
 * 稳定 canonical JSON(固定键序)后做 SHA-256。
 *
 * 至少包含 conversationId + content(prd §7.4)。
 *
 * M1:modelKey 只反映**客户端本次显式提交**的语义,省略时 JSON.stringify 会整体
 * 丢掉该键 → 与 V1 的指纹逐字节一致(旧客户端/重试不携带 modelKey 仍可去重)。
 * 会话偏好 preferredModelKey 永远不参与指纹(§七:重试时偏好可能已变,必须仍判幂等)。
 *
 * V1.2 I1:attachmentsDigest 同理 —— 只在携带附件时出现该键,纯文本请求的指纹
 * 与 V1/V1.1 完全一致(硬回归条件);同图必须同指纹、换图/换顺序必须换指纹。
 */
export function computeRequestFingerprint(
  conversationId: string,
  content: string,
  modelKey?: string,
  attachmentsDigest?: string,
): string {
  const canonical = JSON.stringify({ conversationId, content, modelKey, attachmentsDigest });
  return createHash("sha256").update(canonical).digest("hex");
}
