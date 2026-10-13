import { createServerFn } from "@tanstack/react-start";

import { ToastSchema } from "../toast";
import { clearToast, hasToastCookie, readToast } from "../toast-session.server";

export const getToast = createServerFn({ method: "GET" }).handler(async () => {
  const result = ToastSchema.safeParse(await readToast());
  const toast = result.success ? result.data : null;

  // Read once: a valid toast is cleared after showing, and a bad one (wrong seal or shape) so it isn't re-read.
  if (hasToastCookie()) {
    clearToast();
  }

  return toast;
});
