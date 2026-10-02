import { createDb } from "./create";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL must be set");

export const db = createDb(url);
