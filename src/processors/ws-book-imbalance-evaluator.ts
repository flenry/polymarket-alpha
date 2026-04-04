import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import type { TypedEventBus } from "../events/bus.js";
import type { TokenId, OrderBook, ImbalanceSignal } from "../events/types.js";
import { insertBookSnapshot } from "../db/queries/snapshots.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

type Db = NodePgDatabase<typeof schema>;

export class WsBookImbalanceEvaluator {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly lastEmits = new Map<TokenId, number>();

  constructor(
    private readonly bus: TypedEventBus,
    private readonly db: Db,
    opts?: { threshold?: number; cooldownMs?: number }
  ) {
    this.threshold = opts?.threshold ?? config.imbalanceRatioThreshold;
    this.cooldownMs = opts?.cooldownMs ?? config.imbalanceCooldownMs;
  }

  evaluate(book: OrderBook): void {
    const { tokenId, conditionId, bids, asks } = book;

    // Compute depths — full book (no top-N restriction; TODO: consider capping for performance at scale)
    const bidDepthUsdc = bids.reduce((sum, l) => sum + l.price * l.size, 0);
    const askDepthUsdc = asks.reduce((sum, l) => sum + l.price * l.size, 0);

    // Guard: skip if no ask-side depth (avoids division by zero)
    if (askDepthUsdc === 0) return;

    const ratio = bidDepthUsdc / askDepthUsdc;

    // Always persist a ws_event snapshot regardless of signal decision
    insertBookSnapshot(this.db, {
      tokenId,
      conditionId,
      bids: bids.map((l) => ({ price: l.price.toString(), size: l.size.toString() })),
      asks: asks.map((l) => ({ price: l.price.toString(), size: l.size.toString() })),
      bidDepthUsdc,
      askDepthUsdc,
      imbalanceRatio: ratio,
      snapshotTrigger: "ws_event",
      capturedAt: new Date(),
    }).catch((err) => {
      logger.error({ err, tokenId }, "WsBookImbalanceEvaluator: snapshot insert failed");
    });

    const isBullish = ratio > this.threshold;
    const isBearish = ratio < 1 / this.threshold;

    if (!isBullish && !isBearish) return;

    // Cooldown check
    const lastEmit = this.lastEmits.get(tokenId);
    if (lastEmit !== undefined && Date.now() - lastEmit < this.cooldownMs) return;

    // Signal parameters
    const direction = isBullish ? "BULLISH" : "BEARISH";
    const confidence = isBullish
      ? Math.min(1.0, (ratio - this.threshold) / this.threshold)
      : Math.min(1.0, (1 / ratio - this.threshold) / this.threshold);
    const strength = bidDepthUsdc + askDepthUsdc;
    const priceAtSignal =
      bids.length > 0 && asks.length > 0 ? (bids[0].price + asks[0].price) / 2 : 0;

    this.lastEmits.set(tokenId, Date.now());

    const signal: ImbalanceSignal = {
      signalType: "ORDER_BOOK_IMBALANCE",
      tokenId,
      conditionId,
      direction,
      confidence,
      strength,
      priceAtSignal,
      createdAt: new Date(),
      payload: { ratio, bidDepthUsdc, askDepthUsdc, source: "ws_event" },
      imbalanceRatio: ratio,
      bidDepthUsdc,
      askDepthUsdc,
    };

    this.bus.emit("signal", signal);
  }

  /** Reset cooldown for a specific token — useful in tests */
  resetCooldown(tokenId: TokenId): void {
    this.lastEmits.delete(tokenId);
  }
}
