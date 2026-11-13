import { z } from "zod";

export const commentContentSchema = z.object({
  title: z.string().trim().max(300).default(""),
  commentText: z.string().trim().max(10000).default("")
}).refine((value) => Boolean(value.title || value.commentText), {
  message: "Escribe al menos un título o un comentario.",
  path: ["commentText"]
});

export const annotationOrderSchema = z.object({
  keys: z.array(z.string().regex(/^(note|highlight|comment):[0-9a-f-]{36}$/iu)).max(10000)
    .refine((keys) => new Set(keys).size === keys.length, "El orden no puede contener elementos duplicados.")
});

export const annotationOrderQuerySchema = z.object({
  scope: z.enum(["notes", "comments"]).default("notes")
});
