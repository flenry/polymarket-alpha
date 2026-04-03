import type { OrderBook, ImbalanceSignal, TokenId } from "../events/types.js";
import type { TypedEventBus } from "../events/bus.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

const DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes
const RATIO_SHIFT_THRESHOLD = 0.5; // re-emit within window if ratio shifts > 0.5
const TOP_N_LEVELS = 10;

/** Compute depth as sum(price × size) for top-N levels */
function computeDepth(levels: Array<{ price: number; size: number }>, n = TOP_N_LEVELS): number {
  return levels.slice(0, n).reduce((sum, l) => sum + l.price * l.size, 0);
}

interface LastEmit {
  timestamp: number;
  ratio: number;
}

export class OrderBookImbalanceEngine {
  private readonly lastEmits = new Map<TokenId, LastEmit>();
  private readonly threshold: number;

  constructor(
    private readonly bus: TypedEventBus,
    threshold = config.imbalanceRatioThreshold
  ) {
    this.threshold = threshold;
  }

  /**
   * Evaluate a book snapshot for imbalance.
   * Called by SnapshotWriter after each snapshot write.
   */
  evaluate(book: OrderBook, stats?: { liquidityUsdc?: number }): ImbalanceSignal | null {
    const bidDepthUsdc = computeDepth(book.bids, TOP_N_LEVELS);
    const askDepthUsdc = computeDepth(book.asks, TOP_N_LEVELS);

    if (askDepthUsdc === 0) return null;

    const imbalanceRatio = bidDepthUsdc / askDepthUsdc;
    const isBullish = imbalanceRatio > this.threshold;
    const isBearish = imbalanceRatio < 1 / this.threshold;

    if (!isBullish && !isBearish) return null;

    // Liquidity guard
    if (stats?.liquidityUsdc !== undefined && stats.liquidityUsdc < config.minLiquidityUsdc) {
      return null;
    }

    // Debounce: skip if emitted within 5 min AND ratio hasn't shifted > 0.5
    const last = this.lastEmits.get(book.tokenId);
    const now = Date.now();
    if (last) {
      const withinWindow = now - last.timestamp < DEBOUNCE_MS;
      const ratioShifted = Math.abs(imbalanceRatio - last.ratio) > RATIO_SHIFT_THRESHOLD;
      if (withinWindow && !ratioShifted) return null;
    }

    const direction = isBullish ? "BULLISH" : "BEARISH" as const;
    const confidence = isBullish
      ? Math.min(1.0, (imbalanceRatio - 1) / 4)
      : Math.min(1.0, (1 - imbalanceRatio) * 3);

    const mid =
      book.bids.length > 0 && book.asks.length > 0
        ? (book.bids[0].price + book.asks[0].price) / 2
        : 0;

    // Update debounce state
    this.lastEmits.set(book.tokenId, { timestamp: now, ratio: imbalanceRatio });

    const signal: ImbalanceSignal = {
      signalType: "ORDER_BOOK_IMBALANCE",
      tokenId: book.tokenId,
      conditionId: book.conditionId,
      direction,
      confidence,
      strength: imbalanceRatio,
      priceAtSignal: mid,
      createdAt: new Date(),
      payload: {
        imbalanceRatio,
        bidDepthUsdc,
        askDepthUsdc,
        topNLevels: TOP_N_LEVELS,
      },
      imbalanceRatio,
      bidDepthUsdc,
      askDepthUsdc,
    };

    this.bus.emit("signal", signal);
    return signal;
  }

  /** Reset debounce state for a token (testing) */
  resetDebounce(tokenId: TokenId): void {
    this.lastEmits.delete(tokenId);
  }
}
