import { describe, expect, it } from "vitest";

import { AppError } from "../../src/common/errors/app-error.js";
import { ATTACHMENT_MAX_BYTES } from "../../src/config/constants.js";
import {
  computeAttachmentsDigest,
  parseAttachments,
  sanitizeAttachmentName,
} from "../../src/modules/message/attachment.js";
import type { AttachmentFile, RawAttachment } from "../../src/modules/message/attachment.js";
import { attachment, attachmentImage } from "../attachment-fixtures.js";

/**
 * V1.2 I1 §二 / §十八:附件 payload 的独立复核(纯函数层)。
 *
 * 全部输入都是构造出来的字节,不依赖任何真图;判据只看 magic byte 与声明是否自洽。
 * 断言同时锁 HTTP 状态 —— 错误码与状态码由 error-code-map 单点推导,这里防止它被改回去。
 */

/** 任意形状的 payload:合法与非法都靠调用方拼,用于「声明与字节不一致」这类用例 */
function rawUrl(mimeType: string, bytes: Buffer, name = "pic.bin"): RawAttachment {
  return { name, mimeType, data: `data:${mimeType};base64,${bytes.toString("base64")}` };
}

/** 单张自洽合法图 */
function one(mimeType = "image/png", size = 64): RawAttachment[] {
  return [attachment(mimeType, size)];
}

function errorCodeOf(run: () => unknown): { code: string; status: number } {
  try {
    run();
  } catch (err) {
    if (err instanceof AppError) {
      return { code: err.code, status: err.statusCode };
    }
    throw err;
  }
  throw new Error("expected parseAttachments to throw");
}

describe("parseAttachments —— 类型与形状", () => {
  it("ATT-P-01 四种白名单类型各自通过,且返回解码后的真实字节", () => {
    for (const mimeType of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      const files = parseAttachments(one(mimeType)) as AttachmentFile[];
      expect(files).toHaveLength(1);
      expect(files[0]!.mimeType).toBe(mimeType);
      expect(files[0]!.name).toBe("pic.bin");
      expect(files[0]!.buffer.subarray(0, 4)).toEqual(attachmentImage(mimeType).subarray(0, 4));
    }
  });

  it("ATT-P-02 缺省与空数组一律归一成 undefined(纯文本路径零变化)", () => {
    expect(parseAttachments(undefined)).toBeUndefined();
    expect(parseAttachments([])).toBeUndefined();
  });

  it("ATT-P-03 dataURL 前缀类型不在白名单 → 415 UNSUPPORTED_ATTACHMENT_TYPE", () => {
    const bmp = rawUrl("image/bmp", Buffer.from([0x42, 0x4d, 0x00, 0x00]));
    expect(errorCodeOf(() => parseAttachments([bmp]))).toEqual({
      code: "UNSUPPORTED_ATTACHMENT_TYPE",
      status: 415,
    });
  });

  it("ATT-P-04 非 dataURL 形状(裸 base64 / http 地址 / 缺 ;base64)→ 400 VALIDATION_ERROR", () => {
    for (const data of [
      attachmentImage("image/png").toString("base64"),
      "https://example.com/a.png",
      "data:image/png,aGVsbG8=",
      "data:;base64,aGVsbG8=",
    ]) {
      expect(errorCodeOf(() => parseAttachments([{ name: "a.png", mimeType: "image/png", data }])))
        .toEqual({ code: "VALIDATION_ERROR", status: 400 });
    }
  });

  it("ATT-P-05 声明 mimeType 与 dataURL 前缀不一致 → 415", () => {
    const mismatched = { ...rawUrl("image/png", attachmentImage("image/png")), mimeType: "image/jpeg" };
    expect(errorCodeOf(() => parseAttachments([mismatched]))).toEqual({
      code: "UNSUPPORTED_ATTACHMENT_TYPE",
      status: 415,
    });
  });

  it("ATT-P-06 真实字节与声明类型不符(PNG 前缀 + JPEG 头)→ 415", () => {
    const lying = rawUrl(
      "image/png",
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32)]),
    );
    expect(errorCodeOf(() => parseAttachments([lying]))).toEqual({
      code: "UNSUPPORTED_ATTACHMENT_TYPE",
      status: 415,
    });
  });

  it("ATT-P-07 base64 非法(长度非 4 倍数 / 含字母表外字符)→ 400", () => {
    for (const payload of ["aGVsbG8", "aGVsb$G8==", "aGVsbG8===", "%%%=abcd"]) {
      const data = `data:image/png;base64,${payload}`;
      expect(
        errorCodeOf(() => parseAttachments([{ name: "a.png", mimeType: "image/png", data }])),
      ).toEqual({ code: "VALIDATION_ERROR", status: 400 });
    }
  });

  it("ATT-P-08 解码后零字节 → 400(空图没有任何 Provider 语义)", () => {
    const data = "data:image/png;base64,";
    expect(errorCodeOf(() => parseAttachments([{ name: "a.png", mimeType: "image/png", data }])))
      .toEqual({ code: "VALIDATION_ERROR", status: 400 });
  });
});

describe("parseAttachments —— 三份上限", () => {
  it("ATT-P-09 单图 >5MB → 413 ATTACHMENT_TOO_LARGE(边界:恰好 5MB 通过)", () => {
    expect(errorCodeOf(() => parseAttachments(one("image/png", ATTACHMENT_MAX_BYTES + 1))))
      .toEqual({ code: "ATTACHMENT_TOO_LARGE", status: 413 });
    expect(
      parseAttachments(one("image/png", ATTACHMENT_MAX_BYTES))![0]!.buffer.length,
    ).toBe(ATTACHMENT_MAX_BYTES);
  });

  it("ATT-P-10 张数 >4 → 413(4 张合法通过)", () => {
    expect(errorCodeOf(() => parseAttachments(one().concat(one(), one(), one(), one())))).toEqual({
      code: "ATTACHMENT_TOO_LARGE",
      status: 413,
    });
    expect(parseAttachments(one().concat(one(), one(), one()))).toHaveLength(4);
  });

  it("ATT-P-11 解码后总量 >10MB → 413(3×4MB 单图都不超限)", () => {
    const three = one("image/png", 4 * 1024 * 1024)
      .concat(one("image/jpeg", 4 * 1024 * 1024), one("image/gif", 4 * 1024 * 1024));
    expect(errorCodeOf(() => parseAttachments(three))).toEqual({
      code: "ATTACHMENT_TOO_LARGE",
      status: 413,
    });
  });

  it("ATT-P-12 长度闸门在解码之前:超长 payload 即使不是合法 base64 也报 413 而非 400", () => {
    const long = "!!!not-base64-but-huge!!!".repeat(400_000);
    expect(
      errorCodeOf(() =>
        parseAttachments([
          { name: "a.png", mimeType: "image/png", data: `data:image/png;base64,${long}` },
        ]),
      ),
    ).toEqual({ code: "ATTACHMENT_TOO_LARGE", status: 413 });
  });
});

describe("sanitizeAttachmentName", () => {
  it("只取 basename,目录穿越与反斜杠路径都不留痕迹", () => {
    expect(sanitizeAttachmentName("../../../../etc/passwd")).toBe("passwd");
    expect(sanitizeAttachmentName("C:\\Users\\me\\pic.png")).toBe("pic.png");
    expect(sanitizeAttachmentName("a/b/图片 1.png")).toBe("图片 1.png");
  });

  it("剥除控制字符与首尾空白", () => {
    expect(sanitizeAttachmentName("  a\u0000b\u001fc\u007f.png  ")).toBe("abc.png");
  });

  it("清洗后为空 / . / .. → 400", () => {
    for (const name of ["", "   ", "\u0000\u001f", ".", "..", "dir/.."]) {
      try {
        sanitizeAttachmentName(name);
        throw new Error(`expected throw for ${JSON.stringify(name)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe("VALIDATION_ERROR");
      }
    }
  });

  it("超长名截断到 128,且名字从不参与类型判据(I0 §13)", () => {
    expect(sanitizeAttachmentName(`${"x".repeat(500)}.png`)).toHaveLength(128);
    // 名字谎报成可执行文件也照样按真实字节判定类型
    expect(parseAttachments([{ ...one("image/png")[0]!, name: "evil.exe" }])![0]!.mimeType).toBe(
      "image/png",
    );
  });
});

describe("computeAttachmentsDigest", () => {
  const a = attachmentImage("image/png", 128);
  const b = attachmentImage("image/jpeg", 128);

  function digestOf(...buffers: Buffer[]): string {
    return computeAttachmentsDigest(
      buffers.map((bytes, i) => ({
        name: `f${i}`,
        mimeType: i % 2 === 0 ? "image/png" : "image/jpeg",
        buffer: bytes,
      })),
    );
  }

  it("内容相同 → 摘要相同(稳定,与 Buffer 实例无关)", () => {
    expect(digestOf(a)).toBe(digestOf(Buffer.from(a)));
    expect(digestOf(a, b)).toBe(digestOf(Buffer.from(a), Buffer.from(b)));
  });

  it("任一张内容变化 → 摘要变化", () => {
    expect(digestOf(a, b)).not.toBe(digestOf(Buffer.from([...a, 0x00]), b));
  });

  it("顺序变化 → 摘要变化(同两张图换序 = 不同的 Provider 提问)", () => {
    expect(digestOf(a, b)).not.toBe(digestOf(b, a));
  });

  it("拼接歧义:两张 [1,2] 与一张 [1,21,2] 不得同摘要(逐文件先摘要)", () => {
    const two = digestOf(Buffer.from([0x89, 0x01]), Buffer.from([0x02]));
    const oneBig = digestOf(Buffer.from([0x89, 0x01, 0x02]));
    expect(two).not.toBe(oneBig);
  });
});
