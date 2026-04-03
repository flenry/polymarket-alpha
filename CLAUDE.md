# polymarket-alpha — CLAUDE.md

Quick-reference context for returning sessions. Read this first on every visit.

---

## What this is

Real-time Polymarket data pipeline. Ingests trade events and order book data, persists to PostgreSQL, and runs a signal engine that surfaces alpha opportunities — specifically whale trades caught before price adjusts.

**Phase 1 MVP is complete and fully tested.** 251 tests passing, 92%+ coverage.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Language | TypeScript (strict mode) |
| Runtime | Node.js v22 |
| Package manager | pnpm |
| Database | PostgreSQL 16 + Drizzle ORM |
| Testing | Vitest |
| Containerisation | Docker + docker-compose |

---

## Project Structure

```
polymarket-alpha/
├── src/
│   ├── sources/           # Data ingest: GammaPoller, ClobRestClient, LiveDataWsClient, ClobWsPool, StatsBootstrap
│   ├── processors/        # Core logic: WhaleDetector, SnapshotWriter, SignalAggregator, BookImbalanceEngine, PriceHistoryWriter
│   ├── signals/           # Signal helpers: velocity-signal, price-impact-signal
│   ├── alerts/            # AlertEmitter (stdout JSON, <1s latency)
│   ├── events/            # TypedEventBus + event types
│   ├── db/                # schema.ts, client.ts, partition-manager.ts, queries/
│   ├── validation/        # Zod schemas for external API responses
│   ├── config.ts          # Env-var config with Zod validation
│   ├── logger.ts          # Pino logger
│   ├── pipeline.ts        # Pipeline orchestrator (wires all components)
│   └── index.ts           # Entry point
├── tests/                 # Integration-style tests (top-level: GammaPoller, Snapshot, WhaleDetector, dedup, LiveDataWs, SignalAgg)
├── drizzle/               # SQL migration files (0001_initial_schema.sql, 0002_partition_trades.sql)
├── drizzle.config.ts
├── docker-compose.yml     # postgres + app services
├── Dockerfile
├── .env.example
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## Key Components

### Sources
| Component | Role |
|---|---|
| `GammaPoller` | Polls `gamma-api.polymarket.com/markets` every 60s. Separates neg_risk markets (`watchlisted=false`) from live markets. |
| `ClobRestClient` | Batch-fetches order books via `POST /books` on `clob.polymarket.com`. |
| `LiveDataWsClient` | Connects to `wss://ws-live-data.polymarket.com`, subscribes `{topic:"activity", type:"trades"}`, auto-reconnects with exponential backoff (base 1s, cap 30s). |
| `StatsBootstrap` | Seeds `market_stats` from Gamma volume data on startup. |

### Processors
| Component | Role |
|---|---|
| `WhaleDetector` | Dual-threshold: Gate 1 `valueUsdc >= absoluteMinUsdc` ($10k default); Gate 2 `sigmas >= 3` OR `pct_of_daily_volume >= 2%`. Reads per-market stats for calibration. |
| `SnapshotWriter` | REST-timer (30s), writes `order_book_snapshots`. |
| `SignalAggregator` | Writes `signals` + `whale_alerts` for 4 signal types. |
| `BookImbalanceEngine` | Detects bid/ask depth imbalance > 3:1. |
| `PriceHistoryWriter` | Persists `last_trade_price` and `best_bid_ask` events. |

### Event Bus
Typed in-process `TypedEventBus` (extends Node EventEmitter). Events:
- `trade` → insertTrade (dedup) + WhaleDetector
- `whale_alert` → AlertEmitter + SignalAggregator
- `signal` → SignalAggregator → DB
- `last_trade_price` / `best_bid_ask` → PriceHistoryWriter
- `book_snapshot` → SnapshotWriter

---

## Database Schema

Tables (all in `src/db/schema.ts`):
- `markets` — market catalog, `watchlisted` flag, neg_risk flag
- `market_stats` — per-token: avg/stddev trade size, volume, count (24h window)
- `trades` — partitioned by `traded_at` (daily). Dedup unique index on `(tx_hash, token_id, proxy_wallet, traded_at, price_usdc, size_tokens)`
- `order_book_snapshots` — partitioned by `captured_at` (daily)
- `signals` — 4 signal types: WHALE_TRADE, ORDER_BOOK_IMBALANCE, PRICE_IMPACT_ANOMALY, SENTIMENT_VELOCITY
- `whale_alerts` — joins to trades, records both threshold values at alert time
- `price_history` — mid-price time series

Partitions are created/dropped by `PartitionManager` (daily cron, midnight UTC). Retention: trades 90d, snapshots 7d.

---

## Key Conventions

- **Neg-risk filter**: applied at ingestion (LiveDataWsClient) AND at catalog level (GammaPoller). Never process neg-risk token IDs.
- **Dedup**: composite unique index enforced in DB; app layer uses `ON CONFLICT DO NOTHING`.
- **Config**: all env vars validated via Zod in `src/config.ts`. No bare `process.env` access elsewhere.
- **Logging**: Pino structured JSON. `LOG_LEVEL` env var controls verbosity.
- **Tests**: all unit tests use mocked DB clients and HTTP/WS — no real network calls. Fixtures live in `tests/fixtures/`.
- **Test colocatio**: processor/signal/source tests live next to source files (`src/**/*.test.ts`). Integration-style tests live in `tests/`.
- **No Phase 2 code yet**: `ClobWsPool` stub exists but is not wired into the pipeline.

---

## Current State

**Phase 1 complete.**
- ✅ All 251 tests passing
- ✅ 92.3% statement coverage (100% on all processors, signals, events, alerts, queries)
- ✅ Sources coverage lower (79.7%) — real WS/HTTP code not network-testable
- ✅ Migration SQL generated and committed (`drizzle/`)
- ✅ Docker Compose configured
- ✅ Pushed to `main` on `git@github.com:flenry/polymarket-alpha.git`

**Not yet built (Phase 2+):**
- ClobWsPool (sharded WS connections to CLOB order book feed)
- Discord/Slack webhook alerts
- Wallet enrichment / whale profiling
- Neg-risk signal generation (Phase 4)
- Backtesting (Phase 3+)

---

## How to Run

```bash
# 1. Install deps
pnpm install

# 2. Configure
cp .env.example .env
# Edit DATABASE_URL

# 3. Start Postgres
docker compose up -d postgres

# 4. Run migrations
psql $DATABASE_URL -f drizzle/0001_initial_schema.sql
psql $DATABASE_URL -f drizzle/0002_partition_trades.sql

# 5. Start pipeline
pnpm start
```

Or run everything in Docker:
```bash
docker compose up -d
```

## How to Test

```bash
pnpm test              # unit tests (all 251)
pnpm test:coverage     # with v8 coverage report
pnpm typecheck         # tsc --noEmit
```

---

## Environment Variables

| Var | Default | Description |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string |
| `WHALE_ABSOLUTE_MIN_USDC` | 10000 | Gate 1: minimum trade value to alert |
| `WHALE_SIGMA_THRESHOLD` | 3 | Gate 2a: sigmas above per-market mean |
| `WHALE_PCT_VOLUME_THRESHOLD` | 0.02 | Gate 2b: fraction of 24h daily volume |
| `SNAPSHOT_INTERVAL_MS` | 30000 | Order book snapshot frequency |
| `GAMMA_POLL_INTERVAL_MS` | 60000 | Market catalog refresh frequency |
| `LOG_LEVEL` | info | Pino log level |

---

Last updated: 2026-04-03
