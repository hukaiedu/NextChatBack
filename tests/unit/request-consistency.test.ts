import { describe, expect, it } from "vitest";

import { expectedAssistantStatus, findPairingViolations } from "../../src/modules/request/request.consistency.js";
import { setupTestContext } from "../helpers.js";
import type { TestContext } from "../helpers.js";
import { randomUUID } from "node:crypto";

describe("Request-Assistant 状态一致性(§六)", () => {
  it("expectedAssistantStatus 覆盖全部 7 态", () => {
    expect(expectedAssistantStatus("PENDING")).toBe("PENDING");
    expect(expectedAssistantStatus("PROCESSING")).toBe("STREAMING");
    expect(expectedAssistantStatus("CANCELLING")).toBe("STREAMING");
    expect(expectedAssistantStatus("SUCCESS")).toBe("COMPLETED");
    expect(expectedAssistantStatus("FAILED")).toBe("FAILED");
    expect(expectedAssistantStatus("TIMEOUT")).toBe("FAILED");
    expect(expectedAssistantStatus("CANCELLED")).toBe("CANCELLED");
  });

  it("findPairingViolations:合法配对返回空", async () => {
    const ctx = await setupTestContext();
    await ctx.reset();
    try {
      const conv = await ctx.prisma.conversation.create({
        data: { title: "ok", status: "ACTIVE", provider: "GEMINI_WEB" },
      });
      const user = await ctx.prisma.message.create({
        data: { conversationId: conv.id, role: "USER", content: "hi", status: "COMPLETED", position: 1 },
      });
      const assistant = await ctx.prisma.message.create({
        data: { conversationId: conv.id, role: "ASSISTANT", content: "", status: "STREAMING", position: 2 },
      });
      await ctx.prisma.modelRequest.create({
        data: {
          conversationId: conv.id,
          userMessageId: user.id,
          assistantMessageId: assistant.id,
          idempotencyKey: randomUUID(),
          requestFingerprint: randomUUID(),
          status: "PROCESSING",
          provider: "GEMINI_WEB",
        },
      });

      const violations = await findPairingViolations(ctx.prisma);
      expect(violations).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });

  it("findPairingViolations:违规配对被检出", async () => {
    const ctx = await setupTestContext();
    await ctx.reset();
    try {
      const conv = await ctx.prisma.conversation.create({
        data: { title: "bad", status: "ACTIVE", provider: "GEMINI_WEB" },
      });
      const user = await ctx.prisma.message.create({
        data: { conversationId: conv.id, role: "USER", content: "hi", status: "COMPLETED", position: 1 },
      });
      // 违规:Request SUCCESS + Assistant FAILED
      const assistant = await ctx.prisma.message.create({
        data: { conversationId: conv.id, role: "ASSISTANT", content: "", status: "FAILED", position: 2 },
      });
      await ctx.prisma.modelRequest.create({
        data: {
          conversationId: conv.id,
          userMessageId: user.id,
          assistantMessageId: assistant.id,
          idempotencyKey: randomUUID(),
          requestFingerprint: randomUUID(),
          status: "SUCCESS",
          provider: "GEMINI_WEB",
        },
      });

      const violations = await findPairingViolations(ctx.prisma);
      expect(violations).toHaveLength(1);
      expect(violations[0].requestStatus).toBe("SUCCESS");
      expect(violations[0].assistantStatus).toBe("FAILED");
    } finally {
      await ctx.close();
    }
  });
});
