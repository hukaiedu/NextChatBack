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

/**
 * I1.2:有效条件是「trim 后非空文本 OR 至少一张附件」—— 纯图片消息 content 允许为空。
 * 这里只验联合形状与空数组语义;MIME 白名单、magic byte、解码字节数一律归 attachment.ts。
 */
describe("sendMessageSchema 纯图片联合校验(I1.2)", () => {
  const IMAGE = {
    name: "red.png",
    mimeType: "image/png",
    data: "data:image/png;base64,iVBORw0KGgo=",
  };

  it("PURE-SCHEMA-01:content=\"\" 且无 attachments → reject", () => {
    expect(sendMessageSchema.safeParse({ content: "" }).success).toBe(false);
  });

  it("PURE-SCHEMA-02:content=\"   \" 且无 attachments → reject", () => {
    expect(sendMessageSchema.safeParse({ content: "   " }).success).toBe(false);
  });

  it("PURE-SCHEMA-03:content=\"\" + attachments=[] → reject(空数组等价于无附件)", () => {
    expect(sendMessageSchema.safeParse({ content: "", attachments: [] }).success).toBe(false);
  });

  it("PURE-SCHEMA-04:content=\"\" + 一张合法形状附件 → pass(schema 不做 trim transform)", () => {
    const result = sendMessageSchema.safeParse({ content: "", attachments: [IMAGE] });
    expect(result.success).toBe(true);
    if (result.success) {
      // canonical trim 归 MessageService:schema 原样放行 ""
      expect(result.data.content).toBe("");
    }
  });

  it("PURE-SCHEMA-05:content=\"   \\n\\t \" + 一张合法形状附件 → pass", () => {
    expect(sendMessageSchema.safeParse({ content: "   \n\t ", attachments: [IMAGE] }).success).toBe(
      true,
    );
  });

  it("PURE-SCHEMA-06:content=\"hello\" + attachments=[] → pass(纯文本零回归)", () => {
    expect(sendMessageSchema.safeParse({ content: "hello", attachments: [] }).success).toBe(true);
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
