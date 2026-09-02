import { describe, expect, it } from "vitest";

import { computeRequestFingerprint } from "../../src/common/utils/fingerprint.js";

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
});
