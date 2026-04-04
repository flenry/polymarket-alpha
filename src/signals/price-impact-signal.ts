import type { PriceImpactSignal, TradeEvent, TokenId } from "../events/types.js";
import type { SnapshotRecord } from "../db/queries/snapshots.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

export class PriceImpactSignalEvaluator {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly lastEmit = new Map<TokenId, number>();

  constructor(opts?: { threshold?: number; cooldownMs?: number }) {
    this.threshold = opts?.threshold ?? config.priceImpactAnomalyThreshold;
    this.cooldownMs = opts?.cooldownMs ?? config.priceImpactCooldownMs;
  }

  /**
   * Evaluate whether a trade triggered an anomalous price impact.
   *
   * All data is passed in — no DB reads on the hot path.
   *
   * @param trade          - The trade event
   * @param priceBeforeTrade - Last recorded price before this trade (null on cold start)
   * @param priceNow       - Current trade price (trade.priceUsdc)
   * @param snapshot       - Most recent order-book snapshot (null if unavailable)
   */
  async evaluate(
    trade: TradeEvent,
    priceBeforeTrade: number | null,
    priceNow: number,
    snapshot: SnapshotRecord | null
  ): Promise<PriceImpactSignal | null> {
    const { tokenId, conditionId } = trade;

    // 1. Guard: need a snapshot
    if (!snapshot) return null;

    // 2. Staleness guard (60s)
    const snapshotAgeMs = Date.now() - snapshot.capturedAt.getTime();
    if (snapshotAgeMs > 60_000) {
      logger.warn({ tokenId, snapshotAgeMs }, "PriceImpactSignalEvaluator: stale snapshot, skipping");
      return null;
    }

    // 3. Guard: need prior price
    if (priceBeforeTrade === null || priceBeforeTrade === 0) return null;

    // 4. Corrected depth mapping: BUY consumes ask-side, SELL consumes bid-side (LAW-MINOR-1)
    const depthUsdc =
      trade.side === "BUY" ? (snapshot.askDepthUsdc ?? null) : (snapshot.bidDepthUsdc ?? null);

    if (!depthUsdc || depthUsdc === 0) return null;

    // 5. Expected impact = value traded / available depth
    const expectedImpact = trade.valueUsdc / depthUsdc;

    // 6. Actual impact = |Δprice| / priceBeforeTrade
    const actualImpact = Math.abs(priceNow - priceBeforeTrade) / priceBeforeTrade;

    // 7. Anomaly score
    const score = expectedImpact === 0 ? 0 : actualImpact / expectedImpact;
    if (score <= this.threshold) return null;

    // 8. Cooldown per token
    const lastFired = this.lastEmit.get(tokenId) ?? 0;
    if (Date.now() - lastFired < this.cooldownMs) return null;

    // 9. Build signal
    const direction = trade.side === "BUY" ? "BULLISH" : "BEARISH";
    const confidence = Math.min(1.0, (score - this.threshold) / this.threshold);

    this.lastEmit.set(tokenId, Date.now());

    return {
      signalType: "PRICE_IMPACT_ANOMALY",
      tokenId,
      conditionId,
      direction,
      confidence,
      strength: score,
      priceAtSignal: priceNow,
      createdAt: new Date(),
      payload: {
        score,
        expectedImpact,
        actualImpact,
        depthUsdc,
        valueUsdc: trade.valueUsdc,
        priceBeforeTrade,
        priceNow,
        snapshotAgeMs,
      },
      priceChangePct: actualImpact * 100,
      windowSeconds: 0,
      triggeringTradeValueUsdc: trade.valueUsdc,
    };
  }

  /** Reset cooldown for a specific token — useful in tests. */
  resetCooldown(tokenId: TokenId): void {
    this.lastEmit.delete(tokenId);
  }
}
