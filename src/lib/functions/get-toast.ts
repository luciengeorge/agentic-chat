import { createServerFn } from "@tanstack/react-start";

import { ToastSchema } from "../toast";
import { useToastSession } from "../toast-session.server";

export const getToast = createServerFn({ method: "GET" }).handler(async () => {
  const session = await useToastSession();
  const result = ToastSchema.safeParse(session.data.toast);
  const toast = result.success ? result.data : null;

  if (toast) {
    await session.clear();
  }

  return toast;
});
