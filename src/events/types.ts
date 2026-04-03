// ─── Primitive branded types ──────────────────────────────────────────────────
export type TokenId = string;
export type ConditionId = string;
export type WalletAddress = string;
export type TxHash = string;

// ─── Order book ───────────────────────────────────────────────────────────────
export interface PriceLevel {
  price: number; // 0.00–1.00
  size: number;
}

export interface OrderBook {
  tokenId: TokenId;
  conditionId: ConditionId;
  bids: PriceLevel[]; // sorted desc by price
  asks: PriceLevel[]; // sorted asc by price
  timestamp: number; // ms epoch
  hash: string;
  capturedAt: Date; // wall-clock capture time (for staleness checks)
}

// ─── Dedup key ────────────────────────────────────────────────────────────────
export interface DedupKey {
  transactionHash: TxHash;
  tokenId: TokenId;
  proxyWallet: WalletAddress;
  tradedAt: Date;
  priceUsdc: number;
  sizeTokens: number;
}

// ─── Trade event ──────────────────────────────────────────────────────────────
export interface TradeEvent {
  tokenId: TokenId;
  conditionId: ConditionId;
  side: "BUY" | "SELL";
  sizeTokens: number;
  priceUsdc: number;
  valueUsdc: number;
  proxyWallet: WalletAddress;
  transactionHash: TxHash;
  tradedAt: Date;
  outcome: string;
  marketSlug: string;
  eventSlug: string;
  marketTitle: string;
  traderName?: string;
  traderPseudonym?: string;
  source: "live_ws" | "data_api";
}

// ─── Market stats (used by WhaleDetector) ─────────────────────────────────────
export interface MarketStats {
  tokenId: TokenId;
  volume24hr: number;
  avgTradeSize24h: number;
  stddevTradeSize24h: number;
  liquidityUsdc: number;
  tradeCount24h: number;
  /** false when tradeCount24h < 30 — sigma branch suppressed */
  calibrated: boolean;
}

// ─── CLOB WS events ───────────────────────────────────────────────────────────
export interface BookUpdateEvent {
  type: "book";
  book: OrderBook;
}

export interface PriceChangeEvent {
  type: "price_change";
  tokenId: TokenId;
  price: number;
  side: "BUY" | "SELL";
  timestamp: number;
}

export interface BestBidAskEvent {
  type: "best_bid_ask";
  tokenId: TokenId;
  bid: number;
  ask: number;
  timestamp: number;
}

export interface LastTradePriceEvent {
  type: "last_trade_price";
  tokenId: TokenId;
  price: number;
  side: "BUY" | "SELL";
  timestamp: number;
}

// ─── Signal types — CANONICAL, do not drift ───────────────────────────────────
export type SignalType =
  | "WHALE_TRADE"
  | "ORDER_BOOK_IMBALANCE"
  | "PRICE_IMPACT_ANOMALY"
  | "SENTIMENT_VELOCITY";

export const SIGNAL_TYPES: readonly SignalType[] = [
  "WHALE_TRADE",
  "ORDER_BOOK_IMBALANCE",
  "PRICE_IMPACT_ANOMALY",
  "SENTIMENT_VELOCITY",
] as const;

export type SignalDirection = "BULLISH" | "BEARISH" | "NEUTRAL";

// ─── Signal interfaces ────────────────────────────────────────────────────────
export interface BaseSignal {
  signalType: SignalType;
  tokenId: TokenId;
  conditionId: ConditionId;
  direction: SignalDirection;
  confidence: number; // 0.0–1.0
  strength: number;
  priceAtSignal: number;
  createdAt: Date;
  payload: Record<string, unknown>;
}

export interface WhaleSignal extends BaseSignal {
  signalType: "WHALE_TRADE";
  usdcValue: number;
  sigmasAboveMean: number;
  pctOfDailyVolume: number;
  proxyWallet: WalletAddress;
  transactionHash: TxHash;
  priceImpactEstimate: number;
  bookDepthConsumedPct: number;
  bookSnapshotAgeMs: number;
}

export interface ImbalanceSignal extends BaseSignal {
  signalType: "ORDER_BOOK_IMBALANCE";
  imbalanceRatio: number;
  bidDepthUsdc: number;
  askDepthUsdc: number;
}

export interface PriceImpactSignal extends BaseSignal {
  signalType: "PRICE_IMPACT_ANOMALY";
  priceChangePct: number;
  windowSeconds: number;
  triggeringTradeValueUsdc: number;
}

export interface VelocitySignal extends BaseSignal {
  signalType: "SENTIMENT_VELOCITY";
  velocityZScore: number;
  hourlyPriceChangePct: number;
  baselineStdDev: number;
}

export type Signal = WhaleSignal | ImbalanceSignal | PriceImpactSignal | VelocitySignal;

// ─── Whale alert ──────────────────────────────────────────────────────────────
export interface WhaleAlert {
  trade: TradeEvent;
  usdcValue: number;
  marketStats: MarketStats;
  priceAtAlert: number;
  priceImpactEstimateUsdc: number;
  bookDepthConsumedPct: number;
  bookSnapshotAgeMs: number;
  book: OrderBook | null;
  signal: WhaleSignal;
  /** false when liquidityUsdc < minLiquidityUsdc — skip DB write but alert still returned */
  emitSignal: boolean;
}

// ─── Event map for typed bus ──────────────────────────────────────────────────
export interface EventMap {
  trade: TradeEvent;
  book_update: BookUpdateEvent;
  price_change: PriceChangeEvent;
  best_bid_ask: BestBidAskEvent;
  last_trade_price: LastTradePriceEvent;
  whale_alert: WhaleAlert;
  signal: Signal;
}

// ─── Pipeline config (runtime shape) ─────────────────────────────────────────
export interface PipelineConfig {
  absoluteMinUsdc: number;
  sigmaThreshold: number;
  pctVolumeThreshold: number;
  watchlistSize: number;
  clobWsShardSize: number;
  snapshotIntervalMs: number;
  gammaPollIntervalMs: number;
  tradeBatchSize: number;
  tradeBatchFlushMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  walletEnrichRps: number;
  minLiquidityUsdc: number;
  imbalanceRatioThreshold: number;
  priceImpactWindowSec: number;
  priceImpactMinChangePct: number;
  velocityZScoreThreshold: number;
  logLevel: string;
  databaseUrl: string;
}
