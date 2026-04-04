import type { VelocitySignal, TokenId } from "../events/types.js";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import { getRecentPriceHistory, getRecentTradeTimestamps } from "../db/queries/price-history.js";
import { config } from "../config.js";

type Db = NodePgDatabase<typeof schema>;

interface PriceEntry {
  price: number;
  timestamp: number;
}

interface TradeEntry {
  timestamp: number;
}

export class SentimentVelocityEvaluator {
  private readonly windowSeconds: number;
  private readonly priceThreshold: number;
  private readonly tradeCountMultiplier: number;
  private readonly cooldownMs: number;

  /** Per-token price buffer — entries within 2× windowMs */
  private readonly priceBuffer = new Map<TokenId, PriceEntry[]>();
  /** Per-token trade timestamp buffer — entries within 2× windowMs */
  private readonly tradeBuffer = new Map<TokenId, TradeEntry[]>();
  /** Per-token last-emit timestamp for cooldown */
  private readonly lastEmit = new Map<TokenId, number>();
  /**
   * Warm-up suppression: if a token has no bootstrap data, block evaluation
   * until both current and prior windows have been live-observed.
   */
  private readonly warmUntil = new Map<TokenId, number>();

  constructor(opts?: {
    windowSeconds?: number;
    priceThreshold?: number;
    tradeCountMultiplier?: number;
    cooldownMs?: number;
  }) {
    this.windowSeconds = opts?.windowSeconds ?? config.velocityWindowSeconds;
    this.priceThreshold = opts?.priceThreshold ?? config.velocityPriceThreshold;
    this.tradeCountMultiplier = opts?.tradeCountMultiplier ?? config.velocityTradeCountMultiplier;
    this.cooldownMs = opts?.cooldownMs ?? config.velocityCooldownMs;
  }

  /** Record a new price observation. Prunes stale entries automatically. */
  recordPrice(tokenId: TokenId, price: number, timestamp?: number): void {
    const ts = timestamp ?? Date.now();
    if (!this.priceBuffer.has(tokenId)) this.priceBuffer.set(tokenId, []);
    const buf = this.priceBuffer.get(tokenId)!;
    buf.push({ price, timestamp: ts });
    // Prune to 2× window
    const cutoff = ts - this.windowSeconds * 2 * 1000;
    const fresh = buf.filter((e) => e.timestamp >= cutoff);
    this.priceBuffer.set(tokenId, fresh);
  }

  /** Record a trade occurrence for count-velocity calculation. */
  recordTrade(tokenId: TokenId, timestamp?: number): void {
    const ts = timestamp ?? Date.now();

    // Set warm-up if this token is brand new (no bootstrap data)
    if (!this.tradeBuffer.has(tokenId) && !this.warmUntil.has(tokenId)) {
      this.warmUntil.set(tokenId, ts + this.windowSeconds * 2 * 1000);
    }

    if (!this.tradeBuffer.has(tokenId)) this.tradeBuffer.set(tokenId, []);
    const buf = this.tradeBuffer.get(tokenId)!;
    buf.push({ timestamp: ts });
    // Prune to 2× window
    const cutoff = ts - this.windowSeconds * 2 * 1000;
    const fresh = buf.filter((e) => e.timestamp >= cutoff);
    this.tradeBuffer.set(tokenId, fresh);
  }

  /**
   * Evaluate velocity for a token. Returns a signal or null.
   * Should be called after `recordTrade` and `recordPrice` for the current event.
   */
  evaluate(tokenId: TokenId, conditionId?: string): VelocitySignal | null {
    const now = Date.now();
    const windowMs = this.windowSeconds * 1000;

    // Warm-up guard
    const warm = this.warmUntil.get(tokenId);
    if (warm !== undefined && now < warm) return null;

    // Current window price data: [now - windowMs, now]
    const allPrices = this.priceBuffer.get(tokenId) ?? [];
    const currentPrices = allPrices.filter((p) => p.timestamp >= now - windowMs);

    if (currentPrices.length < 2) return null;

    const windowStartPrice = currentPrices[0].price;
    const latestPrice = currentPrices[currentPrices.length - 1].price;

    if (windowStartPrice === 0) return null;

    // Price velocity: % per minute
    const priceVelocity =
      ((latestPrice - windowStartPrice) / windowStartPrice / this.windowSeconds) * 60;

    if (Math.abs(priceVelocity) <= this.priceThreshold) return null;

    // Trade count velocity
    const allTrades = this.tradeBuffer.get(tokenId) ?? [];
    const currentTrades = allTrades.filter((t) => t.timestamp >= now - windowMs);
    const priorTrades = allTrades.filter(
      (t) => t.timestamp >= now - 2 * windowMs && t.timestamp < now - windowMs
    );
    const tradeCountVelocity = currentTrades.length / Math.max(priorTrades.length, 1);

    if (tradeCountVelocity <= this.tradeCountMultiplier) return null;

    // Cooldown
    const lastFired = this.lastEmit.get(tokenId) ?? 0;
    if (now - lastFired < this.cooldownMs) return null;

    // Direction and confidence
    const direction = priceVelocity > 0 ? "BULLISH" : "BEARISH";
    const confidence = Math.min(1.0, Math.abs(priceVelocity) / (this.priceThreshold * 3));

    this.lastEmit.set(tokenId, now);

    const resolvedConditionId = conditionId ?? tokenId;

    return {
      signalType: "SENTIMENT_VELOCITY",
      tokenId,
      conditionId: resolvedConditionId,
      direction,
      confidence,
      strength: tradeCountVelocity,
      priceAtSignal: latestPrice,
      createdAt: new Date(),
      payload: {
        priceVelocityPctPerMin: priceVelocity * 100,
        tradeCountVelocity,
        windowSeconds: this.windowSeconds,
        windowStartPrice,
        latestPrice,
      },
      tradeCountVelocity,
    };
  }

  /**
   * Bootstrap from DB: pre-populate price and trade buffers from historical data.
   * If both windows are covered by DB data, warm-up suppression is NOT applied.
   * If no data for a token, warm-up remains until 2× window has elapsed live.
   */
  async bootstrap(db: Db, tokenIds: TokenId[]): Promise<void> {
    const windowSeconds = this.windowSeconds * 2; // fetch 2× window for prior-window calculation

    await Promise.all(
      tokenIds.map(async (tokenId) => {
        try {
          // Populate price buffer
          const prices = await getRecentPriceHistory(db, tokenId, 500);
          if (prices.length > 0) {
            // getRecentPriceHistory returns newest-first — reverse for chronological order
            for (const p of [...prices].reverse()) {
              this.recordPrice(tokenId, p.price, p.recordedAt.getTime());
            }
          }

          // Populate trade buffer
          const tradeTs = await getRecentTradeTimestamps(db, tokenId, windowSeconds);
          if (tradeTs.length > 0) {
            for (const t of tradeTs) {
              // Direct insert without triggering warm-up logic
              if (!this.tradeBuffer.has(tokenId)) this.tradeBuffer.set(tokenId, []);
              this.tradeBuffer.get(tokenId)!.push({ timestamp: t.tradedAt.getTime() });
            }
          }

          // If we have data for both windows, skip warm-up
          const now = Date.now();
          const windowMs = this.windowSeconds * 1000;
          const allTrades = this.tradeBuffer.get(tokenId) ?? [];
          const priorWindow = allTrades.filter(
            (t) => t.timestamp >= now - 2 * windowMs && t.timestamp < now - windowMs
          );
          const currentWindow = allTrades.filter((t) => t.timestamp >= now - windowMs);

          if (priorWindow.length > 0 && currentWindow.length > 0) {
            // Both windows have data — no warm-up needed
            this.warmUntil.delete(tokenId);
          }
          // If only partial data, let warm-up remain (or not be set if token was never seen)
        } catch {
          // Bootstrap failure is non-fatal — warm-up suppression will handle it
        }
      })
    );
  }

  /** Clear all buffers — use in tests and on shutdown. */
  clear(): void {
    this.priceBuffer.clear();
    this.tradeBuffer.clear();
    this.lastEmit.clear();
    this.warmUntil.clear();
  }
}
