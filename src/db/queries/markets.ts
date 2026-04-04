import { eq, and } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../schema.js";
import { markets, marketStats } from "../schema.js";
import type { GammaMarket } from "../../validation/schemas.js";
import type { TokenId } from "../../events/types.js";

type Db = NodePgDatabase<typeof schema>;

/**
 * Parse the outcome label for a given token index from the Gamma `outcomes` JSON string.
 * `outcomes` is a JSON array string like '["Yes","No"]'.
 * Returns "" if parsing fails or index is out of range.
 */
function parseOutcome(outcomesJson: string | null | undefined, index: number): string {
  if (!outcomesJson) return "";
  try {
    const arr = JSON.parse(outcomesJson) as unknown[];
    const val = arr[index];
    return typeof val === "string" ? val : "";
  } catch {
    return "";
  }
}

export async function upsertMarket(
  db: Db,
  market: GammaMarket & {
    tokenId: string;
    watchlisted: boolean;
    negRisk: boolean;
    /** Index of this token in the clobTokenIds array — used to derive outcome label */
    outcomeIndex?: number;
  }
): Promise<void> {
  const idx = market.outcomeIndex ?? 0;
  const outcome = parseOutcome(market.outcomes, idx);

  await db
    .insert(markets)
    .values({
      tokenId: market.tokenId,
      conditionId: market.conditionId,
      question: market.question ?? "",
      slug: market.slug ?? null,
      eventSlug: market.eventSlug ?? null,
      category: market.category ?? null,
      outcome,
      outcomeIndex: idx,
      negRisk: market.negRisk,
      watchlisted: market.watchlisted,
      active: market.active ?? true,
      closed: market.closed ?? false,
      acceptingOrders: market.acceptingOrders ?? false,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: markets.tokenId,
      set: {
        conditionId: market.conditionId,
        question: market.question ?? "",
        slug: market.slug ?? null,
        eventSlug: market.eventSlug ?? null,
        category: market.category ?? null,
        outcome,
        outcomeIndex: idx,
        negRisk: market.negRisk,
        watchlisted: market.watchlisted,
        active: market.active ?? true,
        closed: market.closed ?? false,
        acceptingOrders: market.acceptingOrders ?? false,
        updatedAt: new Date(),
      },
    });
}

export async function getWatchlistedTokenIds(db: Db): Promise<TokenId[]> {
  const rows = await db
    .select({ tokenId: markets.tokenId })
    .from(markets)
    .where(and(eq(markets.watchlisted, true), eq(markets.negRisk, false)));
  return rows.map((r) => r.tokenId);
}

export async function getNegRiskTokenIds(db: Db): Promise<TokenId[]> {
  const rows = await db
    .select({ tokenId: markets.tokenId })
    .from(markets)
    .where(eq(markets.negRisk, true));
  return rows.map((r) => r.tokenId);
}

export async function upsertMarketStats(
  db: Db,
  stats: {
    tokenId: TokenId;
    conditionId: string;
    volume24hr?: number | null;
    avgTradeSize24h?: number | null;
    stddevTradeSize24h?: number | null;
    liquidityUsdc?: number | null;
    tradeCount24h?: number | null;
    bestBid?: number | null;
    bestAsk?: number | null;
    lastTradePrice?: number | null;
    oneDayPriceChange?: number | null;
  }
): Promise<void> {
  const tradeCount = stats.tradeCount24h ?? 0;
  // calibrated = true when tradeCount24h >= 30
  const calibrated = tradeCount >= 30;

  await db
    .insert(marketStats)
    .values({
      tokenId: stats.tokenId,
      conditionId: stats.conditionId,
      volume24hr: stats.volume24hr?.toString() ?? null,
      avgTradeSize24h: stats.avgTradeSize24h?.toString() ?? null,
      stddevTradeSize24h: stats.stddevTradeSize24h?.toString() ?? null,
      liquidityUsdc: stats.liquidityUsdc?.toString() ?? null,
      tradeCount24h: tradeCount,
      calibrated,
      bestBid: stats.bestBid?.toString() ?? null,
      bestAsk: stats.bestAsk?.toString() ?? null,
      lastTradePrice: stats.lastTradePrice?.toString() ?? null,
      oneDayPriceChange: stats.oneDayPriceChange?.toString() ?? null,
      refreshedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: marketStats.tokenId,
      set: {
        volume24hr: stats.volume24hr?.toString() ?? null,
        avgTradeSize24h: stats.avgTradeSize24h?.toString() ?? null,
        stddevTradeSize24h: stats.stddevTradeSize24h?.toString() ?? null,
        liquidityUsdc: stats.liquidityUsdc?.toString() ?? null,
        tradeCount24h: tradeCount,
        calibrated,
        bestBid: stats.bestBid?.toString() ?? null,
        bestAsk: stats.bestAsk?.toString() ?? null,
        lastTradePrice: stats.lastTradePrice?.toString() ?? null,
        oneDayPriceChange: stats.oneDayPriceChange?.toString() ?? null,
        refreshedAt: new Date(),
      },
    });
}

export async function markMarketClosed(db: Db, tokenId: TokenId): Promise<void> {
  await db
    .update(markets)
    .set({ closed: true, updatedAt: new Date() })
    .where(eq(markets.tokenId, tokenId));
}

export interface NegRiskMarketRow {
  tokenId: string;
  conditionId: string;
  question: string;
  slug: string | null;
}

/**
 * Returns all open neg-risk markets (negRisk=true, closed=false).
 * Caller groups by conditionId in application layer.
 */
export async function getNegRiskMarketsByCondition(db: Db): Promise<NegRiskMarketRow[]> {
  const rows = await db
    .select({
      tokenId: markets.tokenId,
      conditionId: markets.conditionId,
      question: markets.question,
      slug: markets.slug,
    })
    .from(markets)
    .where(and(eq(markets.negRisk, true), eq(markets.closed, false)));
  return rows.map((r) => ({
    tokenId: r.tokenId,
    conditionId: r.conditionId,
    question: r.question,
    slug: r.slug ?? null,
  }));
}

/**
 * Returns all watchlisted tokenIds including neg-risk tokens.
 * Distinct from getWatchlistedTokenIds which excludes neg-risk.
 * Used to subscribe all watchlisted tokens (including neg-risk) to ClobWsPool.
 */
export async function getAllWatchlistedTokenIds(db: Db): Promise<TokenId[]> {
  const rows = await db
    .select({ tokenId: markets.tokenId })
    .from(markets)
    .where(eq(markets.watchlisted, true));
  return rows.map((r) => r.tokenId);
}

export async function getMarketStats(db: Db, tokenId: TokenId) {
  const rows = await db
    .select()
    .from(marketStats)
    .where(eq(marketStats.tokenId, tokenId))
    .limit(1);
  return rows[0] ?? null;
}
