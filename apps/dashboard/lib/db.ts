import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../src/db/schema";

// Singleton pool — prevents connection leaks during Next.js hot reload in dev
declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
}

function createPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  return new Pool({ connectionString: url });
}

export const pool: Pool =
  globalThis.__pgPool ?? (globalThis.__pgPool = createPool());

export const db = drizzle(pool, { schema });
