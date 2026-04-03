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
import type { MarketStats } from "./events/types.js";
import { logger } from "./logger.js";

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

  // 5. Wire trade persistence
  bus.on("trade", async (trade) => {
    try {
      await insertTrade(db, trade);
    } catch (err) {
      logger.error({ err, tokenId: trade.tokenId }, "Pipeline: trade insert failed");
    }
  });

  // 6. Start ClobRestClient + SnapshotWriter
  const clobClient = new ClobRestClient();
  const snapshotWriter = new SnapshotWriter(
    db,
    clobClient,
    () => gammaPoller.getWatchlist(),
    config.snapshotIntervalMs
  );
  snapshotWriter.start();

  // 7. WhaleDetector + AlertEmitter
  const detector = new WhaleDetector();
  const alertEmitter = new AlertEmitter(bus);
  alertEmitter.start();

  bus.on("trade", async (trade) => {
    const book = snapshotWriter.getLatestBook(trade.tokenId)?.book ?? null;

    // Fetch calibrated stats from cache, falling back to DB lookup
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
        }
      } catch (err) {
        logger.warn({ err, tokenId: trade.tokenId }, "Pipeline: getMarketStats failed, using defaults");
      }
    }

    // Use calibrated stats or uncalibrated default (absolute-threshold-only)
    const effectiveStats: MarketStats = stats ?? {
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
    for (const id of tokenIds) statsCache.delete(id);
  });

  // 8. SignalAggregator
  const signalAggregator = new SignalAggregator(bus, db);
  signalAggregator.start();

  // 9. OrderBookImbalanceEngine — called after each snapshot
  const imbalanceEngine = new OrderBookImbalanceEngine(bus);

  // 10. PriceHistoryWriter
  const priceHistoryWriter = new PriceHistoryWriter(bus, db);
  priceHistoryWriter.start();

  logger.info("Pipeline: all components started");

  // Graceful shutdown function
  const shutdown = async (): Promise<void> => {
    logger.info("Pipeline: shutting down");

    // 1. Stop accepting new events
    liveDataWs.disconnect();

    // 2. Flush pending price history
    await priceHistoryWriter.flush();
    priceHistoryWriter.stop();

    // 3. Stop snapshot writer
    snapshotWriter.stop();

    // 4. Stop gamma poller
    gammaPoller.stop();

    // 5. Stop partition manager
    partitionManager.stop();

    // 6. Close DB
    await closeDb();

    logger.info("Pipeline: shutdown complete");
  };

  return shutdown;
}
