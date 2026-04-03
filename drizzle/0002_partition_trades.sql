-- Partition migration: convert trades and order_book_snapshots to partitioned tables
-- Run after 0001_initial_schema.sql
-- 
-- CRITICAL: partitioned tables require the partition key in the PRIMARY KEY.
-- Drizzle ORM cannot express PARTITION BY RANGE declaratively, so this is raw SQL.

-- ─────────────────────────────────────────────────────────────────────────────
-- TRADES: convert to PARTITION BY RANGE (traded_at)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE trades RENAME TO trades_legacy;

CREATE TABLE trades (
  id bigint GENERATED ALWAYS AS IDENTITY,
  token_id varchar(80) NOT NULL,
  condition_id varchar(66) NOT NULL,
  outcome varchar(50) NOT NULL DEFAULT '',
  side varchar(4) NOT NULL,
  size_tokens numeric(20,6) NOT NULL,
  price_usdc numeric(10,6) NOT NULL,
  value_usdc numeric(20,6) NOT NULL,
  proxy_wallet varchar(42) NOT NULL,
  transaction_hash varchar(66) NOT NULL,
  traded_at timestamptz NOT NULL,
  market_slug varchar(200),
  event_slug varchar(200),
  market_title text,
  trader_name varchar(100),
  trader_pseudonym varchar(100),
  source varchar(20) DEFAULT 'live_ws',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  -- Partition key MUST be included in PRIMARY KEY for partitioned tables
  PRIMARY KEY (id, traded_at)
) PARTITION BY RANGE (traded_at);

-- Unique dedup index — includes traded_at (partition key required for unique indexes on partitioned tables)
CREATE UNIQUE INDEX trades_dedup_idx ON trades
  (transaction_hash, token_id, proxy_wallet, traded_at, price_usdc, size_tokens);

CREATE INDEX trades_tx_hash_idx ON trades (transaction_hash);
CREATE INDEX trades_token_time_idx ON trades (token_id, traded_at);
CREATE INDEX trades_condition_time_idx ON trades (condition_id, traded_at);
CREATE INDEX trades_wallet_idx ON trades (proxy_wallet);
CREATE INDEX trades_value_idx ON trades (value_usdc);
CREATE INDEX trades_time_idx ON trades (traded_at);

-- Seed initial monthly partition (partition manager creates daily ones going forward)
CREATE TABLE trades_2026_04 PARTITION OF trades
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

-- Migrate data from legacy table (if any rows exist)
INSERT INTO trades (token_id, condition_id, outcome, side, size_tokens,
  price_usdc, value_usdc, proxy_wallet, transaction_hash, traded_at,
  market_slug, event_slug, market_title, trader_name, trader_pseudonym, source, created_at)
SELECT token_id, condition_id, outcome, side, size_tokens,
  price_usdc, value_usdc, proxy_wallet, transaction_hash, traded_at,
  market_slug, event_slug, market_title, trader_name, trader_pseudonym, source, created_at
FROM trades_legacy;

DROP TABLE trades_legacy;

-- ─────────────────────────────────────────────────────────────────────────────
-- ORDER_BOOK_SNAPSHOTS: convert to PARTITION BY RANGE (captured_at)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE order_book_snapshots RENAME TO order_book_snapshots_legacy;

CREATE TABLE order_book_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY,
  token_id varchar(80) NOT NULL,
  condition_id varchar(66) NOT NULL,
  bids jsonb NOT NULL,
  asks jsonb NOT NULL,
  bid_depth_usdc numeric(20,2),
  ask_depth_usdc numeric(20,2),
  imbalance_ratio numeric(10,4),
  mid numeric(10,6),
  spread numeric(10,6),
  book_hash varchar(40),
  snapshot_trigger varchar(20),
  captured_at timestamptz NOT NULL,
  -- Partition key included in PRIMARY KEY
  PRIMARY KEY (id, captured_at)
) PARTITION BY RANGE (captured_at);

CREATE INDEX obs_token_time_idx ON order_book_snapshots (token_id, captured_at);
CREATE INDEX obs_condition_idx ON order_book_snapshots (condition_id);
CREATE INDEX obs_imbalance_idx ON order_book_snapshots (imbalance_ratio);

CREATE TABLE order_book_snapshots_2026_04 PARTITION OF order_book_snapshots
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

-- Migrate data from legacy table (if any rows exist)
INSERT INTO order_book_snapshots (token_id, condition_id, bids, asks,
  bid_depth_usdc, ask_depth_usdc, imbalance_ratio, mid, spread,
  book_hash, snapshot_trigger, captured_at)
SELECT token_id, condition_id, bids, asks,
  bid_depth_usdc, ask_depth_usdc, imbalance_ratio, mid, spread,
  book_hash, snapshot_trigger, captured_at
FROM order_book_snapshots_legacy;

DROP TABLE order_book_snapshots_legacy;
