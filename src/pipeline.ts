import { db, closeDb } from "./db/client.js";
import { bus } from "./events/bus.js";
import { config } from "./config.js";
import { PartitionManager } from "./db/partition-manager.js";
import { GammaPoller } from "./sources/gamma-poller.js";
import { LiveDataWsClient } from "./sources/live-data-ws-client.js";
import { ClobRestClient } from "./sources/clob-rest-client.js";
import { SnapshotWriter } from "./processors/snapshot-writer.js";
import { WhaleDetector } from "./processors/whale-detector.js";
import { AlertEmitter } from "./alerts/alert-emitter.js";
import { SignalAggregator } from "./processors/signal-aggregator.js";
import { OrderBookImbalanceEngine } from "./processors/book-imbalance-engine.js";
import { PriceHistoryWriter } from "./processors/price-history-writer.js";
import { insertTrade } from "./db/queries/trades.js";
import { getMarketStats } from "./db/queries/markets.js";
import { RollingStatsBuffer } from "./sources/stats-bootstrap.js";
import { evaluatePriceImpact } from "./signals/price-impact-signal.js";
import { evaluateVelocity } from "./signals/velocity-signal.js";
import type { MarketStats, TradeEvent, OrderBook, TokenId } from "./events/types.js";
import { logger } from "./logger.js";

/** In-memory sliding window of recent price points per token (for price-impact signal) */
const recentPrices = new Map<TokenId, Array<{ price: number; recordedAt: Date }>>();
const PRICE_WINDOW_MS = 120_000; // keep 2 min of history (covers 60s window + buffer)

function recordPrice(tokenId: TokenId, price: number): void {
  if (!recentPrices.has(tokenId)) recentPrices.set(tokenId, []);
  const buf = recentPrices.get(tokenId)!;
  buf.push({ price, recordedAt: new Date() });
  // Evict entries older than window
  const cutoff = new Date(Date.now() - PRICE_WINDOW_MS);
  const fresh = buf.filter((p) => p.recordedAt >= cutoff);
  recentPrices.set(tokenId, fresh);
}

/** 24h price bucket store per token (for velocity signal) — 5-min buckets */
const priceBuckets = new Map<TokenId, Array<{ price: number; bucketStart: Date }>>();
const BUCKET_MS = 5 * 60 * 1000;
const MAX_BUCKETS = 288; // 24h / 5min

function recordBucketPrice(tokenId: TokenId, price: number): void {
  if (!priceBuckets.has(tokenId)) priceBuckets.set(tokenId, []);
  const buf = priceBuckets.get(tokenId)!;
  const now = Date.now();
  const bucketStart = new Date(Math.floor(now / BUCKET_MS) * BUCKET_MS);

  // Update last bucket if same time slot, else push new
  if (buf.length > 0 && buf[buf.length - 1].bucketStart.getTime() === bucketStart.getTime()) {
    buf[buf.length - 1].price = price;
  } else {
    buf.push({ price, bucketStart });
    if (buf.length > MAX_BUCKETS) buf.shift();
  }
}

export async function startPipeline(): Promise<() => Promise<void>> {
  logger.info("Pipeline: starting");

  // 1. Ensure partitions exist for today and tomorrow
  const partitionManager = new PartitionManager(db);
  await partitionManager.ensureCurrentPartitions().catch((err) =>
    logger.warn({ err }, "Pipeline: partition ensure failed (may not have DB yet)")
  );
  partitionManager.start();

  // 2. Create negRisk set and market stats cache (will be populated by GammaPoller)
  const negRiskSet = new Set<string>();
  const statsCache = new Map<string, MarketStats>();
  /** Maps tokenId → conditionId for use in signal emission */
  const conditionIdMap = new Map<string, string>();

  // Rolling 24h stats buffer — updated on every live trade, recomputed every 60s
  const rollingBuffer = new RollingStatsBuffer();

  // 3. Start GammaPoller
  const gammaPoller = new GammaPoller({
    db,
    pollIntervalMs: config.gammaPollIntervalMs,
    watchlistSize: config.watchlistSize,
  });

  gammaPoller.on("markets_updated", (_tokenIds, negRiskIds) => {
    for (const id of negRiskIds) negRiskSet.add(id);
  });

  await gammaPoller.start();

  // 4. Start LiveDataWsClient
  const liveDataWs = new LiveDataWsClient({
    bus,
    negRiskSet,
    reconnectBaseMs: config.reconnectBaseMs,
    reconnectMaxMs: config.reconnectMaxMs,
  });

  liveDataWs.connect();

  // 5. Wire trade persistence with batching
  const tradeBatch: TradeEvent[] = [];
  let flushTimer: ReturnType<typeof setInterval> | null = null;

  async function flushTradeBatch(): Promise<void> {
    if (tradeBatch.length === 0) return;
    const batch = tradeBatch.splice(0, tradeBatch.length);
    for (const trade of batch) {
      try {
        await insertTrade(db, trade);
      } catch (err) {
        logger.error({ err, tokenId: trade.tokenId }, "Pipeline: trade insert failed");
      }
    }
  }

  flushTimer = setInterval(() => {
    flushTradeBatch().catch((err) =>
      logger.error({ err }, "Pipeline: batch flush error")
    );
  }, config.tradeBatchFlushMs);

  bus.on("trade", async (trade) => {
    // Feed rolling buffer for live stats accumulation
    rollingBuffer.addTrade(trade.tokenId, trade.valueUsdc, trade.tradedAt);

    // Record price for PRICE_IMPACT_ANOMALY signal
    recordPrice(trade.tokenId, trade.priceUsdc);
    recordBucketPrice(trade.tokenId, trade.priceUsdc);

    tradeBatch.push(trade);
    if (tradeBatch.length >= config.tradeBatchSize) {
      await flushTradeBatch();
    }
  });

  // Also record price from best_bid_ask events (midpoint)
  bus.on("best_bid_ask", (evt) => {
    const mid = (evt.bid + evt.ask) / 2;
    recordPrice(evt.tokenId, mid);
    recordBucketPrice(evt.tokenId, mid);
  });

  bus.on("last_trade_price", (evt) => {
    recordPrice(evt.tokenId, evt.price);
    recordBucketPrice(evt.tokenId, evt.price);
  });

  // 6. Start ClobRestClient + SnapshotWriter
  const clobClient = new ClobRestClient();

  // 7. WhaleDetector + AlertEmitter (wire before SnapshotWriter so onBook is available)
  const detector = new WhaleDetector();
  const alertEmitter = new AlertEmitter(bus);
  alertEmitter.start();

  // 8. OrderBookImbalanceEngine + PriceImpactSignal — called after each book snapshot
  const imbalanceEngine = new OrderBookImbalanceEngine(bus);

  const snapshotWriter = new SnapshotWriter(
    db,
    clobClient,
    () => gammaPoller.getWatchlist(),
    config.snapshotIntervalMs,
    (book: OrderBook) => {
      // Evaluate imbalance after each book snapshot is persisted
      imbalanceEngine.evaluate(book);

      // Evaluate price impact using recent in-memory price history
      const tokenPrices = recentPrices.get(book.tokenId) ?? [];
      const windowCutoff = new Date(Date.now() - config.priceImpactWindowSec * 1000);
      const windowPrices = tokenPrices.filter((p) => p.recordedAt >= windowCutoff);

      if (windowPrices.length >= 2) {
        const impactSignal = evaluatePriceImpact(
          book.tokenId,
          book.conditionId,
          windowPrices,
          0, // triggeringTradeValueUsdc not available here — use 0 for book-triggered
          statsCache.get(book.tokenId)?.liquidityUsdc ?? 0
        );
        if (impactSignal) {
          bus.emit("signal", impactSignal);
        }
      }
    }
  );
  snapshotWriter.start();

  bus.on("trade", async (trade) => {
    const book = snapshotWriter.getLatestBook(trade.tokenId)?.book ?? null;

    // Use rolling buffer stats if available (live accumulation), else fall back to DB cache
    const rollingStats = rollingBuffer.getStats(trade.tokenId);
    let stats = statsCache.get(trade.tokenId);

    if (!stats) {
      try {
        const row = await getMarketStats(db, trade.tokenId);
        if (row) {
          stats = {
            tokenId: trade.tokenId,
            volume24hr: row.volume24hr ? Number(row.volume24hr) : 0,
            avgTradeSize24h: row.avgTradeSize24h ? Number(row.avgTradeSize24h) : 0,
            stddevTradeSize24h: row.stddevTradeSize24h ? Number(row.stddevTradeSize24h) : 0,
            liquidityUsdc: row.liquidityUsdc ? Number(row.liquidityUsdc) : 0,
            tradeCount24h: row.tradeCount24h ?? 0,
            calibrated: row.calibrated ?? false,
          };
          statsCache.set(trade.tokenId, stats);
          conditionIdMap.set(trade.tokenId, row.conditionId);
        }
      } catch (err) {
        logger.warn({ err, tokenId: trade.tokenId }, "Pipeline: getMarketStats failed, using defaults");
      }
    }

    // Blend rolling buffer into stats if we have enough live trades (>= 30 in buffer)
    const effectiveStats: MarketStats =
      rollingStats.count >= 30
        ? {
            tokenId: trade.tokenId,
            volume24hr: rollingStats.volume,
            avgTradeSize24h: rollingStats.avg,
            stddevTradeSize24h: rollingStats.stddev,
            liquidityUsdc: stats?.liquidityUsdc ?? 0,
            tradeCount24h: rollingStats.count,
            calibrated: true,
          }
        : stats ?? {
            tokenId: trade.tokenId,
            volume24hr: 0,
            avgTradeSize24h: 0,
            stddevTradeSize24h: 0,
            liquidityUsdc: 0,
            tradeCount24h: 0,
            calibrated: false,
          };

    const alert = detector.evaluate(trade, effectiveStats, book);
    if (alert) {
      bus.emit("whale_alert", alert);
    }
  });

  // Refresh stats cache on each Gamma poll cycle
  gammaPoller.on("markets_updated", (tokenIds) => {
    // Evict stale cache entries so next trade triggers a fresh DB read
    for (const id of tokenIds) {
      statsCache.delete(id);
      conditionIdMap.delete(id);
    }
  });

  // 9. SignalAggregator
  const signalAggregator = new SignalAggregator(bus, db);
  signalAggregator.start();

  // 10. PriceHistoryWriter
  const priceHistoryWriter = new PriceHistoryWriter(bus, db);
  priceHistoryWriter.start();

  // 11. Velocity signal — 5-min scheduled scan over all watchlisted tokens (PLAN Task 2.8)
  let velocityTimer: ReturnType<typeof setInterval> | null = null;
  velocityTimer = setInterval(() => {
    const watchlist = gammaPoller.getWatchlist();
    for (const tokenId of watchlist) {
      const history = priceBuckets.get(tokenId) ?? [];
      const stats = statsCache.get(tokenId);
      const liquidityUsdc = stats?.liquidityUsdc ?? 0;
      const conditionId = conditionIdMap.get(tokenId) ?? tokenId;

      const velocitySignal = evaluateVelocity(tokenId, conditionId, history, liquidityUsdc);
      if (velocitySignal) {
        bus.emit("signal", velocitySignal);
      }
    }
  }, 5 * 60 * 1000); // every 5 minutes

  logger.info("Pipeline: all components started");

  // Graceful shutdown function
  const shutdown = async (): Promise<void> => {
    logger.info("Pipeline: shutting down");

    // 1. Stop accepting new events
    liveDataWs.disconnect();

    // 2. Stop velocity scanner
    if (velocityTimer) {
      clearInterval(velocityTimer);
      velocityTimer = null;
    }

    // 3. Flush trade batch
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    await flushTradeBatch();

    // 4. Flush pending price history
    await priceHistoryWriter.flush();
    priceHistoryWriter.stop();

    // 5. Stop snapshot writer
    snapshotWriter.stop();

    // 6. Stop gamma poller
    gammaPoller.stop();

    // 7. Stop partition manager
    partitionManager.stop();

    // 8. Close DB
    await closeDb();

    logger.info("Pipeline: shutdown complete");
  };

  return shutdown;
}
