import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { computeRequestFingerprint } from "../../src/common/utils/fingerprint.js";

/**
 * V1 冻结基线:canonical JSON `{"conversationId":"A","content":"hello"}` 的 SHA-256。
 * M1 改造指纹函数后此值必须逐字节不变(旧客户端不带 modelKey 仍可去重)。
 */
const V1_FIXTURE_HASH = "c142190b7a420b8b6f03bed9b37df94ae3ac8b3f3811f65b2dcf702b12ad1faf";

describe("computeRequestFingerprint", () => {
  it("相同 conversationId + content 产生相同指纹(稳定)", () => {
    const a = computeRequestFingerprint("conv-1", "你好");
    const b = computeRequestFingerprint("conv-1", "你好");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("content 不同产生不同指纹", () => {
    const a = computeRequestFingerprint("conv-1", "你好");
    const b = computeRequestFingerprint("conv-1", "你好吗");
    expect(a).not.toBe(b);
  });

  it("conversationId 不同产生不同指纹", () => {
    const a = computeRequestFingerprint("conv-1", "你好");
    const b = computeRequestFingerprint("conv-2", "你好");
    expect(a).not.toBe(b);
  });

  // ---- M1 FINGERPRINT 矩阵 ----

  it("FINGERPRINT-01: 不带 modelKey 时与 V1 冻结基线逐字节一致(回归)", () => {
    expect(computeRequestFingerprint("A", "hello")).toBe(V1_FIXTURE_HASH);
  });

  it("FINGERPRINT-02: 不带 modelKey 的指纹对多组输入保持 V1 稳定(键整体省略,非空串)", () => {
    // 若实现把缺失键写成 modelKey:"" 或 modelKey:null,以下任一条都会与 V1 不同
    for (const [conversationId, content] of [
      ["conv-1", "你好"],
      ["conv-2", ""],
      ["A", "hello"],
    ] as const) {
      const canonical = JSON.stringify({ conversationId, content });
      // 用独立哈希实现做交叉验证,避免实现自我循环
      expect(computeRequestFingerprint(conversationId, content)).toBe(
        createHash("sha256").update(canonical).digest("hex"),
      );
    }
  });

  it("FINGERPRINT-03: 显式 modelKey 改变指纹;同键重算稳定", () => {
    const without = computeRequestFingerprint("conv-1", "你好");
    const withA = computeRequestFingerprint("conv-1", "你好", "model-a");
    const withA2 = computeRequestFingerprint("conv-1", "你好", "model-a");
    expect(withA).not.toBe(without);
    expect(withA).toBe(withA2);
    expect(withA).toMatch(/^[0-9a-f]{64}$/);
  });

  it("FINGERPRINT-04: 不同 modelKey 产生不同指纹", () => {
    const a = computeRequestFingerprint("conv-1", "你好", "model-a");
    const b = computeRequestFingerprint("conv-1", "你好", "model-b");
    expect(a).not.toBe(b);
  });

  it("FINGERPRINT-05: modelKey 不影响 conversationId/content 的区分度", () => {
    const sameKeySameContent = computeRequestFingerprint("conv-1", "你好", "model-a");
    const otherContent = computeRequestFingerprint("conv-1", "你好吗", "model-a");
    const otherConv = computeRequestFingerprint("conv-2", "你好", "model-a");
    expect(otherContent).not.toBe(sameKeySameContent);
    expect(otherConv).not.toBe(sameKeySameContent);
  });
});
