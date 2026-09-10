import { z } from "zod";

/**
 * 发送消息 body:有效条件是「trim 后非空文本 OR 至少一张附件」——
 * I1.2 起纯图片消息 content 允许为 "";空数组等价于无附件,纯空请求仍在此 400。
 * trim 只做校验判据,不做 transform:canonical content 归 MessageService。
 */
export const sendMessageSchema = z
  .object({
    content: z.string().max(50000, "content must be at most 50000 characters"),
    // M1:显式提交的模型键;省略 = 沿用会话偏好。键为 provider 不透明字符串,只做长度约束
    modelKey: z.string().trim().min(1).max(256).optional(),
    // V1.2 I1:图片附件。这里只约束形状,张数/字节/MIME 真伪一律交给
    // attachment.ts(超限 → 413、类型不符 → 415),不让 zod 抢先返回 400。
    attachments: z
      .array(
        z.object({
          name: z.string().min(1).max(1024),
          mimeType: z.string().min(1).max(128),
          data: z.string().min(1),
        }),
      )
      .optional(),
  })
  .refine(
    (body) => body.content.trim().length > 0 || (body.attachments?.length ?? 0) > 0,
    {
      path: ["content"],
      message: "content must not be empty when no attachments are provided",
    },
  );

// PAG-2:GET messages 分页 query;limit 默认 50、上限 100;cursor 为不透明 base64url 串
export const listMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});

export const messageRouteParamSchema = z.object({
  conversationId: z.string().min(1),
});

export const idempotencyKeyHeaderSchema = z.string().trim().min(1).max(256);

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
