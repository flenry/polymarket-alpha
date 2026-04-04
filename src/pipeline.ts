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
import { WebhookEmitter } from "./alerts/webhook-emitter.js";
import { SignalAggregator } from "./processors/signal-aggregator.js";
import { OrderBookImbalanceEngine } from "./processors/book-imbalance-engine.js";
import { WsBookImbalanceEvaluator } from "./processors/ws-book-imbalance-evaluator.js";
import { ClobWsPool } from "./sources/clob-ws-pool.js";
import { WalletEnricher } from "./enrichment/wallet-enricher.js";
import { PriceHistoryWriter } from "./processors/price-history-writer.js";
import { insertTrade } from "./db/queries/trades.js";
import { getMarketStats, getWatchlistedTokenIds } from "./db/queries/markets.js";
import { RollingStatsBuffer } from "./sources/stats-bootstrap.js";
import { PriceImpactSignalEvaluator } from "./signals/price-impact-signal.js";
import { SentimentVelocityEvaluator } from "./signals/velocity-signal.js";
import type { MarketStats, TradeEvent, OrderBook, TokenId, BookUpdateEvent, PriceChangeEvent, BestBidAskEvent, LastTradePriceEvent, Signal } from "./events/types.js";
import { logger } from "./logger.js";

export async function startPipeline(): Promise<() => Promise<void>> {
  logger.info("Pipeline: starting");

  // 1. Ensure partitions exist for today and tomorrow
  const partitionManager = new PartitionManager(db);
  await partitionManager.ensureCurrentPartitions().catch((err) =>
    logger.warn({ err }, "Pipeline: partition ensure failed (may not have DB yet)")
  );
  partitionManager.start();

  // 2. Market stats cache and negRisk set (populated by GammaPoller)
  const negRiskSet = new Set<string>();
  const statsCache = new Map<string, MarketStats>();
  /** Maps tokenId → conditionId for signal emission */
  const conditionIdMap = new Map<string, string>();

  // Rolling 24h stats buffer — updated on every live trade
  const rollingBuffer = new RollingStatsBuffer();

  // 3. Instantiate Phase 3 evaluators (pure — no DB dependency)
  const priceImpactEvaluator = new PriceImpactSignalEvaluator();
  const velocityEvaluator = new SentimentVelocityEvaluator();

  // 4. Start GammaPoller
  const gammaPoller = new GammaPoller({
    db,
    pollIntervalMs: config.gammaPollIntervalMs,
    watchlistSize: config.watchlistSize,
  });

  gammaPoller.on("markets_updated", (_tokenIds, negRiskIds) => {
    for (const id of negRiskIds) negRiskSet.add(id);
  });

  await gammaPoller.start();

  // Bootstrap velocity evaluator from DB (non-blocking)
  const watchlistedForBootstrap = gammaPoller.getWatchlist();
  velocityEvaluator.bootstrap(db, watchlistedForBootstrap).catch((err) =>
    logger.warn({ err }, "Pipeline: velocity bootstrap failed")
  );

  // 5. Start LiveDataWsClient
  const liveDataWs = new LiveDataWsClient({
    bus,
    negRiskSet,
    reconnectBaseMs: config.reconnectBaseMs,
    reconnectMaxMs: config.reconnectMaxMs,
  });

  liveDataWs.connect();

  // 6. Wire trade persistence with batching (100 rows / 500ms flush)
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

  // 7. Start ClobRestClient + SnapshotWriter
  const clobClient = new ClobRestClient();
  const detector = new WhaleDetector();

  // Phase 2: WebhookEmitter, WalletEnricher
  const webhookEmitter = new WebhookEmitter();
  const walletEnricher = new WalletEnricher(db);

  const alertEmitter = new AlertEmitter(bus, webhookEmitter);
  alertEmitter.start();

  // 8. OrderBookImbalanceEngine + SnapshotWriter (REST path — Phase 1, unchanged)
  const imbalanceEngine = new OrderBookImbalanceEngine(bus);

  const snapshotWriter = new SnapshotWriter(
    db,
    clobClient,
    () => gammaPoller.getWatchlist(),
    config.snapshotIntervalMs,
    (book: OrderBook) => {
      imbalanceEngine.evaluate(book);
    }
  );
  snapshotWriter.start();

  // ── Trade listener #1 — sequencing contract (LAW-MAJOR-4 / PLAN §6.1) ──
  //
  // Order is critical:
  //   1. Capture priceBeforeTrade BEFORE recording the new price
  //   2. Capture snapshot BEFORE recording new price
  //   3. Record the new price (updates evaluator's price buffer)
  //   4. Record the trade event in velocity evaluator
  //   5. Batch for DB persistence
  //   6. Fire-and-forget priceImpactEvaluator.evaluate()
  //   7. Sync evaluate velocity → emit if signal
  const tradeHandler1 = async (trade: TradeEvent): Promise<void> => {
    // Step 1+2: capture prior state before updating buffers
    const priceBeforeTrade = velocityEvaluator["priceBuffer"]
      ? (() => {
          // Access internal price buffer to get last known price for this token
          const buf = (velocityEvaluator as unknown as { priceBuffer: Map<TokenId, Array<{ price: number }>> })
            .priceBuffer.get(trade.tokenId);
          return buf && buf.length > 0 ? buf[buf.length - 1].price : null;
        })()
      : null;

    const snapshot = snapshotWriter.getLatestBook(trade.tokenId)?.book
      ? {
          tokenId: snapshotWriter.getLatestBook(trade.tokenId)!.book!.tokenId,
          conditionId: snapshotWriter.getLatestBook(trade.tokenId)!.book!.conditionId,
          bids: snapshotWriter.getLatestBook(trade.tokenId)!.book!.bids.map((l) => ({
            price: String(l.price),
            size: String(l.size),
          })),
          asks: snapshotWriter.getLatestBook(trade.tokenId)!.book!.asks.map((l) => ({
            price: String(l.price),
            size: String(l.size),
          })),
          bidDepthUsdc:
            snapshotWriter.getLatestBook(trade.tokenId)!.book!.bids.reduce(
              (s, l) => s + l.price * l.size, 0
            ) || null,
          askDepthUsdc:
            snapshotWriter.getLatestBook(trade.tokenId)!.book!.asks.reduce(
              (s, l) => s + l.price * l.size, 0
            ) || null,
          capturedAt: snapshotWriter.getLatestBook(trade.tokenId)!.book!.capturedAt,
        }
      : null;

    // Step 3: record new price in velocity evaluator
    velocityEvaluator.recordPrice(trade.tokenId, trade.priceUsdc);

    // Step 4: record trade occurrence for count-velocity
    velocityEvaluator.recordTrade(trade.tokenId);

    rollingBuffer.addTrade(trade.tokenId, trade.valueUsdc, trade.tradedAt);

    // Step 5: batch for DB persistence
    tradeBatch.push(trade);
    if (tradeBatch.length >= config.tradeBatchSize) {
      await flushTradeBatch();
    }

    // Step 6: fire-and-forget price impact evaluation
    priceImpactEvaluator
      .evaluate(trade, priceBeforeTrade, trade.priceUsdc, snapshot)
      .then((sig) => {
        if (sig) bus.emit("signal", sig);
      })
      .catch((err) => logger.error({ err }, "Pipeline: price impact eval failed"));

    // Step 7: sync velocity evaluation
    const condId = conditionIdMap.get(trade.tokenId) ?? trade.tokenId;
    const velocitySignal = velocityEvaluator.evaluate(trade.tokenId, condId);
    if (velocitySignal) {
      bus.emit("signal", velocitySignal);
    }
  };

  bus.on("trade", tradeHandler1);

  // Record prices from CLOB WS events into velocity evaluator (midpoints and last-trade)
  const bidAskHandler = (evt: { tokenId: TokenId; bid: number; ask: number }): void => {
    const mid = (evt.bid + evt.ask) / 2;
    velocityEvaluator.recordPrice(evt.tokenId, mid);
  };

  const lastTradeHandler = (evt: { tokenId: TokenId; price: number }): void => {
    velocityEvaluator.recordPrice(evt.tokenId, evt.price);
  };

  bus.on("best_bid_ask", bidAskHandler);
  bus.on("last_trade_price", lastTradeHandler);

  // Trade listener #2: whale detection (separate listener so ordering is clear)
  const tradeHandler2 = async (trade: TradeEvent): Promise<void> => {
    const book = snapshotWriter.getLatestBook(trade.tokenId)?.book ?? null;
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

    // Prefer rolling buffer stats if we have >= 30 live trades
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
  };

  bus.on("trade", tradeHandler2);

  // Evict stale stats on each Gamma poll cycle
  gammaPoller.on("markets_updated", (tokenIds) => {
    for (const id of tokenIds) {
      statsCache.delete(id);
      conditionIdMap.delete(id);
    }
  });

  // Phase 2: ClobWsPool + WsBookImbalanceEvaluator
  const clobWsPool = new ClobWsPool({
    url: config.clobWsUrl,
    shardSize: config.clobWsShardSize,
    reconnectBaseMs: config.reconnectBaseMs,
    reconnectMaxMs: config.clobWsMaxReconnectDelayMs,
    db,
  });
  const wsImbalanceEvaluator = new WsBookImbalanceEvaluator(bus, db);

  // Wire ClobWsPool local events → bus
  const clobBookHandler = (evt: BookUpdateEvent) => bus.emit("book_update", evt);
  const clobPriceChangeHandler = (evt: PriceChangeEvent) => bus.emit("price_change", evt);
  const clobBestBidAskHandler = (evt: BestBidAskEvent) => bus.emit("best_bid_ask", evt);
  const clobLastTradePriceHandler = (evt: LastTradePriceEvent) => bus.emit("last_trade_price", evt);

  clobWsPool.on("book", clobBookHandler);
  clobWsPool.on("price_change", clobPriceChangeHandler);
  clobWsPool.on("best_bid_ask", clobBestBidAskHandler);
  clobWsPool.on("last_trade_price", clobLastTradePriceHandler);

  // Wire book_update → WsBookImbalanceEvaluator
  const bookUpdateHandler = (evt: BookUpdateEvent) => wsImbalanceEvaluator.evaluate(evt.book);
  bus.on("book_update", bookUpdateHandler);

  // Wire ORDER_BOOK_IMBALANCE signals → WebhookEmitter
  const imbalanceWebhookHandler = (signal: Signal) => {
    if (signal.signalType === "ORDER_BOOK_IMBALANCE") webhookEmitter.send(signal);
  };
  bus.on("signal", imbalanceWebhookHandler);

  // Start ClobWsPool after watchlisted tokens are available
  const watchlistedTokenIds = await getWatchlistedTokenIds(db).catch(() => [] as TokenId[]);
  clobWsPool.connect(watchlistedTokenIds).catch((err) =>
    logger.error({ err }, "Pipeline: ClobWsPool connect failed")
  );

  // 9. SignalAggregator
  const signalAggregator = new SignalAggregator(
    bus,
    db,
    (alert, id) => walletEnricher.enrich(alert, id)
  );
  signalAggregator.start();

  // 10. PriceHistoryWriter
  const priceHistoryWriter = new PriceHistoryWriter(bus, db);
  priceHistoryWriter.start();

  logger.info("Pipeline: all components started");

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (): Promise<void> => {
    logger.info("Pipeline: shutting down");

    // 1. Stop ingestion
    liveDataWs.disconnect();
    clobWsPool.disconnect();

    // 2. Stop timers
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }

    // 3. Flush pending trades
    await flushTradeBatch();

    // 4. Remove bus listeners we registered (prevent leaks if restarted)
    alertEmitter.stop();
    signalAggregator.stop();
    bus.off("trade", tradeHandler1);
    bus.off("trade", tradeHandler2);
    bus.off("best_bid_ask", bidAskHandler);
    bus.off("last_trade_price", lastTradeHandler);
    bus.off("book_update", bookUpdateHandler);
    bus.off("signal", imbalanceWebhookHandler);
    clobWsPool.off("book", clobBookHandler);
    clobWsPool.off("price_change", clobPriceChangeHandler);
    clobWsPool.off("best_bid_ask", clobBestBidAskHandler);
    clobWsPool.off("last_trade_price", clobLastTradePriceHandler);

    // 5. Clear in-memory state
    velocityEvaluator.clear();

    // 6. Flush and stop writers
    await priceHistoryWriter.flush();
    priceHistoryWriter.stop();
    snapshotWriter.stop();
    gammaPoller.stop();
    partitionManager.stop();

    // 7. Close DB
    await closeDb();

    logger.info("Pipeline: shutdown complete");
  };

  return shutdown;
}
