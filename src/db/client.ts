import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";
import { config } from "../config.js";

let _pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: config.databaseUrl });
  }
  return _pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}

export const db = getDb();

export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
