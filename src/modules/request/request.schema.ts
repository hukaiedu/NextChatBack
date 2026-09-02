import { z } from "zod";

export const requestParamSchema = z.object({
  id: z.string().min(1),
});
