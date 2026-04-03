import type { WhaleAlert } from "../events/types.js";
import type { TypedEventBus } from "../events/bus.js";
import { logger } from "../logger.js";

const LATENCY_WARN_THRESHOLD_MS = 1000;

/** Format a whale alert for stdout display */
export function formatWhaleAlert(alert: WhaleAlert): string {
  const { trade, signal, usdcValue, bookSnapshotAgeMs } = alert;
  const sigmasStr = signal.sigmasAboveMean > 0
    ? `${signal.sigmasAboveMean.toFixed(1)}σ above mean`
    : "pct-of-vol only";
  const pctStr = (signal.pctOfDailyVolume * 100).toFixed(2);
  const bookAgeStr = bookSnapshotAgeMs > 0 ? ` [book age: ${bookSnapshotAgeMs}ms]` : "";

  return [
    "🐋 WHALE ALERT",
    `Market:  ${trade.marketTitle || trade.marketSlug || trade.tokenId}`,
    `Side:    ${trade.side} ${trade.outcome} @ $${trade.priceUsdc.toFixed(4)}`,
    `Value:   $${usdcValue.toLocaleString("en-US", { maximumFractionDigits: 0 })} USDC  (${sigmasStr}, ${pctStr}% of daily vol)`,
    `Wallet:  ${trade.proxyWallet}`,
    `Tx:      ${trade.transactionHash}${bookAgeStr}`,
  ].join("\n");
}

export class AlertEmitter {
  private readonly whaleHandler: (alert: WhaleAlert) => void;

  constructor(private readonly bus: TypedEventBus) {
    this.whaleHandler = (alert) => this.emit(alert);
  }

  start(): void {
    this.bus.on("whale_alert", this.whaleHandler);
  }

  /** Remove the whale_alert listener registered by start(). */
  stop(): void {
    this.bus.off("whale_alert", this.whaleHandler);
  }

  emit(alert: WhaleAlert): void {
    const now = Date.now();
    const alertLatencyMs = now - alert.trade.tradedAt.getTime();

    // Structured JSON log
    logger.info({
      type: "whale_alert",
      tokenId: alert.trade.tokenId,
      conditionId: alert.trade.conditionId,
      side: alert.trade.side,
      price: alert.trade.priceUsdc,
      usdcValue: alert.usdcValue,
      sigmasAboveMean: alert.signal.sigmasAboveMean,
      pctOfDailyVolume: alert.signal.pctOfDailyVolume,
      confidence: alert.signal.confidence,
      direction: alert.signal.direction,
      proxyWallet: alert.trade.proxyWallet,
      transactionHash: alert.trade.transactionHash,
      marketTitle: alert.trade.marketTitle,
      alertLatencyMs,
    });

    if (alertLatencyMs > LATENCY_WARN_THRESHOLD_MS) {
      logger.warn({
        alertLatencyMs,
        threshold: LATENCY_WARN_THRESHOLD_MS,
        tokenId: alert.trade.tokenId,
      }, "AlertEmitter: latency > 1s");
    }

    // Human-readable stdout
    console.log(formatWhaleAlert(alert));
  }
}
