# Board Brief: Polymarket Alpha Trading Data Pipeline — Phase 1 MVP

**Author:** Robin (Research Lead)  
**Date:** 2026-04-03  
**Status:** Ready for implementation

---

## 1. Context — What Exists, What We're Building

### Repo State
- **NEW PROJECT** — single `init` commit, one `README.md`, no source code.  
- Remote set to `git@github.com:flenry/polymarket-alpha.git` (main branch, work directly on main).
- PRD v2.0 is board-approved (Vegapunk + Law reviewed, all MAJOR findings addressed).
- PLAN.md in `pi-builder` is the post-review synthesis document.

### What We're Building
A real-time, single-operator, read-only data pipeline that:
1. Ingests trade events and order books from Polymarket's public APIs
2. Persists everything to PostgreSQL (partitioned from day one)
3. Runs a dual-threshold whale detector calibrated per market
4. Surfaces four alpha signal types as queryable DB records
5. Emits console alerts within 1s of whale detection

This is **Phase 1 only**: REST-based book snapshots (30s timer), Live-Data WS for trades, Gamma REST for market catalog. No CLOB WebSocket pool (Phase 2). No Discord/Slack alerts (Phase 2).

---

## 2. Project Type

**NEW PROJECT** — one init commit. Brook (git manager) should commit directly to `main` throughout. No feature branch needed.

---

## 3. Problem Statement & Goals

Polymarket's CLOB is fully public. Informed traders move prices 2–8% before markets react. A $200k YES bet on a geopolitical event is visible in real-time — but only if you're watching all active markets simultaneously. No off-the-shelf tool does this.

**Goal:** Catch whale trades (statistically large *per market*, not just absolutely large) before price adjusts. A $10k trade on a $200k/day niche market is alpha. A $40k trade on the FIFA World Cup ($17M/day) is noise.

**Dual-threshold whale detection (board-approved algorithm):**
- Gate 1: `valueUsdc >= absoluteMinUsdc` (default $10k) — filters dust
- Gate 2: `sigmasAboveMean >= 3` OR `pctOfDailyVolume >= 2%` — relative signal

Both gates must pass. Per-market calibration via `market_stats` table.

---

## 4. Stack (Confirmed)

| Layer | Technology |
|---|---|
| Language | TypeScript (strict mode) |
| Package manager | pnpm |
| Database | PostgreSQL 16 + Drizzle ORM |
| Testing | Vitest |
| Runtime | Node.js |
| Dependencies | `drizzle-orm`, `pg`, `ws`, `dotenv`, `zod` (payload validation) |

No new package additions without explicit approval. `// @ts-ignore` and `any` casts are disallowed.

---

## 5. Architecture Summary

### Data Sources (Phase 1)
| Source | What it provides | How we use it |
|---|---|---|
| Gamma REST `gamma-api.polymarket.com/markets` | Market catalog, bestBid/Ask, volume24hr, negRisk flag | Poll every 60s → build watchlist, upsert `markets` + `market_stats` |
| Live-Data WS `wss://ws-live-data.polymarket.com` | Real-time trade events (all markets) | Subscribe `{topic: "activity", type: "trades"}`, filter neg_risk at ingestion |
| CLOB REST `clob.polymarket.com/books` | Batch order book snapshots | POST `/books` every 30s for all watchlisted tokens |

### Component Map
```
GammaPoller (60s) ──────────────────────────────────┐
                                                     ▼
LiveDataWsClient → [neg_risk filter] → EventBus → WhaleDetector → AlertEmitter (stdout)
                                                     │                 └── whale_alerts table
                                                     ▼
ClobRestClient (30s timer) ────────────────→ SnapshotWriter → order_book_snapshots table
                                                     │
                                                     ▼
                                               SignalAggregator → signals table
                                                     │
                                               PartitionManager (daily cron)
```

### Database Tables (7 total)
| Table | Partitioned? | Retention |
|---|---|---|
| `markets` | No | Permanent |
| `market_stats` | No | Permanent |
| `trades` | Yes (daily by `traded_at`) | 90 days |
| `order_book_snapshots` | Yes (daily by `captured_at`) | 7 days |
| `price_history` | No | 365 days |
| `whale_alerts` | No | Permanent |
| `signals` | No | Permanent |

Partition DDL is in raw SQL migrations (Drizzle does not support declarative partitioning natively).

---

## 6. Project Structure to Build

```
polymarket-alpha/
├── src/
│   ├── db/
│   │   ├── schema.ts              # Full Drizzle schema (PRD §8 — verbatim)
│   │   ├── client.ts              # drizzle(pool) singleton
│   │   ├── partition-manager.ts   # createTomorrowPartition, dropExpiredPartitions
│   │   └── queries/
│   │       ├── markets.ts
│   │       ├── trades.ts          # insertTrade with dedup check
│   │       ├── snapshots.ts
│   │       ├── signals.ts
│   │       └── whales.ts
│   ├── sources/
│   │   ├── gamma-poller.ts
│   │   ├── clob-rest-client.ts
│   │   └── live-data-ws-client.ts
│   ├── events/
│   │   ├── types.ts               # All types from PRD §9 — verbatim
│   │   └── bus.ts
│   ├── processors/
│   │   ├── whale-detector.ts
│   │   ├── snapshot-writer.ts
│   │   ├── signal-aggregator.ts
│   │   └── alert-emitter.ts
│   ├── signals/
│   │   ├── whale-signal.ts
│   │   ├── imbalance-signal.ts
│   │   ├── price-impact-signal.ts
│   │   └── velocity-signal.ts
│   ├── config.ts
│   ├── pipeline.ts
│   └── index.ts
├── tests/
│   ├── fixtures/
│   │   ├── book-event.json
│   │   ├── trade-event.json
│   │   ├── gamma-market.json
│   │   ├── gamma-market-neg-risk.json
│   │   └── whale-trade.json
│   ├── WhaleDetector.test.ts
│   ├── GammaPoller.test.ts
│   ├── LiveDataWsClient.test.ts
│   ├── SnapshotWriter.test.ts
│   ├── SignalAggregator.test.ts
│   └── dedup.test.ts
├── drizzle/
│   ├── 0001_initial_schema.sql
│   └── 0002_partition_trades.sql
├── drizzle.config.ts
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

---

## 7. Key Implementation Decisions (Board-Approved)

### Deduplication Strategy
Trades: non-unique index on `transactionHash` (one tx can fill multiple rows). App-layer dedup composite key: `(transactionHash, tokenId, proxyWallet, tradedAt, priceUsdc, sizeTokens)`. Check before insert, skip on collision.

### Neg-Risk Handling
Filter at **two** boundaries:
1. `GammaPoller`: stores neg_risk markets with `watchlisted = false` — never added to watchlist token set
2. `LiveDataWsClient`: maintains a `Set<tokenId>` of neg_risk tokens; skips any trade event matching

### Partition Management
`PartitionManager` runs two crons:
- **Create:** daily at midnight — creates tomorrow's partition for `trades` and `order_book_snapshots`
- **Drop:** weekly — drops partitions older than retention window (90 days trades, 7 days snapshots)

### Zod Validation
All incoming API payloads validated with `zod.safeParse()`. Unknown fields logged, not thrown. Pipeline never crashes on malformed input.

### USDC Value Calculation
`valueUsdc = sizeTokens × priceUsdc` where `priceUsdc` is already in `[0.00, 1.00]`. This is USDC *spent*, not notional exposure. Document clearly in code comments.

---

## 8. Phase 1 Exit Criteria (Must Pass Before Phase 2)

1. After 10 minutes running: `trades` has > 100 rows
2. `order_book_snapshots` has rows for all watchlisted markets with `snapshotTrigger = 'rest_timer'`
3. `markets` table: zero neg_risk tokens with `watchlisted = true`
4. Pipeline survives WS reconnect without crash
5. All unit tests pass (`pnpm test`)
6. TypeScript strict mode: zero `tsc` errors

---

## 9. Key Unknowns & Risks (Flagged for Board)

### Risk 1 — `market_stats` cold-start problem
**Problem:** `WhaleDetector` reads `avgTradeSize24h` and `stddevTradeSize24h` from `market_stats`. For markets with < 24h of live data, these are unreliable or null.  
**PRD ruling:** Skip relative-σ check when `stddevTradeSize24h = 0 | null`; apply only pct-of-volume gate. Acceptable for Phase 1.  
**Question for Vegapunk:** Should we seed `market_stats` with historical data from `data-api/trades` on first start, or accept the cold-start degradation? Recommendation: accept degradation in Phase 1, add backfill script in Phase 5.

### Risk 2 — CLOB REST `/books` batch size limit
**Problem:** Undocumented limit on how many `token_id`s can go in one POST `/books` request. With 200 watchlisted tokens, one batch may be too large.  
**Mitigation:** Chunk into batches of 50 tokens per request, run sequentially with 100ms delay. Configurable via `SNAPSHOT_BATCH_SIZE` env var.  
**Question for Zoro:** Implement chunked batching in `ClobRestClient.batchGetBooks()` from day one.

### Risk 3 — Live-Data WS payload schema drift
**Problem:** Polymarket has changed WS field names before. If `asset` field becomes `tokenId` in a future update, silent ingestion failure.  
**Mitigation:** Zod schema with `safeParse` + log unknown fields. PRD specifies field names at §6.3 — treat these as the v1 schema baseline.

### Risk 4 — Partition DDL vs Drizzle migrations conflict
**Problem:** Drizzle generates standard `CREATE TABLE` for `trades` and `order_book_snapshots`. The partition migration (`0002_partition_trades.sql`) then renames and recreates them. If Drizzle introspects the schema post-partition, it may try to re-create the table.  
**Mitigation:** Run `0001` (Drizzle-generated) then `0002` (raw SQL, partition conversion) in strict order. Do not run `drizzle-kit push` after migrations are applied — use `drizzle-kit migrate` only.  
**Question for Vegapunk:** Is there a cleaner way to declare partitioned tables in Drizzle v0.30+? If not, confirm the `LIKE ... INCLUDING ALL` pattern is sufficient.

### Risk 5 — WS reconnect during high-volume period = trade gap
**Problem:** LiveDataWsClient reconnects with exponential backoff (1s → 30s). During reconnect, trades are missed. No recovery fetch is specified for Phase 1.  
**PRD ruling:** Acceptable gap for Phase 1. Phase 2 adds a reconnect-triggered backfill from `data-api/trades`.  
**Mitigated by:** Logging the gap start/end timestamps so the operator knows the window.

---

## 10. Questions for Vegapunk

1. **Partition DDL:** Is there a Drizzle v0.30+ native way to declare `PARTITION BY RANGE` tables, or do we commit to raw SQL migrations for `trades` and `order_book_snapshots`? If raw SQL is the answer, confirm the `LIKE ... INCLUDING ALL` + data copy + drop legacy pattern is safe for indexes.

2. **`market_stats` seeding:** Should `GammaPoller` on first start attempt to backfill `avgTradeSize24h`/`stddevTradeSize24h` from `data-api/trades` (paginated, slow) or accept null until 24h of live data accumulates?

3. **EventBus implementation:** The PRD says "typed in-process EventEmitter / AsyncIterable." Should the bus be a typed wrapper around Node's `EventEmitter` (simpler, callback-based), or an `AsyncIterableIterator` pattern (better for backpressure)? Given Phase 1 volume estimates (~1000 trades/day), `EventEmitter` is sufficient — confirm.

4. **`zod` as a dependency:** PRD §13 mentions `zod safeParse` on all inbound payloads. Is `zod` approved as a dependency, or should we use a lighter pattern (manual type guards)?

---

## 11. Questions for Law

1. **Chunked `/books` batching:** Should we expose `SNAPSHOT_BATCH_SIZE` as a config variable (default 50), or hardcode 50 and revisit only if the API rejects? Hardcoding is simpler for Phase 1.

2. **Trade gap during reconnect:** Should we log the exact missed-trade window and surface it as a structured warning, or is a simple `console.warn` acceptable for Phase 1?

3. **`wallet_profiles` table in Phase 1:** The schema includes `wallet_profiles` (wallet enrichment). Enrichment is Phase 2 work. Should `wallet_profiles` table be created in Phase 1 schema (ready for Phase 2 inserts) or deferred? Recommendation: create the table in Phase 1 schema — zero implementation cost, avoids a future migration on a busy table.

4. **Imbalance signal debounce scope:** PRD §10.2 says "do not re-emit within 5 minutes unless ratio shifted > 0.5." Should this debounce state be in-memory only (lost on restart) or persisted to DB? In-memory is simpler and acceptable for Phase 1.

---

## 12. Implementation Order (Recommended Execution Sequence)

```
1. Repo scaffold (pnpm init, tsconfig, package.json, .env.example)
2. src/events/types.ts       — all types, no deps
3. src/db/schema.ts          — Drizzle schema, no deps
4. src/db/client.ts          — DB connection singleton
5. drizzle migrations        — 0001 schema + 0002 partition DDL
6. src/config.ts             — env-based config
7. src/events/bus.ts         — typed EventEmitter wrapper
8. src/db/queries/*          — DB query functions
9. src/sources/gamma-poller.ts
10. src/sources/clob-rest-client.ts
11. src/sources/live-data-ws-client.ts
12. src/processors/whale-detector.ts
13. src/processors/snapshot-writer.ts
14. src/processors/signal-aggregator.ts
15. src/processors/alert-emitter.ts
16. src/db/partition-manager.ts
17. src/signals/*            — four signal algorithms
18. src/pipeline.ts          — wire all components
19. src/index.ts             — entrypoint
20. tests/* + fixtures       — all unit tests
21. drizzle.config.ts
22. README.md update
```

Dependencies flow: types → schema → DB client → queries → sources → processors → signals → pipeline → index → tests.

---

## 13. Summary for Brook (Git)

- **Repo:** `/Users/cedric/code/polymarket-alpha`
- **Type:** NEW PROJECT — commit directly to `main`
- **Remote:** `git@github.com:flenry/polymarket-alpha.git` (already set)
- **Current state:** One init commit, `README.md` only
- **Pattern:** Commit after each logical chunk (scaffold, schema, sources, processors, tests, final)
- **Final push:** `git push -u origin main` when all Phase 1 implementation is complete and tests pass
