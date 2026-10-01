import { useEffect } from "react";
import { toast as sonnerToast } from "sonner";

import type { Toast } from "@/lib/toast";

export function useToast(toast: Toast | null) {
  useEffect(() => {
    if (!toast) return;

    const method =
      toast.status === "error"
        ? sonnerToast.error
        : toast.status === "warning"
          ? sonnerToast.warning
          : toast.status === "success"
            ? sonnerToast.success
            : sonnerToast.info;

    method(toast.title ?? toast.description, {
      description: toast.title ? toast.description : undefined,
    });
  }, [toast]);
}
