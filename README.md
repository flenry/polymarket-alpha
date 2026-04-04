# Polymarket Alpha Trading Data Pipeline

A real-time data pipeline that ingests Polymarket market data, persists snapshots in PostgreSQL, and runs a signal engine that surfaces alpha opportunities.

## Overview

- **Trade ingestion**: Live-Data WebSocket (`wss://ws-live-data.polymarket.com`) for real-time trades
- **Market catalog**: Gamma REST API polled every 60s; neg-risk markets explicitly excluded
- **Order book snapshots**: CLOB REST batch polling + CLOB WebSocket pool (`ClobWsPool`, sharded, Phase 2)
- **Whale detection**: Dual-threshold (absolute $10k + 3σ above mean OR 2% of daily volume)
- **Signal engine**: 6 signal types: `WHALE_TRADE`, `ORDER_BOOK_IMBALANCE`, `PRICE_IMPACT_ANOMALY`, `SENTIMENT_VELOCITY`, `NEG_RISK_ARB`, `NEG_RISK_OUTLIER`; composite confidence scoring across co-occurring signals
- **Deduplication**: DB-enforced unique index on `(tx_hash, token_id, proxy_wallet, traded_at, price_usdc, size_tokens)`
- **Partitioning**: Daily partitions on `trades` and `order_book_snapshots` from day 1
- **Webhook alerts**: Discord + Slack delivery via `WebhookEmitter` (5 req/s, 429 retry) — Phase 2; purple embeds for neg-risk signals — Phase 4
- **Wallet enrichment**: Async wallet profiling from data-api, 24h recency guard, upserts `wallet_profiles` — Phase 2
- **Backtesting**: `pnpm backtest` — precision/recall/F1 per signal type against resolved markets — Phase 3
- **Neg-risk cross-book model**: `NegRiskEngine` groups multi-outcome markets by `conditionId`, detects arb spreads and outlier mispricings — Phase 4
- **Analytics CLIs**: wallet leaderboard, signal dashboard (real-time), market heat map — Phase 5

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
# Unit tests (480 tests, 44 test files)
pnpm test

# With v8 coverage report
pnpm test:coverage

# Type-check only
pnpm typecheck

# Backtest signals against resolved markets
pnpm backtest --start 2025-01-01 --end 2025-04-01
pnpm backtest --start 2025-01-01 --end 2025-04-01 --signal-types WHALE_TRADE,PRICE_IMPACT_ANOMALY --min-confidence 0.6

# Analytics CLIs (Phase 5)
pnpm leaderboard                                  # wallet win-rate leaderboard (top 20)
pnpm leaderboard --min-trades=10 --top=10 --json  # with filters, JSON output
pnpm dashboard                                    # signal dashboard (refreshes every 30s)
pnpm dashboard --days=3 --once                    # single snapshot
pnpm heatmap                                      # market heat map (last 24h)
pnpm heatmap --hours=48                           # wider time window
```

## Architecture

```
Sources:
  GammaPoller (60s REST)  → market catalog; neg-risk markets watchlisted=true (Phase 4)
  LiveDataWsClient (WS)   → trade events (all markets incl. neg-risk)
  ClobRestClient (REST)   → batch order book snapshots
  ClobWsPool (WS sharded) → real-time book events, market_resolved handling

Event Bus (TypedEventBus):
  "trade"                       → insertTrade (dedup), WhaleDetector (non-neg-risk only)
  "whale_alert"                 → AlertEmitter (stdout + webhooks <1s), SignalAggregator
  "signal"                      → SignalAggregator → signals table
  "book_update" (BookUpdateEvent)→ WsBookImbalanceEvaluator + NegRiskEngine (neg-risk tokens)
  "last_trade_price" / "best_bid_ask" → PriceHistoryWriter
  "markets_updated"             → NegRiskEngine.addTokenIds + ClobWsPool.addTokenIds

Processors:
  WhaleDetector               → dual-threshold, per-market calibrated
  OrderBookImbalanceEngine    → REST-path: bid/ask depth ratio > 3:1, 5-min debounce
  WsBookImbalanceEvaluator    → WS-path: real-time ratio, 60s per-token cooldown
  SnapshotWriter              → order_book_snapshots table
  PriceHistoryWriter          → price_history table
  SignalAggregator            → signals + whale_alerts tables; fires onWhaleInserted
                                 composite scoring: co-occurring signals enriched with compositeScore in payload

Signals (Phase 3):
  PriceImpactSignalEvaluator  → in-memory, no hot-path DB reads; BUY→askDepth, SELL→bidDepth; 60s stale snapshot guard
  SentimentVelocityEvaluator  → rolling price+trade buffers; warm-up suppression; DB bootstrap on startup

Neg-Risk Engine (Phase 4):
  GroupResolver               → groups neg-risk markets by conditionId, validates sumAsk in [0.95, 1.20]
  ArbDetector                 → NEG_RISK_ARB when sumAsk-1.0 < -0.02; NEG_RISK_OUTLIER at >3σ deviation
  NegRiskEngine               → orchestrates GroupResolver + ArbDetector; debounced addTokenIds; purple Discord embeds

Backtesting (Phase 3):
  BacktestRunner              → queries signals + markets, joins resolutions, calls evaluator
  BacktestEvaluator           → precision/recall/F1 per signal type + overall
  BacktestReport              → stdout table + backtest-results/{start}_{end}.json

Analytics CLIs (Phase 5):
  leaderboard.ts              → wallet win-rate ranking (pnpm leaderboard)
  signal-dashboard.ts         → signal counts + whale stats, 30s refresh (pnpm dashboard)
  heat-map.ts                 → top 20 markets by signal density (pnpm heatmap)

Alerts & Enrichment:
  AlertEmitter                → stdout JSON + optional WebhookEmitter
  WebhookEmitter              → Discord + Slack, 5 req/s token-bucket, 429 retry; purple embeds for neg-risk
  WalletEnricher              → data-api profiling, 2 req/s, 24h recency guard
```

## Signal Types

| Signal | Trigger |
|--------|---------|
| `WHALE_TRADE` | `valueUsdc >= $10k` AND (`sigmas >= 3` OR `pct >= 2%`) |
| `ORDER_BOOK_IMBALANCE` | bid/ask depth ratio > 3:1 or < 1:3 |
| `PRICE_IMPACT_ANOMALY` | actual price impact / expected book-depth impact > threshold (default 2.5×) |
| `SENTIMENT_VELOCITY` | \|price velocity\| > 0.5%/min AND trade count velocity > 1.5× prior window |
| `NEG_RISK_ARB` | neg-risk group sumAsk - 1.0 < -0.02 (configurable via `NEG_RISK_ARB_THRESHOLD`) |
| `NEG_RISK_OUTLIER` | neg-risk token price deviates > 3σ from its 24h mean |

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
| `CLOB_WS_URL` | wss://ws-subscriptions-clob.polymarket.com/ws/market | ClobWsPool endpoint |
| `CLOB_WS_SHARD_SIZE` | 150 | Tokens per WS shard |
| `CLOB_WS_MAX_RECONNECT_DELAY_MS` | 30000 | Max reconnect backoff (ms) |
| `IMBALANCE_RATIO_THRESHOLD` | 3.0 | Bid/ask ratio trigger (WS path) |
| `IMBALANCE_COOLDOWN_MS` | 60000 | Per-token WS imbalance cooldown |
| `DISCORD_WEBHOOK_URL` | "" | Discord webhook (empty = disabled) |
| `SLACK_WEBHOOK_URL` | "" | Slack webhook (empty = disabled) |
| `WALLET_ENRICHMENT_TIMEOUT_MS` | 5000 | Wallet fetch timeout |
| `WALLET_ENRICHMENT_RATE_LIMIT_RPS` | 2 | data-api calls per second |
| `WALLET_ENRICHMENT_RECENCY_HOURS` | 24 | Skip re-enrichment if profile < N hours old |
| `PRICE_IMPACT_ANOMALY_THRESHOLD` | 2.5 | Anomaly score multiplier to fire price-impact signal |
| `PRICE_IMPACT_COOLDOWN_MS` | 30000 | Per-token cooldown for price-impact signal (ms) |
| `VELOCITY_WINDOW_SECONDS` | 300 | Rolling window for sentiment velocity (seconds) |
| `VELOCITY_PRICE_THRESHOLD` | 0.005 | Price velocity threshold (% per minute, 0.5%) |
| `VELOCITY_TRADE_COUNT_MULTIPLIER` | 1.5 | Trade count velocity multiplier vs prior window |
| `VELOCITY_COOLDOWN_MS` | 120000 | Per-token cooldown for velocity signal (ms) |
| `COMPOSITE_WINDOW_MS` | 60000 | Window for composite confidence scoring across co-occurring signals |
| `NEG_RISK_REFRESH_INTERVAL_MS` | 120000 | How often NegRiskEngine refreshes groups |
| `NEG_RISK_ARB_THRESHOLD` | -0.02 | Fire arb signal when sumAsk - 1.0 < this |
| `NEG_RISK_COOLDOWN_MS` | 60000 | Per-conditionId cooldown for neg-risk signals |
| `DASHBOARD_REFRESH_MS` | 30000 | Signal dashboard refresh interval |
| `LEADERBOARD_MIN_TRADES` | 5 | Default minimum trades filter for leaderboard |
| `LEADERBOARD_TOP_N` | 20 | Default number of wallets shown in leaderboard |

## Developer Reference

See [CLAUDE.md](./CLAUDE.md) for full architecture notes, component descriptions, conventions, and current state — formatted for AI-assisted development sessions.

## Database Partitioning

- `trades`: partitioned by `traded_at` (daily), retention 90 days
- `order_book_snapshots`: partitioned by `captured_at` (daily), retention 7 days
- `PartitionManager` creates partitions daily at midnight UTC
