import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../schema.js";
import type { TradeEvent } from "../../events/types.js";

type Db = NodePgDatabase<typeof schema>;

/**
 * Insert a trade using ON CONFLICT DO NOTHING (DB-enforced dedup).
 * The unique index is on (transaction_hash, token_id, proxy_wallet, traded_at, price_usdc, size_tokens).
 * Returns { inserted: true } on success, { inserted: false } on duplicate.
 */
export async function insertTrade(
  db: Db,
  trade: TradeEvent
): Promise<{ inserted: boolean }> {
  const result = await db.execute(sql`
    INSERT INTO trades (
      token_id, condition_id, outcome, side, size_tokens,
      price_usdc, value_usdc, proxy_wallet, transaction_hash,
      traded_at, market_slug, event_slug, market_title,
      trader_name, trader_pseudonym, source
    ) VALUES (
      ${trade.tokenId}, ${trade.conditionId}, ${trade.outcome},
      ${trade.side}, ${trade.sizeTokens.toString()},
      ${trade.priceUsdc.toString()}, ${trade.valueUsdc.toString()},
      ${trade.proxyWallet}, ${trade.transactionHash},
      ${trade.tradedAt.toISOString()},
      ${trade.marketSlug ?? null}, ${trade.eventSlug ?? null},
      ${trade.marketTitle ?? null},
      ${trade.traderName ?? null}, ${trade.traderPseudonym ?? null},
      ${trade.source}
    )
    ON CONFLICT (transaction_hash, token_id, proxy_wallet, traded_at, price_usdc, size_tokens)
    DO NOTHING
  `);

  return { inserted: (result.rowCount ?? 0) === 1 };
}

/**
 * Batch insert trades — each trade independently handled.
 * Returns count of actually inserted rows.
 */
export async function insertTrades(
  db: Db,
  trades: TradeEvent[]
): Promise<number> {
  let inserted = 0;
  for (const trade of trades) {
    const result = await insertTrade(db, trade);
    if (result.inserted) inserted++;
  }
  return inserted;
}
