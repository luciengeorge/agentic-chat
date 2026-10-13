import { createServerFn } from "@tanstack/react-start";

import { ToastSchema } from "../toast";
import { writeToast } from "../toast-session.server";

export const setToast = createServerFn({ method: "POST" })
  .validator(ToastSchema)
  .handler(async ({ data }) => {
    await writeToast(data);

    return null;
  });
