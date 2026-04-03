import type { TokenId, ConditionId, MarketStats } from "../events/types.js";
import { ZDataApiTrade } from "../validation/schemas.js";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import { upsertMarketStats } from "../db/queries/markets.js";

type Db = NodePgDatabase<typeof schema>;

const DATA_API_BASE = "https://data-api.polymarket.com";

/** Compute mean of a number array */
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Compute population stddev */
function stddev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / values.length;
  return Math.sqrt(variance);
}

/** Default uncalibrated stats returned when bootstrap fails */
function defaultStats(tokenId: TokenId): MarketStats {
  return {
    tokenId,
    volume24hr: 0,
    avgTradeSize24h: 0,
    stddevTradeSize24h: 0,
    liquidityUsdc: 0,
    tradeCount24h: 0,
    calibrated: false,
  };
}

/**
 * Fetch recent trades from data-api and compute market stats.
 * Sets calibrated=false if < 30 trades (sigma branch suppressed in WhaleDetector).
 */
export async function bootstrapMarketStats(
  db: Db,
  tokenId: TokenId,
  conditionId: ConditionId,
  fetchFn?: (url: string) => Promise<Response>
): Promise<MarketStats> {
  const fetch_ = fetchFn ?? fetch;

  let rawTrades: unknown[] = [];

  try {
    const url = `${DATA_API_BASE}/trades?conditionId=${conditionId}&limit=200`;
    const resp = await fetch_(url);

    if (resp.status === 429) {
      // Rate limited — return default uncalibrated stats, do not throw
      return defaultStats(tokenId);
    }

    if (!resp.ok) {
      return defaultStats(tokenId);
    }

    rawTrades = (await resp.json()) as unknown[];
  } catch {
    return defaultStats(tokenId);
  }

  const values: number[] = [];

  for (const raw of rawTrades) {
    const parsed = ZDataApiTrade.safeParse(raw);
    if (!parsed.success) continue;
    const valueUsdc = parsed.data.size * parsed.data.price;
    values.push(valueUsdc);
  }

  const count = values.length;
  const avg = mean(values);
  const sd = stddev(values, avg);
  const volume = values.reduce((a, b) => a + b, 0);
  const calibrated = count >= 30;

  const stats: MarketStats = {
    tokenId,
    volume24hr: volume,
    avgTradeSize24h: avg,
    stddevTradeSize24h: sd,
    liquidityUsdc: 0,
    tradeCount24h: count,
    calibrated,
  };

  await upsertMarketStats(db, {
    tokenId,
    conditionId,
    volume24hr: volume,
    avgTradeSize24h: avg,
    stddevTradeSize24h: sd,
    tradeCount24h: count,
  });

  return stats;
}

/**
 * In-memory ring buffer for rolling 24h trade stats per token.
 * Evicts entries older than 24 hours.
 */
export class RollingStatsBuffer {
  private readonly buffers = new Map<TokenId, Array<{ valueUsdc: number; tradedAt: Date }>>();

  addTrade(tokenId: TokenId, valueUsdc: number, tradedAt: Date): void {
    if (!this.buffers.has(tokenId)) {
      this.buffers.set(tokenId, []);
    }
    const buf = this.buffers.get(tokenId)!;
    buf.push({ valueUsdc, tradedAt });
    this.evictOld(tokenId);
  }

  private evictOld(tokenId: TokenId): void {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const buf = this.buffers.get(tokenId);
    if (!buf) return;
    const fresh = buf.filter((e) => e.tradedAt >= cutoff);
    this.buffers.set(tokenId, fresh);
  }

  getStats(tokenId: TokenId): { avg: number; stddev: number; volume: number; count: number } {
    this.evictOld(tokenId);
    const buf = this.buffers.get(tokenId) ?? [];
    const values = buf.map((e) => e.valueUsdc);
    const avg = mean(values);
    const sd = stddev(values, avg);
    const volume = values.reduce((a, b) => a + b, 0);
    return { avg, stddev: sd, volume, count: values.length };
  }
}
