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
import { evaluatePriceImpact } from "./signals/price-impact-signal.js";
import { evaluateVelocity } from "./signals/velocity-signal.js";
import type { MarketStats, TradeEvent, OrderBook, TokenId, BookUpdateEvent, Signal } from "./events/types.js";
import { logger } from "./logger.js";

const PRICE_WINDOW_MS = 120_000; // keep 2 min of recent price history per token
const BUCKET_MS = 5 * 60 * 1000; // 5-min buckets for velocity signal
const MAX_BUCKETS = 288; // 24h / 5min

export async function startPipeline(): Promise<() => Promise<void>> {
  logger.info("Pipeline: starting");

  // ── In-memory price state (scoped per pipeline instance, cleared on shutdown) ──
  /** Sliding window of recent price points per token (for PRICE_IMPACT_ANOMALY signal) */
  const recentPrices = new Map<TokenId, Array<{ price: number; recordedAt: Date }>>();

  function recordPrice(tokenId: TokenId, price: number): void {
    if (!recentPrices.has(tokenId)) recentPrices.set(tokenId, []);
    const buf = recentPrices.get(tokenId)!;
    buf.push({ price, recordedAt: new Date() });
    const cutoff = new Date(Date.now() - PRICE_WINDOW_MS);
    const fresh = buf.filter((p) => p.recordedAt >= cutoff);
    recentPrices.set(tokenId, fresh);
  }

  /** 24h price bucket store per token (for SENTIMENT_VELOCITY signal) */
  const priceBuckets = new Map<TokenId, Array<{ price: number; bucketStart: Date }>>();

  function recordBucketPrice(tokenId: TokenId, price: number): void {
    if (!priceBuckets.has(tokenId)) priceBuckets.set(tokenId, []);
    const buf = priceBuckets.get(tokenId)!;
    const now = Date.now();
    const bucketStart = new Date(Math.floor(now / BUCKET_MS) * BUCKET_MS);

    if (buf.length > 0 && buf[buf.length - 1].bucketStart.getTime() === bucketStart.getTime()) {
      buf[buf.length - 1].price = price;
    } else {
      buf.push({ price, bucketStart });
      if (buf.length > MAX_BUCKETS) buf.shift();
    }
  }

  // 1. Ensure partitions exist for today and tomorrow
  const partitionManager = new PartitionManager(db);
  await partitionManager.ensureCurrentPartitions().catch((err) =>
    logger.warn({ err }, "Pipeline: partition ensure failed (may not have DB yet)")
  );
  partitionManager.start();

  // 2. Market stats cache and negRisk set (populated by GammaPoller)
  const negRiskSet = new Set<string>();
  const statsCache = new Map<string, MarketStats>();
  /** Maps tokenId → conditionId for velocity signal emission */
  const conditionIdMap = new Map<string, string>();

  // Rolling 24h stats buffer — updated on every live trade
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

  // 5. Wire trade persistence with batching (100 rows / 500ms flush)
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

  // Trade listener #1: feed rolling buffer, record prices, batch for persistence
  const tradeHandler1 = async (trade: TradeEvent): Promise<void> => {
    rollingBuffer.addTrade(trade.tokenId, trade.valueUsdc, trade.tradedAt);
    recordPrice(trade.tokenId, trade.priceUsdc);
    recordBucketPrice(trade.tokenId, trade.priceUsdc);

    tradeBatch.push(trade);
    if (tradeBatch.length >= config.tradeBatchSize) {
      await flushTradeBatch();
    }
  };

  bus.on("trade", tradeHandler1);

  // Record prices from CLOB WS events (midpoints and last-trade)
  const bidAskHandler = (evt: { tokenId: TokenId; bid: number; ask: number }): void => {
    const mid = (evt.bid + evt.ask) / 2;
    recordPrice(evt.tokenId, mid);
    recordBucketPrice(evt.tokenId, mid);
  };

  const lastTradeHandler = (evt: { tokenId: TokenId; price: number }): void => {
    recordPrice(evt.tokenId, evt.price);
    recordBucketPrice(evt.tokenId, evt.price);
  };

  bus.on("best_bid_ask", bidAskHandler);
  bus.on("last_trade_price", lastTradeHandler);

  // 6. Start ClobRestClient + SnapshotWriter
  const clobClient = new ClobRestClient();
  const detector = new WhaleDetector();

  // Phase 2: WebhookEmitter, WalletEnricher
  const webhookEmitter = new WebhookEmitter();
  const walletEnricher = new WalletEnricher(db);

  const alertEmitter = new AlertEmitter(bus, webhookEmitter);
  alertEmitter.start();

  // 7. OrderBookImbalanceEngine + PriceImpactSignal — triggered after each snapshot
  const imbalanceEngine = new OrderBookImbalanceEngine(bus);

  const snapshotWriter = new SnapshotWriter(
    db,
    clobClient,
    () => gammaPoller.getWatchlist(),
    config.snapshotIntervalMs,
    (book: OrderBook) => {
      imbalanceEngine.evaluate(book);

      // Evaluate PRICE_IMPACT_ANOMALY using in-window price history
      const tokenPrices = recentPrices.get(book.tokenId) ?? [];
      const windowCutoff = new Date(Date.now() - config.priceImpactWindowSec * 1000);
      const windowPrices = tokenPrices.filter((p) => p.recordedAt >= windowCutoff);

      if (windowPrices.length >= 2) {
        const impactSignal = evaluatePriceImpact(
          book.tokenId,
          book.conditionId,
          windowPrices,
          0, // triggeringTradeValueUsdc not available for book-triggered eval
          statsCache.get(book.tokenId)?.liquidityUsdc ?? 0
        );
        if (impactSignal) {
          bus.emit("signal", impactSignal);
        }
      }
    }
  );
  snapshotWriter.start();

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
    reconnectMaxMs: config.reconnectMaxMs,
    db,
  });
  const wsImbalanceEvaluator = new WsBookImbalanceEvaluator(bus, db);

  // Wire ClobWsPool local events → bus
  const clobBookHandler = (evt: BookUpdateEvent) => bus.emit("book_update", evt);
  const clobPriceChangeHandler = (evt: unknown) => bus.emit("price_change", evt as never);
  const clobBestBidAskHandler = (evt: unknown) => bus.emit("best_bid_ask", evt as never);
  const clobLastTradePriceHandler = (evt: unknown) => bus.emit("last_trade_price", evt as never);

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

  // 8. SignalAggregator
  const signalAggregator = new SignalAggregator(
    bus,
    db,
    (alert, id) => walletEnricher.enrich(alert, id)
  );
  signalAggregator.start();

  // 9. PriceHistoryWriter
  const priceHistoryWriter = new PriceHistoryWriter(bus, db);
  priceHistoryWriter.start();

  // 10. Velocity signal — 5-min scheduled scan (PLAN Task 2.8)
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
  }, 5 * 60 * 1000);

  logger.info("Pipeline: all components started");

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (): Promise<void> => {
    logger.info("Pipeline: shutting down");

    // 1. Stop ingestion
    liveDataWs.disconnect();
    clobWsPool.disconnect();

    // 2. Stop timers
    if (velocityTimer) { clearInterval(velocityTimer); velocityTimer = null; }
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

    // 5. Clear in-memory price state
    recentPrices.clear();
    priceBuckets.clear();

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
