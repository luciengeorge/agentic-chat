import { createServerFn } from "@tanstack/react-start";

import { listSteps } from "./ex.server";

export const getSteps = createServerFn({ method: "GET" }).handler(() => listSteps());
