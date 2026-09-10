import { expect } from "vitest";

import type { AttachmentStore } from "../src/modules/request/request.attachment-store.js";
import type { RawAttachment } from "../src/modules/message/attachment.js";

/**
 * V1.2 I1 附件测试夹具:构造「magic byte 合法」的伪图片。
 *
 * 后端契约只认声明类型与真实字节是否自洽(§二),不验图片能否解码显示 —— 所以这里不需要
 * 真 PNG,也就不会留下「测试恰好依赖某张图的编码」这种隐形耦合。
 */

const SIGNATURES: Record<string, Buffer> = {
  "image/png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  "image/gif": Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
  "image/webp": Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from("WEBP", "ascii"),
  ]),
};

export const ATTACHMENT_TYPES = Object.keys(SIGNATURES);

/** 以正确 magic byte 开头、总长 size 字节的伪图片 */
export function attachmentImage(mimeType: string, size = 64): Buffer {
  const head = SIGNATURES[mimeType];
  if (head === undefined) {
    throw new Error(`no fixture signature for ${mimeType}`);
  }
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 0x61)]);
}

/** 自洽的合法附件:声明类型 = dataURL 前缀 = 真实字节的 magic */
export function attachment(mimeType = "image/png", size = 64, name = "pic.bin"): RawAttachment {
  return {
    name,
    mimeType,
    data: `data:${mimeType};base64,${attachmentImage(mimeType, size).toString("base64")}`,
  };
}

/** 一批附件解码后的总字节数 —— 与 AttachmentStore 的 byteSize 同一口径,才能对账 */
export function decodedBytes(items: RawAttachment[]): number {
  return items.reduce(
    (sum, item) => sum + Buffer.from(item.data.slice(item.data.indexOf(",") + 1), "base64").length,
    0,
  );
}

/** 容器唯一账本判据:liveBytes === Σ slot.byteSize */
export function expectAttachmentInvariant(store: AttachmentStore): void {
  const stats = store.stats();
  expect(stats.liveBytes).toBe(stats.slots.reduce((sum, slot) => sum + slot.byteSize, 0));
  expect(stats.slotCount).toBe(stats.slots.length);
}
