import type { PriceImpactSignal, TokenId } from "../events/types.js";
import { config } from "../config.js";

export interface PricePoint {
  price: number;
  recordedAt: Date;
}

export interface PriceImpactOptions {
  windowSec?: number;
  minChangePct?: number;
  minLiquidityUsdc?: number;
}

/**
 * Evaluate price impact over the last windowSec seconds.
 * Returns a PriceImpactSignal or null.
 */
export function evaluatePriceImpact(
  tokenId: TokenId,
  conditionId: string,
  priceHistory: PricePoint[],
  triggeringTradeValueUsdc: number,
  liquidityUsdc: number,
  opts: PriceImpactOptions = {}
): PriceImpactSignal | null {
  const windowSec = opts.windowSec ?? config.priceImpactWindowSec;
  const minChangePct = opts.minChangePct ?? config.priceImpactMinChangePct;
  const minLiquidityUsdc = opts.minLiquidityUsdc ?? config.minLiquidityUsdc;

  // Bootstrap guard: need at least 2 data points
  if (priceHistory.length < 2) return null;

  const priceStart = priceHistory[0].price;
  const priceEnd = priceHistory[priceHistory.length - 1].price;

  if (priceStart <= 0) return null;

  const changePct = Math.abs(priceEnd - priceStart) / priceStart * 100;

  if (changePct < minChangePct) return null;

  // Liquidity guard
  if (liquidityUsdc < minLiquidityUsdc) return null;

  const direction = priceEnd > priceStart ? "BULLISH" : "BEARISH" as const;
  const confidence = Math.min(1.0, changePct / 10);

  return {
    signalType: "PRICE_IMPACT_ANOMALY",
    tokenId,
    conditionId,
    direction,
    confidence,
    strength: changePct,
    priceAtSignal: priceEnd,
    createdAt: new Date(),
    payload: {
      priceStart,
      priceEnd,
      changePct,
      windowSec,
      triggeringTradeValueUsdc,
    },
    priceChangePct: changePct,
    windowSeconds: windowSec,
    triggeringTradeValueUsdc,
  };
}
