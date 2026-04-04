# Plan: Backfill Seed Script — Real Polymarket Data

## Goal
`pnpm seed` fetches real Polymarket data (200 top-volume markets, last 24h trades,
order books) and idempotently populates the local Postgres DB, then runs whale
detection and signal computation, printing progress to stdout.

---

## Must-Haves (goal-backward)

- [ ] `pnpm seed` runs without errors when DB is migrated and reachable
- [ ] Markets table populated with up to 1 847 tokenIds (200 Gamma markets × up to 2 tokens each, enriched with CLOB metadata)
- [ ] Trades table populated with last 24h trades (paginated, deduped via DB unique index)
- [ ] `order_book_snapshots` populated with current top-of-book for all market tokens
- [ ] `price_history` bootstrapped from inserted trades (one entry per trade, `event_type='last_trade'`)
- [ ] `market_stats` computed from inserted trades (`avg`, `stddev`, `tradeCount24h`, `calibrated`)
- [ ] `whale_alerts` populated via existing `WhaleDetector` logic
- [ ] `signals` populated for `BOOK_IMBALANCE`, `PRICE_IMPACT_ANOMALY`, `SENTIMENT_VELOCITY`, and neg-risk signal types
- [ ] `wallet_profiles` aggregated from all inserted trades
- [ ] Partitions for trade dates are created before insert (via `createPartitionForDate`)
- [ ] Script is idempotent — re-running does not duplicate data
- [ ] DB-not-ready exits with a clear error message
- [ ] Unit tests mock all fetch/DB calls; no real network in test suite
- [ ] Existing 637 tests unaffected (zero regressions)

---

## Out of Scope

- Modifying `src/db/schema.ts`
- Modifying any `drizzle/` migration files
- Modifying any existing pipeline or dashboard source files
- Changing any existing test
- Adding any new npm dependency (no `tsx`, no extra packages)

---

## Architectural Decisions

### Script location: `src/seeder/` not `scripts/`
`tsconfig.json` sets `"rootDir": "./src"` — files outside `src/` cannot be
compiled by `tsc`. The existing analytics CLIs (`leaderboard`, `heatmap`,
`signal-dashboard`) all live in `src/analytics/` and run via `tsc && node
dist/analytics/<file>.js`. The seeder follows the same pattern.

```
src/seeder/
├── seed-backfill.ts        ← main entry point (pnpm seed)
├── seed-utils.ts           ← pure helpers: market parsing, dedup key, stats math
├── seed-backfill.test.ts   ← mocked fetch + DB — all seeder integration paths
└── seed-utils.test.ts      ← pure unit tests — no I/O
```

### Script invocation
```json
"seed": "tsc && node dist/seeder/seed-backfill.js"
```
Same pattern as `pnpm leaderboard` / `pnpm heatmap`.

### Imports
All imports use `.js` extensions (NodeNext moduleResolution). The seeder imports
existing helpers from:
- `../db/client.js` — `getDb`, `closeDb`
- `../db/partition-manager.js` — `createPartitionForDate`
- `../db/queries/markets.js` — `upsertMarket`, `upsertMarketStats`
- `../db/queries/trades.js` — `insertTrade`
- `../db/queries/snapshots.js` — `insertBookSnapshot`
- `../db/queries/wallets.js` — `upsertWalletProfile`
- `../db/queries/whales.js` — `insertWhaleAlert`
- `../db/queries/signals.js` — `insertSignal`
- `../processors/whale-detector.js` — `WhaleDetector`
- `../validation/schemas.js` — `ZGammaMarket`
- `../events/types.js` — `TradeEvent`, `MarketStats`, `OrderBook`

### Signal detection (seeder-local, not wired to bus)
The live pipeline uses an event bus. The seeder calls evaluators directly — no
bus needed. The seeder has a local `SeedSignalRunner` in `seed-backfill.ts`
that iterates over inserted data and calls into existing evaluators without
registering listeners.

---

## Tasks

### Chunk 1 — `seed-utils.ts` (pure helpers, no I/O)

- [ ] **Task 1.1**: `parseClobTokenIds(raw: unknown): string[]`
  - **File**: `src/seeder/seed-utils.ts`
  - **Signature**: `export function parseClobTokenIds(raw: unknown): string[]`
  - **Behaviour**: accepts `string` (JSON array `'["a","b"]'`), `string[]`, or anything else → returns `[]`; silently returns `[]` on JSON parse failure; deduplicates
  - **Outcome**: `parseClobTokenIds('["a","b"]')` → `["a","b"]`; `parseClobTokenIds(undefined)` → `[]`
  - **Test guidance**: 5 cases — string JSON array, already-array, non-array JSON, bad JSON string, undefined

- [ ] **Task 1.2**: `buildTradeEventFromDataApi(raw: DataApiTrade, marketRow: MarketRow): TradeEvent`
  - **File**: `src/seeder/seed-utils.ts`
  - **Signature**:
    ```ts
    export function buildTradeEventFromDataApi(
      raw: DataApiTrade,
      market: { conditionId: string; outcome: string; slug?: string | null; eventSlug?: string | null; question: string }
    ): TradeEvent
    ```
  - **Input type** `DataApiTrade`:
    ```ts
    export interface DataApiTrade {
      asset: string;           // tokenId
      conditionId: string;
      side: "BUY" | "SELL";
      size: number;
      price: number;
      proxyWallet: string;
      transactionHash: string;
      timestamp: number;       // Unix seconds
      outcome?: string;
      slug?: string;
      eventSlug?: string;
      title?: string;
      pseudonym?: string | null;
      name?: string | null;
    }
    ```
  - **Outcome**: returns typed `TradeEvent` with `valueUsdc = size * price`, `tradedAt = new Date(timestamp * 1000)`, `source = "data_api"`
  - **Test guidance**: one happy-path case; assert `valueUsdc === size * price`; assert `source === "data_api"`

- [ ] **Task 1.3**: `computeMarketStats(trades: TradeEvent[]): MarketStats`
  - **File**: `src/seeder/seed-utils.ts`
  - **Signature**:
    ```ts
    export function computeMarketStats(
      tokenId: string,
      conditionId: string,
      trades: TradeEvent[]
    ): MarketStats
    ```
  - **Behaviour**: computes `avgTradeSize24h`, `stddevTradeSize24h`, `tradeCount24h`, `volume24hr` (sum of `valueUsdc`), `calibrated` (tradeCount >= 30); `liquidityUsdc` defaults to 0 (not available from trades alone)
  - **Stddev formula**: population stddev `sqrt(sum((x - mean)²) / n)`, `0` when `n < 2`
  - **Outcome**: `computeMarketStats` on 30+ trades returns `calibrated: true`; on 0 trades returns zero-valued object
  - **Test guidance**: 0 trades, 1 trade, 30 trades; assert `calibrated` boundary; assert `volume24hr` sum

- [ ] **Task 1.4**: `buildWalletAggregates(trades: TradeEvent[], whaleLookup: Set<string>): Map<string, WalletAggregate>`
  - **File**: `src/seeder/seed-utils.ts`
  - **Types**:
    ```ts
    export interface WalletAggregate {
      proxyWallet: string;
      totalVolumeUsdc: number;
      tradeCount: number;
      whaleTradeCount: number;
      firstSeenAt: Date;
      lastSeenAt: Date;
    }
    ```
  - **Behaviour**: groups trades by `proxyWallet`; `whaleTradeCount` = number of trades whose `transactionHash|tokenId|proxyWallet|tradedAt|price|size` (lookup key format from `buildTradeLookupKey`) is in `whaleLookup`
  - **Outcome**: map has one entry per unique wallet; `totalVolumeUsdc` equals sum of `valueUsdc`
  - **Test guidance**: 3 wallets, 1 whale trade — assert map size 3, assert whale wallet's count

---

### Chunk 2 — `seed-backfill.ts` (main seeder)

- [ ] **Task 2.1**: `checkDbConnection(db): Promise<void>`
  - **File**: `src/seeder/seed-backfill.ts`
  - **Signature**: `async function checkDbConnection(db: Db): Promise<void>`
  - **Behaviour**: `SELECT 1` via `db.execute`; throws with message `"DB connection failed: <error>"` on failure; prints `🔗 Connecting to Postgres...  ✅` on success
  - **Outcome**: test — mock db.execute to throw → the outer runner catches and prints `DB_NOT_READY` style message

- [ ] **Task 2.2**: `fetchMarkets(fetchFn): Promise<GammaMarketEnriched[]>`
  - **File**: `src/seeder/seed-backfill.ts`
  - **Signature**:
    ```ts
    async function fetchMarkets(
      fetchFn?: typeof fetch
    ): Promise<GammaMarketEnriched[]>
    ```
  - **Where**: `https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=200`
  - **Behaviour**: parses response with `ZGammaMarket.safeParse` per item (skips invalids); expands `clobTokenIds` JSON string (via `parseClobTokenIds`) into one entry per tokenId with `outcomeIndex`; logs count
  - **Type** `GammaMarketEnriched`:
    ```ts
    interface GammaMarketEnriched {
      tokenId: string;
      outcomeIndex: number;
      market: GammaMarket;    // from ZGammaMarket
      negRisk: boolean;
    }
    ```
  - **Edge cases**: Gamma sometimes returns `clobTokenIds` as already-parsed array — `parseClobTokenIds` handles both; markets with 0 tokenIds are skipped
  - **Outcome**: function returns flat array, one entry per tokenId
  - **Test guidance**: mock fetch returning 2 markets (one with 2 tokens, one with 1) → assert 3 results returned

- [ ] **Task 2.3**: `fetchClobEnrichment(tokenIds: string[], fetchFn): Promise<Map<string, ClobMarketData>>`
  - **File**: `src/seeder/seed-backfill.ts`
  - **URL**: `https://clob.polymarket.com/sampling-markets`
  - **Type** `ClobMarketData`: `{ negRisk: boolean; acceptingOrders: boolean; minimumOrderSize?: number; minimumTickSize?: number }`
  - **Behaviour**: GET, parse array response, index by tokenId; returns empty Map on fetch failure (logs warn); validates token_id field exists
  - **Outcome**: returns Map keyed by token_id
  - **Test guidance**: mock returning 2 CLOB markets → assert Map size 2; mock 500 response → assert empty Map returned (no throw)

- [ ] **Task 2.4**: `fetchTrades(hoursBack: number, maxTotal: number, fetchFn): Promise<DataApiTrade[]>`
  - **File**: `src/seeder/seed-backfill.ts`
  - **URL pattern**: `https://data-api.polymarket.com/trades?limit=5000&after={unix_ts}`
  - **Behaviour**: paginate: fetch page, append results filtered to `timestamp >= cutoff`; stop when last item's timestamp < cutoff OR total >= maxTotal; logs each page; if page returns < 5000 items, it's the last page
  - **Edge cases**: empty first page → return `[]`; API response not array → log warn, return `[]`; total capped at `maxTotal`
  - **Outcome**: returns array of `DataApiTrade`, all with `timestamp >= 24h_ago`
  - **Test guidance**: mock 2 pages (5000 + 312 items) → assert 5312 returned; mock empty first page → assert `[]`

- [ ] **Task 2.5**: `fetchOrderBooks(tokenIds: string[], fetchFn): Promise<Map<string, OrderBookRaw>>`
  - **File**: `src/seeder/seed-backfill.ts`
  - **URL**: `POST https://clob.polymarket.com/books` with `{ token_ids: [...] }`
  - **Batch**: send up to 200 token IDs per POST request; iterate batches
  - **Behaviour**: parse CLOB book response (bids/asks as `{price: string, size: string}[]`); returns Map keyed by tokenId; logs on non-OK; empty Map on throw
  - **Type** `OrderBookRaw`: `{ tokenId: string; bids: {price: string; size: string}[]; asks: {price: string; size: string}[] }`
  - **Outcome**: all tokenIds' books merged into single Map
  - **Test guidance**: mock 250 tokenIds (2 batches); assert both POSTs fired; assert Map size 250

- [ ] **Task 2.6**: `insertMarkets(db, markets, clobMap, now): Promise<{inserted: number}>`
  - **File**: `src/seeder/seed-backfill.ts`
  - **Signature**:
    ```ts
    async function insertMarkets(
      db: Db,
      markets: GammaMarketEnriched[],
      clobMap: Map<string, ClobMarketData>,
      now: Date
    ): Promise<{ inserted: number }>
    ```
  - **Behaviour**: calls `upsertMarket` per entry (merges CLOB enrichment for `negRisk`, `acceptingOrders`, `minimumOrderSize`, `minimumTickSize`); calls `upsertMarketStats` with volume fields from Gamma; watchlisted = `acceptingOrders && !negRisk`; counts successful upserts
  - **Outcome**: returns `{ inserted: N }` where N = number of upsertMarket calls completed
  - **Test guidance**: 3 markets (2 non-neg-risk, 1 neg-risk) → assert upsertMarket called 3×, watchlisted=false for neg-risk

- [ ] **Task 2.7**: `insertTrades(db, rawTrades, knownTokenIds): Promise<{inserted: number; skipped: number}>`
  - **File**: `src/seeder/seed-backfill.ts`
  - **Behaviour**: calls `createPartitionForDate` for each unique date in the trade set before inserting (collect unique dates, create partitions, then insert); filters to `tokenId in knownTokenIds`; calls `insertTrade` per trade; tracks inserted vs skipped (not in knownTokenIds or duplicate)
  - **Edge cases**: trades for unknown tokenIds are skipped with a count log; partition creation error aborts with throw
  - **Outcome**: returns `{ inserted, skipped }`
  - **Test guidance**: mock 5 trades (3 known tokens, 2 unknown); mock insertTrade returning `{inserted: true}` / `{inserted: false}`; assert skipped count = 2 + dupe count

- [ ] **Task 2.8**: `bootstrapPriceHistory(db, trades): Promise<number>`
  - **File**: `src/seeder/seed-backfill.ts`
  - **Behaviour**: for each inserted TradeEvent, execute raw SQL insert into `price_history` with `event_type='last_trade'`, `recorded_at=trade.tradedAt`, `side=trade.side`; skip duplicates silently (`ON CONFLICT DO NOTHING` not supported — use try/catch per-row); returns count inserted
  - **Note**: `price_history` has no unique index — but this is called once per seed run, so all rows are net-new; still wrap in try/catch per row
  - **Outcome**: `price_history` has one row per inserted trade
  - **Test guidance**: 3 trades → assert 3 SQL calls

- [ ] **Task 2.9**: `recomputeMarketStats(db, tradesByToken, volume24hrMap): Promise<{calibrated: number; uncalibrated: number}>`
  - **File**: `src/seeder/seed-backfill.ts`
  - **Behaviour**: groups inserted trades by tokenId (passed as `Map<string, TradeEvent[]>`); calls `computeMarketStats` per token; calls `upsertMarketStats` with computed values; volume24hrMap carries Gamma volume for markets with 0 trades; returns calibrated/uncalibrated counts
  - **Outcome**: `calibrated` = tokens with tradeCount24h >= 30
  - **Test guidance**: 2 tokens (1 with 35 trades, 1 with 5) → assert calibrated=1, uncalibrated=1

- [ ] **Task 2.10**: `runWhaleDetection(db, trades, statsMap, booksMap): Promise<{alertCount: number; whaleLookup: Set<string>}>`
  - **File**: `src/seeder/seed-backfill.ts`
  - **Behaviour**: instantiates `WhaleDetector` with default config; for each trade, looks up stats from `statsMap` (skip if missing); builds `OrderBook | null` from `booksMap`; calls `detector.evaluate(trade, stats, book)`; if non-null alert, calls `insertWhaleAlert(db, alert)`; pushes alert to stdout via `console.log`; builds `whaleLookup` Set of lookup keys (for wallet aggregation)
  - **Outcome**: prints whale alerts, returns `{alertCount, whaleLookup}`
  - **Test guidance**: 2 trades (1 whale, 1 not); mock insertWhaleAlert; assert alertCount=1; assert console.log called once

- [ ] **Task 2.11**: `runSignalDetection(db, trades, statsMap, booksMap): Promise<SignalCounts>`
  - **File**: `src/seeder/seed-backfill.ts`
  - **Type** `SignalCounts`: `{ bookImbalance: number; priceImpact: number; sentimentVelocity: number; negRisk: number }`
  - **Behaviour**:
    - **BOOK_IMBALANCE**: iterate `booksMap`; compute bid/askDepth; if ratio > 3.0 or < 1/3.0, build `ImbalanceSignal` and call `insertSignal(db, signal, null)` — reuse signal shape from `WsBookImbalanceEvaluator` evaluate logic (inline, do NOT instantiate WsBookImbalanceEvaluator — it requires bus)
    - **PRICE_IMPACT_ANOMALY**: for each trade in statsMap that has stats, use `WhaleDetector`'s `estimatePriceImpact`-style logic inline (compute `bookDepthConsumedPct`; if > `PRICE_IMPACT_ANOMALY_THRESHOLD`-sigma mark, insert signal); skip if no book
    - **SENTIMENT_VELOCITY**: for each token with >= 10 trades, compute price velocity (last price - first price) / first price over 24h window; if abs(velocity) >= `VELOCITY_PRICE_THRESHOLD`, insert signal
    - **NEG_RISK**: for each neg-risk token in booksMap, if book has non-trivial imbalance, insert `NEG_RISK_OUTLIER` signal
  - **Edge cases**: no book for token → skip BOOK_IMBALANCE and PRICE_IMPACT; no stats → skip PRICE_IMPACT; < 10 trades → skip SENTIMENT_VELOCITY
  - **Outcome**: returns counts; signals inserted into DB
  - **Test guidance**: mock one book with ratio > 3 → assert bookImbalance=1 and insertSignal called; mock no books → assert all zero

- [ ] **Task 2.12**: `buildAndInsertWalletProfiles(db, trades, whaleLookup): Promise<number>`
  - **File**: `src/seeder/seed-backfill.ts`
  - **Behaviour**: calls `buildWalletAggregates`; calls `upsertWalletProfile` per entry; returns wallet count
  - **Outcome**: wallet_profiles has one row per unique wallet from trades
  - **Test guidance**: 2 wallets, 1 whale → assert upsertWalletProfile called 2×

- [ ] **Task 2.13**: `main()` entry point with progress UX
  - **File**: `src/seeder/seed-backfill.ts`
  - **Behaviour**: sequential orchestration of tasks 2.1 → 2.12 with progress logging matching the spec UX (header banner, per-step emoji + status + counts); reads `SEED_TRADE_LIMIT` (default 10000) and `SEED_HOURS` (default 24) from env; calls `closeDb()` in finally block; exits with code 1 on any thrown error
  - **Outcome**: `pnpm seed` prints UX banner matching CR spec; exits 0 on success, 1 on failure
  - **Test guidance**: not unit-tested (I/O orchestration); covered by integration check `pnpm typecheck`

---

### Chunk 3 — Config additions

- [ ] **Task 3.1**: Add `SEED_TRADE_LIMIT` and `SEED_HOURS` to `.env.example`
  - **File**: `.env.example`
  - **Behaviour**: append under `# Seeder` section:
    ```
    # Seeder
    SEED_TRADE_LIMIT=10000
    SEED_HOURS=24
    ```
  - **Note**: these vars are read directly via `process.env` in `seed-backfill.ts` (not via `src/config.ts` — seeder-only, no need to pollute shared config)
  - **Outcome**: `.env.example` documents the vars
  - **Test guidance**: n/a

- [ ] **Task 3.2**: Add `"seed"` script to root `package.json`
  - **File**: `package.json`
  - **Value**: `"seed": "tsc && node dist/seeder/seed-backfill.js"`
  - **Outcome**: `pnpm seed` invokes the compiled seeder
  - **Test guidance**: `pnpm typecheck` passes (no TS errors in new files)

---

### Chunk 4 — Tests

- [ ] **Task 4.1**: `src/seeder/seed-utils.test.ts`
  - **Covers**: Tasks 1.1 → 1.4 (`parseClobTokenIds`, `buildTradeEventFromDataApi`, `computeMarketStats`, `buildWalletAggregates`)
  - **Pattern**: pure unit tests — no mocks needed; all functions are pure / sync or trivially testable
  - **Target**: 100% line coverage on `seed-utils.ts`

- [ ] **Task 4.2**: `src/seeder/seed-backfill.test.ts`
  - **Covers**: Tasks 2.1 → 2.12 (all exported helper functions)
  - **Pattern**: `vi.fn()` mocks for fetch and all DB query imports; each function exported separately from `seed-backfill.ts` for testability (`export { fetchMarkets, fetchTrades, … }`)
  - **Key mocks**:
    - `fetch` global replaced via `vi.stubGlobal('fetch', ...)`
    - DB query modules mocked via `vi.mock('../db/queries/markets.js', () => ({ upsertMarket: vi.fn(), … }))`
  - **Target**: >= 80% line coverage on `seed-backfill.ts` (main() is excluded)

---

## Exact Files to Change

| File | Action | Description |
|---|---|---|
| `src/seeder/seed-utils.ts` | **CREATE** | Pure helpers: parseClobTokenIds, buildTradeEventFromDataApi, computeMarketStats, buildWalletAggregates |
| `src/seeder/seed-backfill.ts` | **CREATE** | Main seeder: all fetch/insert logic + main() entry |
| `src/seeder/seed-utils.test.ts` | **CREATE** | Vitest tests for seed-utils |
| `src/seeder/seed-backfill.test.ts` | **CREATE** | Vitest tests for seed-backfill (mocked) |
| `package.json` | **MODIFY** | Add `"seed"` script |
| `.env.example` | **MODIFY** | Add Seeder section with 2 vars |

---

## What Must NOT Change

- `src/db/schema.ts` — frozen
- `drizzle/` directory (any file) — frozen
- `src/config.ts` — no new fields (seeder reads env directly)
- `src/pipeline.ts` — frozen
- `src/index.ts` — frozen
- All existing `*.test.ts` files — frozen (zero regressions)
- `apps/dashboard/` — frozen
- `vitest.config.ts` — frozen (new tests under `src/**/*.test.ts` are auto-included)
- `tsconfig.json` — frozen (`rootDir: src` satisfied by `src/seeder/` location)

---

## Execution Order

1. Task 1.1–1.4 (`seed-utils.ts` — no deps)
2. Task 4.1 (`seed-utils.test.ts` — depends on 1.1–1.4)
3. Task 3.1 (`.env.example` — no deps)
4. Task 3.2 (`package.json` — no deps)
5. Task 2.1–2.5 (`seed-backfill.ts` fetch helpers — depend on seed-utils)
6. Task 2.6–2.12 (`seed-backfill.ts` insert/compute — depend on 2.1–2.5)
7. Task 2.13 (`main()` — depends on all 2.x)
8. Task 4.2 (`seed-backfill.test.ts` — depends on 2.x)
9. Verify: `pnpm typecheck`, `pnpm test` (637 + new tests must pass)

---

## TODO

- [ ] Task 1.1: `parseClobTokenIds` — `src/seeder/seed-utils.ts`
- [ ] Task 1.2: `buildTradeEventFromDataApi` — `src/seeder/seed-utils.ts`
- [ ] Task 1.3: `computeMarketStats` — `src/seeder/seed-utils.ts`
- [ ] Task 1.4: `buildWalletAggregates` — `src/seeder/seed-utils.ts`
- [ ] Task 2.1: `checkDbConnection` — `src/seeder/seed-backfill.ts`
- [ ] Task 2.2: `fetchMarkets` — `src/seeder/seed-backfill.ts`
- [ ] Task 2.3: `fetchClobEnrichment` — `src/seeder/seed-backfill.ts`
- [ ] Task 2.4: `fetchTrades` — `src/seeder/seed-backfill.ts`
- [ ] Task 2.5: `fetchOrderBooks` — `src/seeder/seed-backfill.ts`
- [ ] Task 2.6: `insertMarkets` — `src/seeder/seed-backfill.ts`
- [ ] Task 2.7: `insertTrades` — `src/seeder/seed-backfill.ts`
- [ ] Task 2.8: `bootstrapPriceHistory` — `src/seeder/seed-backfill.ts`
- [ ] Task 2.9: `recomputeMarketStats` — `src/seeder/seed-backfill.ts`
- [ ] Task 2.10: `runWhaleDetection` — `src/seeder/seed-backfill.ts`
- [ ] Task 2.11: `runSignalDetection` — `src/seeder/seed-backfill.ts`
- [ ] Task 2.12: `buildAndInsertWalletProfiles` — `src/seeder/seed-backfill.ts`
- [ ] Task 2.13: `main()` orchestration — `src/seeder/seed-backfill.ts`
- [ ] Task 3.1: `.env.example` Seeder section
- [ ] Task 3.2: `package.json` `"seed"` script
- [ ] Task 4.1: `src/seeder/seed-utils.test.ts`
- [ ] Task 4.2: `src/seeder/seed-backfill.test.ts`
