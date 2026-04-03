# Polymarket Alpha Trading Data Pipeline

A real-time data pipeline that ingests Polymarket market data, persists snapshots in PostgreSQL, and runs a signal engine that surfaces alpha opportunities.

## Overview

- **Trade ingestion**: Live-Data WebSocket (`wss://ws-live-data.polymarket.com`) for real-time trades
- **Market catalog**: Gamma REST API polled every 60s; neg-risk markets explicitly excluded
- **Order book snapshots**: CLOB REST batch polling (Phase 1), CLOB WebSocket pool (Phase 3)
- **Whale detection**: Dual-threshold (absolute $10k + 3σ above mean OR 2% of daily volume)
- **Signal engine**: 4 signal types: `WHALE_TRADE`, `ORDER_BOOK_IMBALANCE`, `PRICE_IMPACT_ANOMALY`, `SENTIMENT_VELOCITY`
- **Deduplication**: DB-enforced unique index on `(tx_hash, token_id, proxy_wallet, traded_at, price_usdc, size_tokens)`
- **Partitioning**: Daily partitions on `trades` and `order_book_snapshots` from day 1

## Stack

- **Language**: TypeScript (strict mode)
- **Runtime**: Node.js v22
- **Package manager**: pnpm
- **Database**: PostgreSQL 16 + Drizzle ORM (partitioned tables)
- **Testing**: Vitest

## Quick Start

```bash
# Install dependencies
pnpm install

# Configure environment
cp .env.example .env
# Edit .env with your DATABASE_URL

# Run migrations
pnpm db:migrate
# If drizzle-kit can't apply partition DDL cleanly, use the fallback:
pnpm db:migrate:partitions

# Start pipeline
pnpm start
```

## Docker

```bash
docker compose up -d
```

## Testing

```bash
# Unit tests (256 tests, 30 test files)
pnpm test

# With v8 coverage report (~92% overall, 100% on processors/signals/alerts)
pnpm test:coverage

# Type-check only
pnpm typecheck
```

## Architecture

```
Sources:
  GammaPoller (60s REST) → market catalog, neg_risk filter
  LiveDataWsClient (WS)  → trade events
  ClobRestClient (REST)  → batch order book snapshots
  ClobWsPool (WS)        → real-time book events (Phase 3)

Event Bus (TypedEventBus):
  "trade" → insertTrade (dedup), WhaleDetector
  "whale_alert" → AlertEmitter (stdout <1s), SignalAggregator
  "signal" → SignalAggregator → signals table
  "last_trade_price" / "best_bid_ask" → PriceHistoryWriter

Processors:
  WhaleDetector          → dual-threshold, per-market calibrated
  OrderBookImbalanceEngine → bid/ask depth ratio > 3:1
  SnapshotWriter         → order_book_snapshots table
  PriceHistoryWriter     → price_history table
  SignalAggregator       → signals + whale_alerts tables
```

## Signal Types

| Signal | Trigger |
|--------|---------|
| `WHALE_TRADE` | `valueUsdc >= $10k` AND (`sigmas >= 3` OR `pct >= 2%`) |
| `ORDER_BOOK_IMBALANCE` | bid/ask depth ratio > 3:1 or < 1:3 |
| `PRICE_IMPACT_ANOMALY` | Mid price moves > 2% in 60s |
| `SENTIMENT_VELOCITY` | 60-min return z-score > 2σ vs 24h baseline |

## Configuration

See `.env.example` for all configurable parameters.

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | required | PostgreSQL connection string |
| `WHALE_ABSOLUTE_MIN_USDC` | 10000 | Minimum trade size to alert |
| `WHALE_SIGMA_THRESHOLD` | 3 | Sigma threshold for relative check |
| `WHALE_PCT_VOLUME_THRESHOLD` | 0.02 | % of daily volume threshold |
| `SNAPSHOT_INTERVAL_MS` | 30000 | Order book snapshot interval |
| `GAMMA_POLL_INTERVAL_MS` | 60000 | Market catalog poll interval |

## Developer Reference

See [CLAUDE.md](./CLAUDE.md) for full architecture notes, component descriptions, conventions, and current state — formatted for AI-assisted development sessions.

## Database Partitioning

- `trades`: partitioned by `traded_at` (daily), retention 90 days
- `order_book_snapshots`: partitioned by `captured_at` (daily), retention 7 days
- `PartitionManager` creates partitions daily at midnight UTC
