# polymarket-alpha — CLAUDE.md

Quick-reference context for returning sessions. Read this first on every visit.

---

## What this is

Real-time Polymarket data pipeline. Ingests trade events and order book data, persists to PostgreSQL, and runs a signal engine that surfaces alpha opportunities — specifically whale trades caught before price adjusts.

**Phase 1 MVP is complete and fully tested.** 256 tests passing, 92%+ coverage.
**Phase 2 is complete and fully tested.** 357 tests passing, 97.33% stmt / 95.91% branch coverage.
**Phase 3 is complete and fully tested.** 414 tests passing, 95.88% stmt / 94.64% branch coverage.

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
├── drizzle/               # SQL migration files + meta journal (0000_*, 0002_partition_trades.sql, README.md, meta/)
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
| `ClobWsPool` | Sharded WebSocket pool to `wss://ws-subscriptions-clob.polymarket.com/ws/market`. Shards watchlisted tokens (non-neg-risk) into batches of `CLOB_WS_SHARD_SIZE` (default 150). Per-shard reconnect with jitter backoff. Handles `market_resolved` → `markMarketClosed`. Phase 2. |
| `StatsBootstrap` | Seeds `market_stats` from Gamma volume data on startup. |

### Processors
| Component | Role |
|---|---|
| `WhaleDetector` | Dual-threshold: Gate 1 `valueUsdc >= absoluteMinUsdc` ($10k default); Gate 2 `sigmas >= 3` OR `pct_of_daily_volume >= 2%`. Reads per-market stats for calibration. |
| `SnapshotWriter` | REST-timer (30s), writes `order_book_snapshots`. |
| `SignalAggregator` | Writes `signals` + `whale_alerts` for 4 signal types. Optional `onWhaleInserted` callback for post-insert enrichment. Phase 2: fires callback with `(alert, alertId)` for `WalletEnricher`. |
| `OrderBookImbalanceEngine` | REST-timer path (Phase 1, frozen): detects bid/ask depth imbalance > 3:1 from snapshot REST data. 5-min debounce. |
| `WsBookImbalanceEvaluator` | WS-path (Phase 2): lightweight evaluator for `BookUpdateEvent` from ClobWsPool. Confidence = `min(1.0, (ratio - threshold)/threshold)`, strength = total depth, 60s cooldown. Inserts `ws_event` snapshot on every evaluate call. |
| `PriceHistoryWriter` | Persists `last_trade_price` and `best_bid_ask` events. |

### Alerts & Enrichment
| Component | Role |
|---|---|
| `AlertEmitter` | Emits whale alerts to stdout JSON + human-readable format. Phase 2: optionally fires `WebhookEmitter.send()` fire-and-forget. |
| `WebhookEmitter` | Discord + Slack webhook delivery. Token-bucket 5 req/s. 429 retry once. No-op when URLs empty. Phase 2. |
| `WalletEnricher` | Async wallet profiling via `data-api.polymarket.com/activity`. 24h recency guard (skips fetch if profile updated within 24h). 2 req/s token-bucket. 5s timeout with AbortController. Upserts `wallet_profiles`, enriches `whale_alerts` row. Phase 2. |

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
- **Phase 2 fully wired**: `ClobWsPool`, `WsBookImbalanceEvaluator`, `WebhookEmitter`, and `WalletEnricher` are all live in `pipeline.ts`.

---

## Current State

**Phase 1 complete.**
- ✅ All 256 tests passing (30 test files)
- ✅ 92.3% statement coverage (100% on all processors, signals, events, alerts, queries)
- ✅ Migration SQL generated and committed (`drizzle/`)
- ✅ `drizzle/meta/_journal.json` registers two entries: `0000_misty_thaddeus_ross` (idx 0) and `0002_partition_trades` (idx 1)
- ✅ Docker Compose configured
- ✅ Pushed to `main` on `git@github.com:flenry/polymarket-alpha.git`

**Phase 2 complete (branch: `feat/phase-2`).**
- ✅ All 357 tests passing (34 test files, +101 tests over Phase 1)
- ✅ `ClobWsPool` — url option, jitter reconnect, `market_resolved` → `markMarketClosed` DB update
- ✅ `WsBookImbalanceEvaluator` — WS-path evaluator with spec-correct confidence formula, snapshot insert on every evaluate
- ✅ `WebhookEmitter` — Discord + Slack webhooks, 5 req/s token-bucket, 429 retry, network error swallow
- ✅ `WalletEnricher` — async wallet profiling, 24h recency guard, 2 req/s bucket, 5s timeout
- ✅ `SignalAggregator` — `onWhaleInserted` callback for WalletEnricher alertId handoff
- ✅ `AlertEmitter` — optional `WebhookEmitter` parameter (backward-compatible)
- ✅ Pipeline wired: ClobWsPool + WsBookImbalanceEvaluator + WebhookEmitter + WalletEnricher
- ✅ `src/db/queries/wallets.ts` — `upsertWalletProfile`, `getWalletProfile`
- ✅ `src/db/queries/markets.ts` — `markMarketClosed` added
- ✅ `src/db/queries/whales.ts` — `walletFirstSeenAt` field added to `enrichWhaleAlert`
- ✅ Config: 8 new Phase 2 env vars with defaults

**Phase 3 complete (branch: `feat/phase-3`).**
- ✅ All 414 tests passing (38 test files, +57 tests over Phase 2)
- ✅ `PriceImpactSignalEvaluator` v2 — in-memory, no hot-path DB reads, corrected depth mapping (BUY→askDepth, SELL→bidDepth)
- ✅ `SentimentVelocityEvaluator` v2 — rolling price+trade buffers, warm-up suppression, DB bootstrap
- ✅ `SignalAggregator` composite scoring — insert-then-update, `COMPOSITE_WINDOW_MS` window, logs `[COMPOSITE]`
- ✅ Backtesting module: `runner.ts`, `evaluator.ts`, `report.ts`, `types.ts` — `pnpm backtest --start ... --end ...`
- ✅ `src/db/queries/price-history.ts` — `getRecentPriceHistory`, `getRecentTradeTimestamps`
- ✅ `src/db/queries/signals.ts` — `updateSignalPayloads` for composite payload patching
- ✅ Config: 7 new Phase 3 env vars, 3 legacy Phase 1 vars removed
- ✅ Pipeline rewired: `PriceImpactSignalEvaluator` + `SentimentVelocityEvaluator` wired per sequencing contract
- ✅ `backtest-results/` directory created; `pnpm backtest` script added

**Not yet built (Phase 4+):**
- Neg-risk signal generation (Phase 4)

### Two separate imbalance evaluators — distinct trigger paths

| Evaluator | Path | File | Cooldown | Confidence formula |
|---|---|---|---|---|
| `OrderBookImbalanceEngine` | REST timer (30s) | `book-imbalance-engine.ts` | 5 min debounce | Phase 1 formula |
| `WsBookImbalanceEvaluator` | WS `BookUpdateEvent` | `ws-book-imbalance-evaluator.ts` | 60s per-token | `min(1.0, (ratio-threshold)/threshold)` |

They have **separate `lastEmits` maps** — no shared cooldown state. REST path never suppresses WS signals.

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
pnpm db:migrate                   # applies 0000 + 0002 via drizzle-kit
# If drizzle-kit can't apply partition DDL cleanly, run directly:
pnpm db:migrate:partitions        # psql $DATABASE_URL -f drizzle/0002_partition_trades.sql

# 5. Start pipeline
pnpm start
```

Or run everything in Docker:
```bash
docker compose up -d
```

## How to Test

```bash
pnpm test              # unit tests (all 414, 38 test files)
pnpm test:coverage     # with v8 coverage report (95.88% stmt, 94.64% branch)
pnpm typecheck         # tsc --noEmit
pnpm db:generate       # generate drizzle migrations (idempotent after init)
pnpm db:migrate        # apply all tracked migrations (0000 + 0002)
pnpm db:migrate:partitions  # fallback: apply 0002 partition DDL via psql directly
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
| `CLOB_WS_URL` | wss://ws-subscriptions-clob... | ClobWsPool WebSocket URL |
| `CLOB_WS_SHARD_SIZE` | 150 | Tokens per WS shard |
| `CLOB_WS_MAX_RECONNECT_DELAY_MS` | 30000 | Max reconnect backoff (ms) |
| `IMBALANCE_RATIO_THRESHOLD` | 3.0 | Bid/ask ratio trigger for WS imbalance |
| `IMBALANCE_COOLDOWN_MS` | 60000 | Per-token cooldown for WS imbalance signal |
| `DISCORD_WEBHOOK_URL` | "" | Discord webhook URL (empty = disabled) |
| `SLACK_WEBHOOK_URL` | "" | Slack webhook URL (empty = disabled) |
| `WALLET_ENRICHMENT_TIMEOUT_MS` | 5000 | Fetch timeout for wallet enrichment |
| `WALLET_ENRICHMENT_RATE_LIMIT_RPS` | 2 | Max data-api calls per second |
| `WALLET_ENRICHMENT_RECENCY_HOURS` | 24 | Skip re-enrichment if profile < 24h old |

---

## Migration Notes

> **Important**: After `0002_partition_trades.sql` is applied, never run `drizzle-kit push` or `drizzle-kit generate` against a live DB. The partition DDL is invisible to drizzle-kit and it will generate a spurious diff. See `drizzle/README.md` for full operational notes.

---

Last updated: 2026-04-04 (Phase 3 final — 414 tests, 95.88% stmt / 94.64% branch coverage)
