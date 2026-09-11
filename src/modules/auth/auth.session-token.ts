import { createHash, randomBytes } from "node:crypto";

/** 256-bit 不透明 token,entropy 全部来自 CSPRNG(V1.3 §5) */
const SESSION_TOKEN_BYTES = 32;
/** base64url(32B) 恒为 43 字符:先按长度拒绝,不为超长垃圾 Cookie 做解码/查询 */
const SESSION_TOKEN_LENGTH = 43;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

/** DB 只存摘要:库内容泄露不等于 token 可直接使用 */
export function hashSessionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * 严格校验 Cookie 里的 token(V1.3 §5):长度 / 字符集 / 解码字节数任一不符即 invalid,
 * 不进 DB 查询。V1.2 的 HMAC token 含 "." → 在此判 invalid(不抛错)。
 */
export function parseSessionToken(raw: string | undefined): string | null {
  if (typeof raw !== "string" || raw.length !== SESSION_TOKEN_LENGTH) return null;
  if (!SESSION_TOKEN_PATTERN.test(raw)) return null;
  if (Buffer.from(raw, "base64url").length !== SESSION_TOKEN_BYTES) return null;
  return raw;
}
