import { deleteCookie, getCookie, setCookie } from "@tanstack/react-start/server";
import { sealData, unsealData } from "iron-session";

import { TOAST_COOKIE, type Toast } from "./toast";

interface ToastSessionData {
  toast?: Toast;
}

const cookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
} as const;

function getToastSessionPassword() {
  const password = process.env.TOAST_SECRET;
  if (!password) {
    throw new Error("TOAST_SECRET must be set");
  }

  return password;
}

export async function readToast(): Promise<unknown> {
  const sealed = getCookie(TOAST_COOKIE);
  if (!sealed) {
    return undefined;
  }

  // A cookie sealed with another secret or format (say, before an upgrade) reads as no toast.
  const data = await unsealData<ToastSessionData>(sealed, { password: getToastSessionPassword() }).catch(
    () => ({}) as ToastSessionData,
  );
  return data.toast;
}

export async function writeToast(toast: Toast) {
  const sealed = await sealData({ toast } satisfies ToastSessionData, { password: getToastSessionPassword() });
  setCookie(TOAST_COOKIE, sealed, cookieOptions);
}

export function clearToast() {
  deleteCookie(TOAST_COOKIE, cookieOptions);
}
