import { z } from "zod";

/** 发送消息 body:trim 后非空,最长 50000 字符 */
export const sendMessageSchema = z.object({
  content: z
    .string()
    .max(50000, "content must be at most 50000 characters")
    .refine((value) => value.trim().length > 0, {
      message: "content must not be empty after trim",
    }),
  // M1:显式提交的模型键;省略 = 沿用会话偏好。键为 provider 不透明字符串,只做长度约束
  modelKey: z.string().trim().min(1).max(256).optional(),
});

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
