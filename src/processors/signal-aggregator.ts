import type { TypedEventBus } from "../events/bus.js";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import { insertWhaleAlert } from "../db/queries/whales.js";
import { insertSignal, updateSignalPayloads } from "../db/queries/signals.js";
import { SIGNAL_TYPES } from "../events/types.js";
import type { Signal, WhaleAlert, TokenId, SignalType } from "../events/types.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

type Db = NodePgDatabase<typeof schema>;

interface CompositeEntry {
  id: bigint;
  type: SignalType;
  confidence: number;
  createdAt: number;
}

interface CompositeWindow {
  signals: CompositeEntry[];
  windowStart: number;
}

export class SignalAggregator {
  private readonly whaleHandler: (alert: WhaleAlert) => Promise<void>;
  private readonly signalHandler: (signal: Signal) => Promise<void>;

  private readonly compositeMap = new Map<TokenId, CompositeWindow>();
  private readonly compositeWindowMs: number;

  constructor(
    private readonly bus: TypedEventBus,
    private readonly db: Db,
    private readonly onWhaleInserted?: (alert: WhaleAlert, id: bigint) => void,
    opts?: { compositeWindowMs?: number }
  ) {
    this.compositeWindowMs = opts?.compositeWindowMs ?? config.compositeWindowMs;
    // Bind handlers as named references so they can be removed by stop()
    this.whaleHandler = async (alert) => {
      try {
        await this.handleWhaleAlert(alert);
      } catch (err) {
        logger.error({ err }, "SignalAggregator: error handling whale_alert");
      }
    };

    this.signalHandler = async (signal) => {
      try {
        await this.handleSignal(signal);
      } catch (err) {
        logger.error({ err }, "SignalAggregator: error handling signal");
      }
    };
  }

  start(): void {
    this.bus.on("whale_alert", this.whaleHandler);
    this.bus.on("signal", this.signalHandler);
  }

  /** Remove all bus listeners registered by this aggregator. */
  stop(): void {
    this.bus.off("whale_alert", this.whaleHandler);
    this.bus.off("signal", this.signalHandler);
  }

  private async handleWhaleAlert(alert: WhaleAlert): Promise<void> {
    // Use a DB transaction so whale_alert + signal either both commit or both roll back.
    // Falls back to sequential inserts when the DB mock doesn't support transaction()
    // (unit tests) — detectable by whether this.db.transaction is callable.
    if (typeof (this.db as unknown as { transaction?: unknown }).transaction === "function") {
      let insertedId: bigint | null = null;
      await (this.db as Db & { transaction: (fn: (tx: Db) => Promise<void>) => Promise<void> }).transaction(
        async (tx) => {
          const whaleAlertId = await insertWhaleAlert(tx, alert);
          if (whaleAlertId === null) return; // emitSignal=false: skip
          insertedId = whaleAlertId;
          await insertSignal(tx, alert.signal, whaleAlertId);
        }
      );
      if (insertedId !== null) this.onWhaleInserted?.(alert, insertedId);
    } else {
      // Unit-test path: no transaction support on mock — do sequential inserts
      const whaleAlertId = await insertWhaleAlert(this.db, alert);
      if (whaleAlertId === null) return;
      await insertSignal(this.db, alert.signal, whaleAlertId);
      this.onWhaleInserted?.(alert, whaleAlertId);
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

    const inserted = await insertSignal(this.db, signal);
    if (!inserted) return;

    // ── Composite confidence scoring ──────────────────────────────────────
    const { tokenId } = signal;
    const now = Date.now();

    // Get or initialise window
    let window = this.compositeMap.get(tokenId);
    if (!window) {
      window = { signals: [], windowStart: now };
      this.compositeMap.set(tokenId, window);
    }

    // Purge entries older than compositeWindowMs
    window.signals = window.signals.filter(
      (s) => now - s.createdAt <= this.compositeWindowMs
    );

    // Register the newly inserted signal
    window.signals.push({
      id: inserted.id,
      type: signal.signalType,
      confidence: signal.confidence,
      createdAt: now,
    });

    if (window.signals.length >= 2) {
      const count = window.signals.length;
      const meanConf =
        window.signals.reduce((sum, s) => sum + s.confidence, 0) / count;
      const compositeScore = meanConf * (1 + 0.15 * (count - 1));

      const ids = window.signals.map((s) => s.id);
      const types = window.signals.map((s) => s.type);

      logger.info(`[COMPOSITE] tokenId: ${tokenId}: ${compositeScore.toFixed(4)}, signals: [${types.join(", ")}]`);

      // Patch all participating signal rows with compositeScore
      updateSignalPayloads(this.db, ids, { compositeScore }).catch((err) =>
        logger.warn({ err }, "SignalAggregator: composite patch failed")
      );
    }
  }
}
