import type { TradeEvent, MarketStats, OrderBook, WhaleAlert, WhaleSignal, SignalDirection } from "../events/types.js";
import { config } from "../config.js";

export interface WhaleDetectorOptions {
  absoluteMinUsdc?: number;
  sigmaThreshold?: number;
  pctVolumeThreshold?: number;
  minLiquidityUsdc?: number;
}

/**
 * Walk the order book to estimate price impact.
 * Returns avgFillPrice, totalFilled (usdc), depthConsumedPct.
 */
function estimatePriceImpact(
  trade: TradeEvent,
  book: OrderBook
): { priceImpactEstimateUsdc: number; bookDepthConsumedPct: number } {
  const levels = trade.side === "BUY" ? book.asks : book.bids;
  const mid =
    book.bids.length > 0 && book.asks.length > 0
      ? (book.bids[0].price + book.asks[0].price) / 2
      : trade.priceUsdc;

  let remaining = trade.valueUsdc;
  let totalFilled = 0;
  let avgFillPrice = 0;
  const totalDepth = levels.reduce((s, l) => s + l.price * l.size, 0);

  for (const level of levels) {
    const levelUsdc = level.price * level.size;
    const consumed = Math.min(remaining, levelUsdc);
    avgFillPrice =
      (avgFillPrice * totalFilled + level.price * (consumed / level.price)) /
      (totalFilled + consumed / level.price || 1);
    totalFilled += consumed;
    remaining -= consumed;
    if (remaining <= 0) break;
  }

  const priceImpactEstimateUsdc = Math.abs(avgFillPrice - mid);
  const bookDepthConsumedPct = totalDepth > 0 ? (totalFilled / totalDepth) * 100 : 0;

  return { priceImpactEstimateUsdc, bookDepthConsumedPct };
}

/**
 * WhaleDetector: dual-threshold evaluation.
 *
 * Gate 1: valueUsdc >= absoluteMinUsdc (filters dust)
 * Gate 2: sigmasAboveMean >= sigmaThreshold (if calibrated) OR pctOfDailyVolume >= threshold
 */
export class WhaleDetector {
  private readonly absoluteMinUsdc: number;
  private readonly sigmaThreshold: number;
  private readonly pctVolumeThreshold: number;
  private readonly minLiquidityUsdc: number;

  constructor(opts: WhaleDetectorOptions = {}) {
    this.absoluteMinUsdc = opts.absoluteMinUsdc ?? config.absoluteMinUsdc;
    this.sigmaThreshold = opts.sigmaThreshold ?? config.sigmaThreshold;
    this.pctVolumeThreshold = opts.pctVolumeThreshold ?? config.pctVolumeThreshold;
    this.minLiquidityUsdc = opts.minLiquidityUsdc ?? config.minLiquidityUsdc;
  }

  evaluate(trade: TradeEvent, stats: MarketStats, book: OrderBook | null): WhaleAlert | null {
    // Gate 1: absolute minimum
    if (trade.valueUsdc < this.absoluteMinUsdc) return null;

    // Market stats must be available
    const stddev = stats.stddevTradeSize24h;
    const isCalibrated = stats.calibrated && stddev > 0;

    // Gate 2: relative check
    const sigmasAboveMean = isCalibrated
      ? (trade.valueUsdc - stats.avgTradeSize24h) / stddev
      : -Infinity; // calibrated=false: skip sigma branch

    const pctOfDailyVolume = stats.volume24hr > 0 ? trade.valueUsdc / stats.volume24hr : 0;

    const isRelativeLarge =
      (isCalibrated && sigmasAboveMean >= this.sigmaThreshold) ||
      pctOfDailyVolume >= this.pctVolumeThreshold;

    if (!isRelativeLarge) return null;

    // Liquidity guard: skip DB/alert emission if market too thin
    const emitSignal = stats.liquidityUsdc >= this.minLiquidityUsdc;

    // Price impact estimation
    let priceImpactEstimateUsdc = 0;
    let bookDepthConsumedPct = 0;
    let bookSnapshotAgeMs = 0;

    if (book) {
      const impact = estimatePriceImpact(trade, book);
      priceImpactEstimateUsdc = impact.priceImpactEstimateUsdc;
      bookDepthConsumedPct = impact.bookDepthConsumedPct;
      bookSnapshotAgeMs = Date.now() - book.capturedAt.getTime();
    }

    // Direction: BUY → BULLISH, SELL → BEARISH
    const direction: SignalDirection = trade.side === "BUY" ? "BULLISH" : "BEARISH";

    // Confidence: anchored at 3σ → 0.5, 6σ → 1.0; use pct-of-volume if uncalibrated
    const rawConfidence = isCalibrated
      ? Math.min(1.0, sigmasAboveMean / 6)
      : Math.min(1.0, (pctOfDailyVolume / this.pctVolumeThreshold) * 0.5);

    const confidence = Math.min(1.0, Math.max(0.0, rawConfidence));

    const signal: WhaleSignal = {
      signalType: "WHALE_TRADE",
      tokenId: trade.tokenId,
      conditionId: trade.conditionId,
      direction,
      confidence,
      strength: isCalibrated && isFinite(sigmasAboveMean) ? sigmasAboveMean : pctOfDailyVolume * 100,
      priceAtSignal: trade.priceUsdc,
      createdAt: new Date(),
      payload: {
        sigmasAboveMean: isFinite(sigmasAboveMean) ? sigmasAboveMean : null,
        pctOfDailyVolume,
        calibrated: isCalibrated,
        bookSnapshotAgeMs: book ? bookSnapshotAgeMs : null,
      },
      usdcValue: trade.valueUsdc,
      sigmasAboveMean: isCalibrated && isFinite(sigmasAboveMean) ? sigmasAboveMean : 0,
      pctOfDailyVolume,
      proxyWallet: trade.proxyWallet,
      transactionHash: trade.transactionHash,
      priceImpactEstimate: priceImpactEstimateUsdc,
      bookDepthConsumedPct,
      bookSnapshotAgeMs,
    };

    return {
      trade,
      usdcValue: trade.valueUsdc,
      marketStats: stats,
      priceAtAlert: trade.priceUsdc,
      priceImpactEstimateUsdc,
      bookDepthConsumedPct,
      bookSnapshotAgeMs,
      book,
      signal,
      emitSignal,
    };
  }
}
