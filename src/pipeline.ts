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
import { logger } from "./logger.js";

export async function startPipeline(): Promise<() => Promise<void>> {
  logger.info("Pipeline: starting");

  // 1. Ensure partitions exist for today and tomorrow
  const partitionManager = new PartitionManager(db);
  await partitionManager.ensureCurrentPartitions().catch((err) =>
    logger.warn({ err }, "Pipeline: partition ensure failed (may not have DB yet)")
  );
  partitionManager.start();

  // 2. Create negRisk set (will be populated by GammaPoller)
  const negRiskSet = new Set<string>();

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

  bus.on("trade", (trade) => {
    const book = snapshotWriter.getLatestBook(trade.tokenId)?.book ?? null;
    // Stats would come from market_stats in real usage
    // For now, use minimal default (will be calibrated from DB in production)
    const stats = {
      tokenId: trade.tokenId,
      volume24hr: 0,
      avgTradeSize24h: 0,
      stddevTradeSize24h: 0,
      liquidityUsdc: 0,
      tradeCount24h: 0,
      calibrated: false,
    };

    const alert = detector.evaluate(trade, stats, book);
    if (alert) {
      bus.emit("whale_alert", alert);
    }
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
