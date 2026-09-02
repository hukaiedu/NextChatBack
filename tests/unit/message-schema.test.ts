import { describe, expect, it } from "vitest";

import {
  idempotencyKeyHeaderSchema,
  sendMessageSchema,
} from "../../src/modules/message/message.schema.js";
import {
  createConversationSchema,
  patchConversationSchema,
} from "../../src/modules/conversation/conversation.schema.js";

describe("sendMessageSchema", () => {
  it("合法内容通过", () => {
    const result = sendMessageSchema.safeParse({ content: "  你好  " });
    expect(result.success).toBe(true);
  });

  it("空字符串拒绝", () => {
    expect(sendMessageSchema.safeParse({ content: "" }).success).toBe(false);
  });

  it("纯空格拒绝(trim 后为空)", () => {
    const result = sendMessageSchema.safeParse({ content: "   \n\t " });
    expect(result.success).toBe(false);
  });

  it("50000 字符通过", () => {
    expect(sendMessageSchema.safeParse({ content: "a".repeat(50000) }).success).toBe(true);
  });

  it("50001 字符拒绝", () => {
    expect(sendMessageSchema.safeParse({ content: "a".repeat(50001) }).success).toBe(false);
  });
});

describe("idempotencyKeyHeaderSchema", () => {
  it("空 Key 拒绝(必填)", () => {
    expect(idempotencyKeyHeaderSchema.safeParse("").success).toBe(false);
    expect(idempotencyKeyHeaderSchema.safeParse("   ").success).toBe(false);
  });

  it("正常 Key 通过", () => {
    expect(idempotencyKeyHeaderSchema.safeParse("a1b2c3").success).toBe(true);
  });
});

describe("conversation schemas", () => {
  it("创建:空 body 允许(默认标题)", () => {
    expect(createConversationSchema.safeParse({}).success).toBe(true);
  });

  it("创建:带 title 通过", () => {
    expect(createConversationSchema.safeParse({ title: "Java问题" }).success).toBe(true);
  });

  it("PATCH:空 body 拒绝", () => {
    expect(patchConversationSchema.safeParse({}).success).toBe(false);
  });

  it("PATCH:status=DELETED 拒绝(不允许通过 PATCH 进入 DELETED)", () => {
    expect(patchConversationSchema.safeParse({ status: "DELETED" }).success).toBe(false);
  });

  it("PATCH:title 或 status 单一字段通过", () => {
    expect(patchConversationSchema.safeParse({ title: "新标题" }).success).toBe(true);
    expect(patchConversationSchema.safeParse({ status: "ARCHIVED" }).success).toBe(true);
  });
});
