import { appDb } from "@/db/pool";
import { startFire } from "@/workflows/automation-start";

import type { AutomationRoutesDeps } from "./-automations";

export const automationDeps = (): AutomationRoutesDeps => ({ db: appDb(), fire: startFire });
