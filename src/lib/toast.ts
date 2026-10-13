import z from "zod";

export const TOAST_COOKIE = "toast";

export const ToastSchema = z.object({
  title: z.string().optional(),
  description: z.string(),
  status: z.enum(["success", "error", "warning", "info"]).default("info"),
});

export type Toast = z.infer<typeof ToastSchema>;
export type ToastInput = z.input<typeof ToastSchema>;
