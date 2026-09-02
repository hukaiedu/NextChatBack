import { createHash } from "node:crypto";

/**
 * Idempotency fingerprint:
 * 稳定 canonical JSON(固定键序)后做 SHA-256。
 *
 * 至少包含 conversationId + content(prd §7.4)。
 */
export function computeRequestFingerprint(conversationId: string, content: string): string {
  const canonical = JSON.stringify({ conversationId, content });
  return createHash("sha256").update(canonical).digest("hex");
}
