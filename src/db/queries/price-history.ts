import { desc, eq, gte, and, lt, asc, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../schema.js";
import { priceHistory, trades } from "../schema.js";
import type { TokenId } from "../../events/types.js";

type Db = NodePgDatabase<typeof schema>;

export interface PriceRecord {
  price: number;
  recordedAt: Date;
}

export interface TradeTimestamp {
  tradedAt: Date;
}

/**
 * Fetch the most recent `limit` price records for a token, ordered newest-first.
 * Returns an empty array if no records exist.
 */
export async function getRecentPriceHistory(
  db: Db,
  tokenId: TokenId,
  limit = 100
): Promise<PriceRecord[]> {
  const rows = await db
    .select({ price: priceHistory.price, recordedAt: priceHistory.recordedAt })
    .from(priceHistory)
    .where(eq(priceHistory.tokenId, tokenId))
    .orderBy(desc(priceHistory.recordedAt))
    .limit(limit);

  return rows.map((r) => ({
    price: Number(r.price),
    recordedAt: r.recordedAt,
  }));
}

/**
 * Fetch last-trade price history for a token over the last 24 hours, ordered ASC.
 * Only includes `event_type = 'last_trade'` records (not best_bid_ask — too noisy).
 * Used by ArbDetector.evaluate() to compute mean/stddev for outlier detection.
 */
export async function getTokenPriceHistory24h(
  db: Db,
  tokenId: TokenId
): Promise<PriceRecord[]> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ price: priceHistory.price, recordedAt: priceHistory.recordedAt })
    .from(priceHistory)
    .where(
      and(
        eq(priceHistory.tokenId, tokenId),
        eq(priceHistory.eventType, "last_trade"),
        gte(priceHistory.recordedAt, cutoff)
      )
    )
    .orderBy(asc(priceHistory.recordedAt));

  return rows.map((r) => ({
    price: Number(r.price),
    recordedAt: r.recordedAt,
  }));
}

/**
 * Fetch trade timestamps for a token within the last `windowSeconds` seconds.
 * Used by SentimentVelocityEvaluator.bootstrap() to pre-populate the trade buffer.
 * Returns records ordered oldest-first (ASC) so the buffer can be populated in order.
 */
export async function getRecentTradeTimestamps(
  db: Db,
  tokenId: TokenId,
  windowSeconds: number
): Promise<TradeTimestamp[]> {
  const cutoff = new Date(Date.now() - windowSeconds * 1000);

  const rows = await db.execute<{ traded_at: Date }>(sql`
    SELECT traded_at
    FROM trades
    WHERE token_id = ${tokenId}
      AND traded_at >= ${cutoff.toISOString()}
    ORDER BY traded_at ASC
  `);

  return (rows.rows as { traded_at: Date }[]).map((r) => ({
    tradedAt: new Date(r.traded_at),
  }));
}
