-- Initial schema migration
-- Creates all tables from Drizzle schema template

CREATE TABLE IF NOT EXISTS "markets" (
  "token_id" varchar(80) PRIMARY KEY,
  "condition_id" varchar(66) NOT NULL,
  "gamma_market_id" varchar(20),
  "question" text NOT NULL DEFAULT '',
  "slug" varchar(200),
  "event_slug" varchar(200),
  "category" varchar(100),
  "outcome" varchar(50) NOT NULL DEFAULT '',
  "outcome_index" smallint NOT NULL DEFAULT 0,
  "minimum_order_size" numeric(18, 6),
  "minimum_tick_size" numeric(10, 6),
  "neg_risk" boolean DEFAULT false,
  "watchlisted" boolean DEFAULT false,
  "accepting_orders" boolean DEFAULT false,
  "active" boolean DEFAULT true,
  "closed" boolean DEFAULT false,
  "end_date" timestamptz,
  "closed_time" timestamptz,
  "winner" boolean,
  "icon_url" text,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "markets_condition_id_idx" ON "markets" ("condition_id");
CREATE INDEX IF NOT EXISTS "markets_active_watchlist_idx" ON "markets" ("active", "watchlisted");
CREATE INDEX IF NOT EXISTS "markets_neg_risk_idx" ON "markets" ("neg_risk");
CREATE INDEX IF NOT EXISTS "markets_slug_idx" ON "markets" ("slug");

CREATE TABLE IF NOT EXISTS "market_stats" (
  "token_id" varchar(80) PRIMARY KEY REFERENCES "markets"("token_id"),
  "condition_id" varchar(66) NOT NULL,
  "best_bid" numeric(10, 6),
  "best_ask" numeric(10, 6),
  "mid" numeric(10, 6),
  "spread" numeric(10, 6),
  "last_trade_price" numeric(10, 6),
  "volume_24hr" numeric(20, 6),
  "volume_1wk" numeric(20, 6),
  "volume_1mo" numeric(20, 6),
  "volume_total" numeric(20, 6),
  "liquidity_usdc" numeric(20, 6),
  "open_interest" numeric(20, 6),
  "avg_trade_size_24h" numeric(20, 6),
  "stddev_trade_size_24h" numeric(20, 6),
  "calibrated" boolean NOT NULL DEFAULT false,
  "bootstrap_trade_count" integer DEFAULT 0,
  "trade_count_24h" integer DEFAULT 0,
  "one_day_price_change" numeric(10, 6),
  "one_hour_price_change" numeric(10, 6),
  "one_week_price_change" numeric(10, 6),
  "competitive" numeric(10, 4),
  "refreshed_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "market_stats_condition_id_idx" ON "market_stats" ("condition_id");
CREATE INDEX IF NOT EXISTS "market_stats_volume_idx" ON "market_stats" ("volume_24hr");

-- trades: template table (will be converted to partitioned in 0002)
CREATE TABLE IF NOT EXISTS "trades" (
  "id" bigint GENERATED ALWAYS AS IDENTITY,
  "token_id" varchar(80) NOT NULL,
  "condition_id" varchar(66) NOT NULL,
  "outcome" varchar(50) NOT NULL DEFAULT '',
  "side" varchar(4) NOT NULL,
  "size_tokens" numeric(20, 6) NOT NULL,
  "price_usdc" numeric(10, 6) NOT NULL,
  "value_usdc" numeric(20, 6) NOT NULL,
  "proxy_wallet" varchar(42) NOT NULL,
  "transaction_hash" varchar(66) NOT NULL,
  "traded_at" timestamptz NOT NULL,
  "market_slug" varchar(200),
  "event_slug" varchar(200),
  "market_title" text,
  "trader_name" varchar(100),
  "trader_pseudonym" varchar(100),
  "source" varchar(20) DEFAULT 'live_ws',
  "created_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "trades_tx_hash_idx" ON "trades" ("transaction_hash");
CREATE INDEX IF NOT EXISTS "trades_token_time_idx" ON "trades" ("token_id", "traded_at");
CREATE INDEX IF NOT EXISTS "trades_condition_time_idx" ON "trades" ("condition_id", "traded_at");
CREATE INDEX IF NOT EXISTS "trades_wallet_idx" ON "trades" ("proxy_wallet");
CREATE INDEX IF NOT EXISTS "trades_value_idx" ON "trades" ("value_usdc");
CREATE INDEX IF NOT EXISTS "trades_time_idx" ON "trades" ("traded_at");

-- order_book_snapshots: template table (will be converted to partitioned in 0002)
CREATE TABLE IF NOT EXISTS "order_book_snapshots" (
  "id" bigint GENERATED ALWAYS AS IDENTITY,
  "token_id" varchar(80) NOT NULL,
  "condition_id" varchar(66) NOT NULL,
  "bids" jsonb NOT NULL,
  "asks" jsonb NOT NULL,
  "bid_depth_usdc" numeric(20, 2),
  "ask_depth_usdc" numeric(20, 2),
  "imbalance_ratio" numeric(10, 4),
  "mid" numeric(10, 6),
  "spread" numeric(10, 6),
  "book_hash" varchar(40),
  "snapshot_trigger" varchar(20),
  "captured_at" timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS "obs_token_time_idx" ON "order_book_snapshots" ("token_id", "captured_at");
CREATE INDEX IF NOT EXISTS "obs_condition_idx" ON "order_book_snapshots" ("condition_id");
CREATE INDEX IF NOT EXISTS "obs_imbalance_idx" ON "order_book_snapshots" ("imbalance_ratio");

CREATE TABLE IF NOT EXISTS "price_history" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "token_id" varchar(80) NOT NULL,
  "condition_id" varchar(66) NOT NULL,
  "price" numeric(10, 6) NOT NULL,
  "side" varchar(4),
  "event_type" varchar(30) NOT NULL,
  "recorded_at" timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS "ph_token_time_idx" ON "price_history" ("token_id", "recorded_at");
CREATE INDEX IF NOT EXISTS "ph_condition_idx" ON "price_history" ("condition_id");
CREATE INDEX IF NOT EXISTS "ph_recent_idx" ON "price_history" ("recorded_at");

CREATE TABLE IF NOT EXISTS "whale_alerts" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "trade_lookup_key" varchar(200) NOT NULL,
  "token_id" varchar(80) NOT NULL,
  "condition_id" varchar(66) NOT NULL,
  "usdc_value" numeric(20, 2) NOT NULL,
  "absolute_min_usdc" integer NOT NULL,
  "avg_trade_size_24h_at_alert" numeric(20, 6),
  "stddev_24h_at_alert" numeric(20, 6),
  "volume_24h_at_alert" numeric(20, 6),
  "sigmas_above_mean" numeric(8, 4),
  "pct_of_daily_volume" numeric(8, 4),
  "price_at_alert" numeric(10, 6),
  "price_impact_estimate_usdc" numeric(10, 6),
  "book_depth_consumed_pct" numeric(6, 2),
  "book_snapshot_age_ms" integer,
  "wallet_total_volume_usdc" numeric(20, 2),
  "wallet_trade_count" integer,
  "wallet_first_seen_at" timestamptz,
  "wallet_win_ratio" numeric(6, 4),
  "enriched_at" timestamptz,
  "alerted_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "wa_token_time_idx" ON "whale_alerts" ("token_id", "alerted_at");
CREATE INDEX IF NOT EXISTS "wa_value_idx" ON "whale_alerts" ("usdc_value");
CREATE INDEX IF NOT EXISTS "wa_condition_idx" ON "whale_alerts" ("condition_id");
CREATE INDEX IF NOT EXISTS "wa_lookup_key_idx" ON "whale_alerts" ("trade_lookup_key");

CREATE TABLE IF NOT EXISTS "signals" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "token_id" varchar(80) NOT NULL,
  "condition_id" varchar(66) NOT NULL,
  "signal_type" varchar(40) NOT NULL,
  "direction" varchar(10),
  "confidence" numeric(6, 4) NOT NULL,
  "strength" numeric(10, 4),
  "price_at_signal" numeric(10, 6),
  "spread_at_signal" numeric(10, 6),
  "volume_at_signal" numeric(20, 6),
  "whale_alert_id" bigint REFERENCES "whale_alerts"("id"),
  "order_book_snapshot_id" bigint,
  "payload" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "signals_token_time_idx" ON "signals" ("token_id", "created_at");
CREATE INDEX IF NOT EXISTS "signals_type_time_idx" ON "signals" ("signal_type", "created_at");
CREATE INDEX IF NOT EXISTS "signals_confidence_idx" ON "signals" ("confidence");
CREATE INDEX IF NOT EXISTS "signals_condition_idx" ON "signals" ("condition_id");

CREATE TABLE IF NOT EXISTS "wallet_profiles" (
  "proxy_wallet" varchar(42) PRIMARY KEY,
  "total_volume_usdc" numeric(20, 2),
  "trade_count" integer DEFAULT 0,
  "whale_trade_count" integer DEFAULT 0,
  "first_seen_at" timestamptz,
  "last_seen_at" timestamptz,
  "resolved_trade_count" integer DEFAULT 0,
  "win_count" integer DEFAULT 0,
  "win_ratio" numeric(6, 4),
  "display_name" varchar(100),
  "pseudonym" varchar(100),
  "last_enriched_at" timestamptz,
  "enrichment_version" smallint DEFAULT 0
);

CREATE INDEX IF NOT EXISTS "wp_volume_idx" ON "wallet_profiles" ("total_volume_usdc");
CREATE INDEX IF NOT EXISTS "wp_win_ratio_idx" ON "wallet_profiles" ("win_ratio");
