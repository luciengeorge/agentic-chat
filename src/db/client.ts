import { appDb } from "./pool";

export { appDb, systemDb } from "./pool";

/** The app role's pool. Importing this needs DATABASE_URL; code that may load without it imports `./pool`. */
export const db = appDb();
