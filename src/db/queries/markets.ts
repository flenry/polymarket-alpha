import { eq, and, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../schema.js";
import { markets, marketStats } from "../schema.js";
import type { GammaMarket } from "../../validation/schemas.js";
import type { TokenId } from "../../events/types.js";

type Db = NodePgDatabase<typeof schema>;

export async function upsertMarket(db: Db, market: GammaMarket & { tokenId: string; watchlisted: boolean; negRisk: boolean }): Promise<void> {
  await db
    .insert(markets)
    .values({
      tokenId: market.tokenId,
      conditionId: market.conditionId,
      question: market.question ?? "",
      slug: market.slug ?? null,
      eventSlug: market.eventSlug ?? null,
      category: market.category ?? null,
      outcome: "",
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

export async function getMarketStats(db: Db, tokenId: TokenId) {
  const rows = await db
    .select()
    .from(marketStats)
    .where(eq(marketStats.tokenId, tokenId))
    .limit(1);
  return rows[0] ?? null;
}
