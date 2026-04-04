import "dotenv/config";

export function envNumber(key: string, defaultVal: number): number {
  const val = process.env[key];
  if (!val) return defaultVal;
  const parsed = Number(val);
  if (isNaN(parsed)) throw new Error(`Environment variable ${key} must be a number, got: ${val}`);
  return parsed;
}

export const config = Object.freeze({
  // databaseUrl: empty string when unset; DB client throws a clear error on connection attempt
  databaseUrl: process.env.DATABASE_URL ?? "",
  absoluteMinUsdc: envNumber("WHALE_ABSOLUTE_MIN_USDC", 10_000),
  sigmaThreshold: envNumber("WHALE_SIGMA_THRESHOLD", 3.0),
  pctVolumeThreshold: envNumber("WHALE_PCT_VOLUME_THRESHOLD", 0.02),
  snapshotIntervalMs: envNumber("SNAPSHOT_INTERVAL_MS", 30_000),
  gammaPollIntervalMs: envNumber("GAMMA_POLL_INTERVAL_MS", 60_000),
  watchlistSize: envNumber("WATCHLIST_SIZE", 200),
  clobWsShardSize: envNumber("CLOB_WS_SHARD_SIZE", 150),
  tradeBatchSize: envNumber("TRADE_BATCH_SIZE", 100),
  tradeBatchFlushMs: envNumber("TRADE_BATCH_FLUSH_MS", 500),
  reconnectBaseMs: envNumber("RECONNECT_BASE_MS", 1_000),
  reconnectMaxMs: envNumber("RECONNECT_MAX_MS", 30_000),
  minLiquidityUsdc: envNumber("MIN_LIQUIDITY_USDC", 50_000),
  imbalanceRatioThreshold: envNumber("IMBALANCE_RATIO_THRESHOLD", 3.0),
  // Phase 2
  clobWsUrl: process.env.CLOB_WS_URL ?? "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  clobWsMaxReconnectDelayMs: envNumber("CLOB_WS_MAX_RECONNECT_DELAY_MS", 30_000),
  imbalanceCooldownMs: envNumber("IMBALANCE_COOLDOWN_MS", 60_000),
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL ?? "",
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL ?? "",
  walletEnrichmentTimeoutMs: envNumber("WALLET_ENRICHMENT_TIMEOUT_MS", 5_000),
  walletEnrichmentRateLimitRps: envNumber("WALLET_ENRICHMENT_RATE_LIMIT_RPS", 2),
  walletEnrichmentRecencyHours: envNumber("WALLET_ENRICHMENT_RECENCY_HOURS", 24),
  // Phase 3 — Signal Intelligence
  priceImpactAnomalyThreshold: envNumber("PRICE_IMPACT_ANOMALY_THRESHOLD", 2.5),
  priceImpactCooldownMs: envNumber("PRICE_IMPACT_COOLDOWN_MS", 30_000),
  velocityWindowSeconds: envNumber("VELOCITY_WINDOW_SECONDS", 300),
  velocityPriceThreshold: envNumber("VELOCITY_PRICE_THRESHOLD", 0.005),
  velocityTradeCountMultiplier: envNumber("VELOCITY_TRADE_COUNT_MULTIPLIER", 1.5),
  velocityCooldownMs: envNumber("VELOCITY_COOLDOWN_MS", 120_000),
  compositeWindowMs: envNumber("COMPOSITE_WINDOW_MS", 60_000),
  // Phase 4 — Neg-Risk Cross-Book Pricing
  negRiskRefreshIntervalMs: envNumber("NEG_RISK_REFRESH_INTERVAL_MS", 120_000),
  negRiskArbThreshold: envNumber("NEG_RISK_ARB_THRESHOLD", -0.02),
  negRiskCooldownMs: envNumber("NEG_RISK_COOLDOWN_MS", 60_000),
  // Phase 5 — Analytics & Observability
  dashboardRefreshMs: envNumber("DASHBOARD_REFRESH_MS", 30_000),
  leaderboardMinTrades: envNumber("LEADERBOARD_MIN_TRADES", 5),
  leaderboardTopN: envNumber("LEADERBOARD_TOP_N", 20),
  logLevel: process.env.LOG_LEVEL ?? "info",
});

export type Config = typeof config;
