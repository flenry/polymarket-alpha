import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

type PartitionedTable = "trades" | "order_book_snapshots";

/** Format a Date as YYYY-MM-DD */
function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Add N days to a Date */
function addDays(d: Date, n: number): Date {
  const result = new Date(d);
  result.setUTCDate(result.getUTCDate() + n);
  return result;
}

/** Sanitize table names to prevent SQL injection */
function validateTable(table: PartitionedTable): void {
  if (table !== "trades" && table !== "order_book_snapshots") {
    throw new Error(`Unknown partition table: ${table}`);
  }
}

/** Convert table name to partition suffix prefix */
function partitionName(table: PartitionedTable, date: Date): string {
  const suffix = fmtDate(date).replace(/-/g, "_");
  return `${table}_${suffix}`;
}

/**
 * Create tomorrow's daily partition for the given table (idempotent).
 * Uses CREATE TABLE IF NOT EXISTS so re-runs are safe.
 */
export async function createTomorrowPartition(
  db: NodePgDatabase<typeof schema>,
  table: PartitionedTable
): Promise<void> {
  validateTable(table);
  const tomorrow = addDays(new Date(), 1);
  const dayAfter = addDays(tomorrow, 1);
  const from = fmtDate(tomorrow);
  const to = fmtDate(dayAfter);
  const name = partitionName(table, tomorrow);

  // Use raw SQL — Drizzle cannot express partition DDL
  await db.execute(
    sql.raw(
      `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "${table}"
       FOR VALUES FROM ('${from}') TO ('${to}')`
    )
  );
}

/**
 * Create a daily partition for a specific date (idempotent).
 * Used by PartitionManager to ensure today's partition exists on startup.
 */
export async function createPartitionForDate(
  db: NodePgDatabase<typeof schema>,
  table: PartitionedTable,
  date: Date
): Promise<void> {
  validateTable(table);
  const nextDay = addDays(date, 1);
  const from = fmtDate(date);
  const to = fmtDate(nextDay);
  const name = partitionName(table, date);

  await db.execute(
    sql.raw(
      `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "${table}"
       FOR VALUES FROM ('${from}') TO ('${to}')`
    )
  );
}

/**
 * Drop partitions older than retentionDays.
 * Identifies partition tables by naming convention: {table}_{YYYY_MM_DD}
 */
export async function dropExpiredPartitions(
  db: NodePgDatabase<typeof schema>,
  table: PartitionedTable,
  retentionDays: number
): Promise<string[]> {
  validateTable(table);
  const cutoff = addDays(new Date(), -retentionDays);

  // Query pg catalog for child partition tables
  const result = await db.execute<{ tablename: string }>(
    sql.raw(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public'
       AND tablename LIKE '${table}_%'
       AND tablename ~ '^${table}_[0-9]{4}_[0-9]{2}_[0-9]{2}$'`
    )
  );

  const dropped: string[] = [];
  const rows = result.rows as { tablename: string }[];

  for (const { tablename } of rows) {
    // Extract date from partition name: trades_2026_04_01 → 2026-04-01
    const dateStr = tablename
      .replace(`${table}_`, "")
      .replace(/_/g, "-");
    const partDate = new Date(dateStr);
    if (isNaN(partDate.getTime())) continue;

    if (partDate < cutoff) {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS "${tablename}"`));
      dropped.push(tablename);
    }
  }

  return dropped;
}

/** Retention constants per PRD §7.3 */
export const RETENTION_DAYS = {
  trades: 90,
  order_book_snapshots: 7,
} as const;

/**
 * PartitionManager: runs midnight UTC cron to create/drop partitions.
 */
export class PartitionManager {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  /** Ensure today and tomorrow partitions exist for all partitioned tables */
  async ensureCurrentPartitions(): Promise<void> {
    const today = new Date();
    for (const table of ["trades", "order_book_snapshots"] as PartitionedTable[]) {
      await createPartitionForDate(this.db, table, today);
      await createTomorrowPartition(this.db, table);
    }
  }

  /** Start midnight UTC cron */
  start(): void {
    // Check every hour; act when UTC hour === 0
    this.timer = setInterval(async () => {
      const hour = new Date().getUTCHours();
      if (hour === 0) {
        await this.ensureCurrentPartitions();
        for (const table of ["trades", "order_book_snapshots"] as PartitionedTable[]) {
          await dropExpiredPartitions(this.db, table, RETENTION_DAYS[table]);
        }
      }
    }, 60 * 60 * 1000); // every hour
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
