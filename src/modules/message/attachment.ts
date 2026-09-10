import { createHash } from "node:crypto";

import { AppError } from "../../common/errors/app-error.js";
import { ErrorCodes } from "../../common/errors/error-codes.js";
import {
  ATTACHMENT_DATA_URL_MAX_LENGTH,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_NAME_MAX_LENGTH,
  ATTACHMENT_TOTAL_MAX_BYTES,
} from "../../config/constants.js";
import type { AttachmentMimeType } from "../../config/constants.js";

/**
 * 附件 payload 的独立复核(I0.1 §4.3 规则 6–8)。
 *
 * 纯函数:不写盘、不碰 DB、不碰 Provider、无全局状态。
 * 一切以**解码后的真实字节**为准 —— 声明的 `mimeType` 与 magic byte 不一致即拒,
 * 所以前端 `compressImage()` 恒输出 JPEG 也不会出现「选了合法图片却被 415」:
 * 前端只要按规则 2 从最终 dataURL 前缀取 MIME,两侧就必然一致。
 */

/** 复核通过的附件:字节已在内存,可直接交给 Provider 注入(I2-B 的输入形状) */
export interface AttachmentFile {
  name: string;
  mimeType: AttachmentMimeType;
  buffer: Buffer;
}

/** HTTP body 里的原始附件声明:未经信任,只能作为本模块的输入 */
export interface RawAttachment {
  name: string;
  mimeType: string;
  data: string;
}

/** 控制字符(含 DEL):清洗文件名时一律剥除 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

const MIME_BY_PREFIX: Record<string, AttachmentMimeType> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
};

/** magic byte 判据:PNG 89 50 4E 47 / JPEG FF D8 FF / GIF 47 49 46 38 / WEBP RIFF....WEBP */
function matchesSignature(mimeType: AttachmentMimeType, bytes: Buffer): boolean {
  switch (mimeType) {
    case "image/png":
      return bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    case "image/jpeg":
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/gif":
      return bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38;
    case "image/webp":
      return (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP"
      );
  }
}

/**
 * 文件名只作展示与 Provider 侧的文件名,永不参与类型判据(I0 §13)。
 * 取 basename、剥控制字符、限长;清洗后为空则视为非法输入。
 */
export function sanitizeAttachmentName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(CONTROL_CHARS, "").trim();
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, "attachment name must not be empty");
  }
  return cleaned.slice(0, ATTACHMENT_NAME_MAX_LENGTH);
}

/**
 * 单个 dataURL → 已复核的字节。
 * 前缀形状非法 → 400;类型不在白名单或字节与声明不符 → 415;超限 → 413。
 */
function toAttachmentFile(raw: RawAttachment): AttachmentFile {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(raw.data);
  if (!match) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      "attachment data must be a data:image/...;base64 data URL",
    );
  }
  const [, declaredDataMime, payload] = match;
  const mimeType = MIME_BY_PREFIX[declaredDataMime ?? ""];
  if (mimeType === undefined) {
    throw new AppError(
      ErrorCodes.UNSUPPORTED_ATTACHMENT_TYPE,
      `attachment type ${declaredDataMime} is not supported`,
    );
  }
  // 客户端声明的 MIME 与 dataURL 前缀必须同一条:两者不一致说明payload 被改过
  if (raw.mimeType !== mimeType) {
    throw new AppError(
      ErrorCodes.UNSUPPORTED_ATTACHMENT_TYPE,
      "attachment mimeType does not match its data URL prefix",
    );
  }
  if (payload === undefined || payload.length > ATTACHMENT_DATA_URL_MAX_LENGTH) {
    throw new AppError(ErrorCodes.ATTACHMENT_TOO_LARGE, "attachment exceeds the single-file size limit");
  }
  if (payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, "attachment data is not valid base64");
  }
  const buffer = Buffer.from(payload, "base64");
  if (buffer.length === 0) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, "attachment data decodes to zero bytes");
  }
  if (buffer.length > ATTACHMENT_MAX_BYTES) {
    throw new AppError(ErrorCodes.ATTACHMENT_TOO_LARGE, "attachment exceeds the single-file size limit");
  }
  if (!matchesSignature(mimeType, buffer)) {
    throw new AppError(
      ErrorCodes.UNSUPPORTED_ATTACHMENT_TYPE,
      "attachment bytes do not match the declared image type",
    );
  }
  return { name: sanitizeAttachmentName(raw.name), mimeType, buffer };
}

/**
 * 整批附件校验。`undefined` 与 `[]` 一律返回 `undefined`,
 * 让纯文本路径拿到与今天逐字节相同的输入(§1「attachments 缺省时行为完全不变」)。
 */
export function parseAttachments(raw: RawAttachment[] | undefined): AttachmentFile[] | undefined {
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  if (raw.length > ATTACHMENT_MAX_COUNT) {
    throw new AppError(ErrorCodes.ATTACHMENT_TOO_LARGE, "too many attachments");
  }
  const files = raw.map(toAttachmentFile);
  const total = files.reduce((sum, file) => sum + file.buffer.length, 0);
  if (total > ATTACHMENT_TOTAL_MAX_BYTES) {
    throw new AppError(ErrorCodes.ATTACHMENT_TOO_LARGE, "attachments exceed the total size limit");
  }
  return files;
}

/**
 * 附件指纹:顺序敏感的嵌套摘要 —— `sha256(⊕ sha256(fileᵢ))`。
 *
 * 只用于幂等指纹(内容变了必须算新请求),不写库、不外露。
 * 顺序敏感是刻意的:同两张图换顺序 = 不同的 Provider 提问。
 */
export function computeAttachmentsDigest(files: AttachmentFile[]): string {
  const perFile = files.map((file) => createHash("sha256").update(file.buffer).digest("hex"));
  return createHash("sha256").update(perFile.join("")).digest("hex");
}
