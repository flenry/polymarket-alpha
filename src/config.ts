import "dotenv/config";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Required environment variable ${key} is not set`);
  return val;
}

function envNumber(key: string, defaultVal: number): number {
  const val = process.env[key];
  if (!val) return defaultVal;
  const parsed = Number(val);
  if (isNaN(parsed)) throw new Error(`Environment variable ${key} must be a number, got: ${val}`);
  return parsed;
}

export const config = Object.freeze({
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
  walletEnrichRps: envNumber("WALLET_ENRICH_RPS", 2),
  minLiquidityUsdc: envNumber("MIN_LIQUIDITY_USDC", 50_000),
  imbalanceRatioThreshold: envNumber("IMBALANCE_RATIO_THRESHOLD", 3.0),
  priceImpactWindowSec: envNumber("PRICE_IMPACT_WINDOW_SEC", 60),
  priceImpactMinChangePct: envNumber("PRICE_IMPACT_MIN_CHANGE_PCT", 2.0),
  velocityZScoreThreshold: envNumber("VELOCITY_Z_SCORE_THRESHOLD", 2.0),
  logLevel: process.env.LOG_LEVEL ?? "info",
});

export type Config = typeof config;
