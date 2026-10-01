import { useSession } from "@tanstack/react-start/server";

import { TOAST_COOKIE, type Toast } from "./toast";

interface ToastSessionData {
  toast?: Toast;
}

function getToastSessionPassword() {
  const password = process.env.TOAST_SECRET;
  if (!password) {
    throw new Error("TOAST_SECRET must be set");
  }

  return password;
}

export function useToastSession() {
  return useSession<ToastSessionData>({
    name: TOAST_COOKIE,
    password: getToastSessionPassword(),
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    },
  });
}
