import { sql, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../schema.js";
import { whaleAlerts } from "../schema.js";
import type { WhaleAlert } from "../../events/types.js";

type Db = NodePgDatabase<typeof schema>;

/**
 * Serialise a WhaleAlert's trade into the lookup key used instead of FK.
 * Format: "txHash|tokenId|proxyWallet|tradedAt.toISO()|priceUsdc|sizeTokens"
 */
export function buildTradeLookupKey(alert: WhaleAlert): string {
  const { trade } = alert;
  return [
    trade.transactionHash,
    trade.tokenId,
    trade.proxyWallet,
    trade.tradedAt.toISOString(),
    trade.priceUsdc.toString(),
    trade.sizeTokens.toString(),
  ].join("|");
}

/**
 * Insert a whale alert.
 * Only inserts if alert.emitSignal = true (liquidity guard).
 * Returns the new alert ID, or null if skipped.
 */
export async function insertWhaleAlert(
  db: Db,
  alert: WhaleAlert
): Promise<bigint | null> {
  if (!alert.emitSignal) return null;

  const tradeLookupKey = buildTradeLookupKey(alert);
  const { trade, marketStats } = alert;

  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO whale_alerts (
      trade_lookup_key, token_id, condition_id,
      usdc_value, absolute_min_usdc,
      avg_trade_size_24h_at_alert, stddev_24h_at_alert, volume_24h_at_alert,
      sigmas_above_mean, pct_of_daily_volume,
      price_at_alert, price_impact_estimate_usdc,
      book_depth_consumed_pct, book_snapshot_age_ms
    ) VALUES (
      ${tradeLookupKey},
      ${trade.tokenId}, ${trade.conditionId},
      ${alert.usdcValue.toString()},
      ${alert.signal.priceAtSignal ? Math.round(alert.usdcValue) : 10000}::integer,
      ${marketStats.avgTradeSize24h?.toString() ?? null},
      ${marketStats.stddevTradeSize24h?.toString() ?? null},
      ${marketStats.volume24hr?.toString() ?? null},
      ${isFinite(alert.signal.sigmasAboveMean) ? alert.signal.sigmasAboveMean.toString() : null},
      ${alert.signal.pctOfDailyVolume.toString()},
      ${alert.priceAtAlert.toString()},
      ${alert.priceImpactEstimateUsdc.toString()},
      ${alert.bookDepthConsumedPct.toString()},
      ${alert.bookSnapshotAgeMs}::integer
    )
    RETURNING id
  `);

  const rows = result.rows as { id: string }[];
  if (rows.length === 0) return null;
  return BigInt(rows[0].id);
}

export async function enrichWhaleAlert(
  db: Db,
  id: bigint,
  enrichment: {
    walletTotalVolumeUsdc?: number;
    walletTradeCount?: number;
    walletWinRatio?: number;
  }
): Promise<void> {
  await db
    .update(whaleAlerts)
    .set({
      walletTotalVolumeUsdc: enrichment.walletTotalVolumeUsdc?.toString() ?? null,
      walletTradeCount: enrichment.walletTradeCount ?? null,
      walletWinRatio: enrichment.walletWinRatio?.toString() ?? null,
      enrichedAt: new Date(),
    })
    .where(eq(whaleAlerts.id, Number(id)));
}
