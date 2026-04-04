import { sql, desc, gt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../schema.js";
import { signals } from "../schema.js";
import type { Signal, SignalType } from "../../events/types.js";
import { SIGNAL_TYPES } from "../../events/types.js";
import { z } from "zod";

type Db = NodePgDatabase<typeof schema>;

const ZSignalType = z.enum(SIGNAL_TYPES as unknown as [SignalType, ...SignalType[]]);

export async function insertSignal(
  db: Db,
  signal: Signal,
  whaleAlertId?: bigint | number | null
): Promise<{ id: bigint } | null> {
  // Validate signalType against canonical enum before insert
  const typeCheck = ZSignalType.safeParse(signal.signalType);
  if (!typeCheck.success) {
    throw new Error(`Unknown signal type: ${signal.signalType}`);
  }

  // Clamp confidence to [0, 1]
  const confidence = Math.min(1.0, Math.max(0.0, signal.confidence));

  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO signals (
      token_id, condition_id, signal_type, direction,
      confidence, strength, price_at_signal,
      whale_alert_id, payload, created_at
    ) VALUES (
      ${signal.tokenId}, ${signal.conditionId}, ${signal.signalType},
      ${signal.direction},
      ${confidence.toString()},
      ${signal.strength.toString()},
      ${signal.priceAtSignal.toString()},
      ${whaleAlertId ? String(whaleAlertId) : null}::bigint,
      ${JSON.stringify(signal.payload)}::jsonb,
      ${signal.createdAt.toISOString()}
    )
    RETURNING id
  `);

  const rows = result.rows as { id: string }[];
  if (rows.length === 0) return null;
  return { id: BigInt(rows[0].id) };
}

/**
 * Patch the payload jsonb column of multiple signal rows by merging in `patch`.
 * Uses `payload || $patch` (jsonb concat operator) so existing fields are preserved.
 * No-op if `ids` is empty.
 */
export async function updateSignalPayloads(
  db: Db,
  ids: bigint[],
  patch: Record<string, unknown>
): Promise<void> {
  if (ids.length === 0) return;
  await db.execute(sql`
    UPDATE signals
    SET payload = COALESCE(payload, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
    WHERE id = ANY(ARRAY[${sql.join(ids.map((id) => sql`${String(id)}::bigint`), sql`, `)}])
  `);
}

export async function getRecentSignals(
  db: Db,
  limitHours = 1
): Promise<typeof signals.$inferSelect[]> {
  const cutoff = new Date(Date.now() - limitHours * 60 * 60 * 1000);
  return db
    .select()
    .from(signals)
    .where(gt(signals.createdAt, cutoff))
    .orderBy(desc(signals.createdAt))
    .limit(100);
}
