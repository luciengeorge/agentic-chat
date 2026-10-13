import { createServerFn } from "@tanstack/react-start";

import { ToastSchema } from "../toast";
import { clearToast, readToast } from "../toast-session.server";

export const getToast = createServerFn({ method: "GET" }).handler(async () => {
  const result = ToastSchema.safeParse(await readToast());
  const toast = result.success ? result.data : null;

  if (toast) {
    clearToast();
  }

  return toast;
});
