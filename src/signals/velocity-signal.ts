import type { VelocitySignal, TokenId } from "../events/types.js";
import { config } from "../config.js";

const MIN_HISTORY_POINTS = 20;
const RECENT_WINDOW_POINTS = 12; // 60 min at 5-min buckets

export interface PriceBucket {
  price: number;
  bucketStart: Date;
}

export interface VelocityOptions {
  zScoreThreshold?: number;
  minLiquidityUsdc?: number;
  marketAgeMs?: number;
  categoryMedianReturn?: number | null;
  categoryMedianStdDev?: number | null;
}

/** Compute mean of an array */
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Compute population stddev */
function stddev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** Compute pairwise returns: (p[i+1] - p[i]) / p[i] */
function pairwiseReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 0; i < prices.length - 1; i++) {
    if (prices[i] > 0) {
      returns.push((prices[i + 1] - prices[i]) / prices[i]);
    }
  }
  return returns;
}

/**
 * Evaluate sentiment velocity for a token.
 * Returns a VelocitySignal or null.
 */
export function evaluateVelocity(
  tokenId: TokenId,
  conditionId: string,
  history24h: PriceBucket[],
  liquidityUsdc: number,
  opts: VelocityOptions = {}
): VelocitySignal | null {
  const threshold = opts.zScoreThreshold ?? config.velocityZScoreThreshold;
  const minLiquidityUsdc = opts.minLiquidityUsdc ?? config.minLiquidityUsdc;
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

  // Bootstrap guard: need at least 20 history points
  if (history24h.length < MIN_HISTORY_POINTS) return null;

  // Liquidity guard
  if (liquidityUsdc < minLiquidityUsdc) return null;

  const prices = history24h.map((b) => b.price);
  const returns = pairwiseReturns(prices);

  if (returns.length < 2) return null;

  // Determine baseline (24h returns or category median)
  const marketAgeMs = opts.marketAgeMs ?? Infinity;
  const isNewMarket = marketAgeMs < TWO_HOURS_MS;

  let baselineMean: number;
  let baselineStdDev: number;

  if (isNewMarket) {
    // Use category-median baseline
    if (opts.categoryMedianReturn == null || opts.categoryMedianStdDev == null) {
      // No category median available — skip (guard)
      return null;
    }
    baselineMean = opts.categoryMedianReturn;
    baselineStdDev = opts.categoryMedianStdDev;
  } else {
    baselineMean = mean(returns);
    baselineStdDev = stddev(returns, baselineMean);
  }

  if (baselineStdDev === 0) return null;

  // Recent 60-min window (last 12 buckets)
  const recentBuckets = history24h.slice(-RECENT_WINDOW_POINTS);
  const recentPrices = recentBuckets.map((b) => b.price);
  const firstRecent = recentPrices[0];
  const lastRecent = recentPrices[recentPrices.length - 1];

  if (!firstRecent || firstRecent <= 0) return null;

  const recentReturn = (lastRecent - firstRecent) / firstRecent;
  const hourlyChangePct = recentReturn * 100;
  const zScore = (recentReturn - baselineMean) / baselineStdDev;

  if (Math.abs(zScore) < threshold) return null;

  const direction = zScore > 0 ? "BULLISH" : "BEARISH" as const;
  const confidence = Math.min(1.0, Math.abs(zScore) / 4);

  return {
    signalType: "SENTIMENT_VELOCITY",
    tokenId,
    conditionId,
    direction,
    confidence,
    strength: zScore,
    priceAtSignal: lastRecent,
    createdAt: new Date(),
    payload: {
      zScore,
      hourlyChangePct,
      baselineMean,
      baselineStdDev,
      historyPoints: history24h.length,
    },
    velocityZScore: zScore,
    hourlyPriceChangePct: hourlyChangePct,
    baselineStdDev,
  };
}
