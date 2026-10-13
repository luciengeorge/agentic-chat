import { defineRelations } from "drizzle-orm";

import * as app from "./schema/app";
import { authRelations } from "./schema/auth";

export const relations = { ...defineRelations(app), ...authRelations };
