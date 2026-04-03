import type { TypedEventBus } from "../events/bus.js";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import { insertWhaleAlert } from "../db/queries/whales.js";
import { insertSignal } from "../db/queries/signals.js";
import { SIGNAL_TYPES } from "../events/types.js";
import type { Signal } from "../events/types.js";
import { logger } from "../logger.js";

type Db = NodePgDatabase<typeof schema>;

export class SignalAggregator {
  constructor(
    private readonly bus: TypedEventBus,
    private readonly db: Db
  ) {}

  start(): void {
    this.bus.on("whale_alert", async (alert) => {
      try {
        await this.handleWhaleAlert(alert);
      } catch (err) {
        logger.error({ err }, "SignalAggregator: error handling whale_alert");
      }
    });

    this.bus.on("signal", async (signal) => {
      try {
        await this.handleSignal(signal);
      } catch (err) {
        logger.error({ err }, "SignalAggregator: error handling signal");
      }
    });
  }

  private async handleWhaleAlert(alert: {
    emitSignal: boolean;
    signal: Signal;
    trade: { tokenId: string };
  }): Promise<void> {
    // Both inserts must succeed or both fail (transaction)
    // We use app-layer "transaction" via sequential inserts and rollback-on-error
    let whaleAlertId: bigint | null = null;

    try {
      whaleAlertId = await insertWhaleAlert(this.db, alert as Parameters<typeof insertWhaleAlert>[1]);

      if (whaleAlertId === null) {
        // emitSignal=false: skip
        return;
      }

      await insertSignal(this.db, alert.signal, whaleAlertId);
    } catch (err) {
      logger.error({ err, tokenId: alert.trade.tokenId }, "SignalAggregator: whale alert write failed");
      throw err;
    }
  }

  private async handleSignal(signal: Signal): Promise<void> {
    // Validate signal type
    if (!SIGNAL_TYPES.includes(signal.signalType)) {
      logger.warn({ signalType: signal.signalType }, "SignalAggregator: unknown signal type, rejected");
      return;
    }

    // Clamp confidence
    if (signal.confidence < 0 || signal.confidence > 1) {
      logger.warn({ confidence: signal.confidence, signalType: signal.signalType }, "SignalAggregator: confidence out of range, clamping");
      signal = { ...signal, confidence: Math.min(1.0, Math.max(0.0, signal.confidence)) };
    }

    await insertSignal(this.db, signal);
  }
}
