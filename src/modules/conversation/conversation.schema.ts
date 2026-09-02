import { z } from "zod";

export const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});

export const patchConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
  })
  .refine((value) => value.title !== undefined || value.status !== undefined, {
    message: "at least one of title or status is required",
  });

export const listConversationsQuerySchema = z.object({
  status: z.enum(["ACTIVE", "ARCHIVED"]).default("ACTIVE"),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().min(1).optional(),
});

export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type PatchConversationInput = z.infer<typeof patchConversationSchema>;
export type ListConversationsQueryInput = z.infer<typeof listConversationsQuerySchema>;
