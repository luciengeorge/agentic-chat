import { redirect, type RedirectOptions } from "@tanstack/react-router";

import type { ToastInput } from "../toast";

import { setToast } from "./set-toast";

interface RedirectWithToastProps extends RedirectOptions {
  toast: ToastInput;
}

export async function redirectWithToast({ toast, ...props }: RedirectWithToastProps) {
  await setToast({ data: toast });
  throw redirect(props);
}
