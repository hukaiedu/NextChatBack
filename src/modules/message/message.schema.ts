import { z } from "zod";

/** 发送消息 body:trim 后非空,最长 50000 字符 */
export const sendMessageSchema = z.object({
  content: z
    .string()
    .max(50000, "content must be at most 50000 characters")
    .refine((value) => value.trim().length > 0, {
      message: "content must not be empty after trim",
    }),
});

export const messageRouteParamSchema = z.object({
  conversationId: z.string().min(1),
});

export const idempotencyKeyHeaderSchema = z.string().trim().min(1).max(256);

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
