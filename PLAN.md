# Plan: Phase 3 — Signal Intelligence & Backtesting

> **Board-reviewed** — Robin's research brief for the full Phase 3 build.
> Zoro implements. Usopp tests. Law approves architecture decisions.

## Goal
Deliver two new signal evaluators (`PriceImpactSignal` v2, `SentimentVelocitySignal` v2 — fully replacing the Phase 1 stubs), composite confidence scoring in `SignalAggregator`, a four-file backtesting module (`src/backtest/`), pipeline wiring for all new components, and ≥ 95% test coverage across all new code, with all existing 357 tests continuing to pass.

## Branch
`feat/phase-3` (created from `main` at 58ed40d)

---

## Project Status
**EXISTING project — Phase 1 + Phase 2 complete.** 357 tests, 97.33% stmt / 95.91% branch.

---

## Codebase State (as of Phase 2)

### What is LOCKED — must not change
- `src/db/schema.ts` — complete, frozen
- `drizzle/` — migration files and journal, frozen
- All Phase 1 and Phase 2 source files **not listed** in the allowed edit surface below

### Allowed edit surface (Phase 3 may touch these files)

| File | Permitted change |
|---|---|
| `src/signals/price-impact-signal.ts` | Full rewrite — replace Phase 1 stub with Phase 3 algorithm |
| `src/signals/velocity-signal.ts` | Full rewrite — replace Phase 1 stub with Phase 3 algorithm |
| `src/processors/signal-aggregator.ts` | Add composite confidence scoring (in-memory map + enriched payload) |
| `src/pipeline.ts` | Wire PriceImpactSignal v2 + SentimentVelocitySignal v2 |
| `src/config.ts` | Add 7 Phase 3 env vars |
| `.env.example` | Add Phase 3 env vars |
| `package.json` | Add `backtest` script |

### What is NEW (create from scratch)
- `src/backtest/types.ts`
- `src/backtest/runner.ts`
- `src/backtest/evaluator.ts`
- `src/backtest/report.ts`
- `src/signals/price-impact-signal.test.ts` — **replace** existing tests (spec algorithm change)
- `src/signals/velocity-signal.test.ts` — **replace** existing tests (spec algorithm change)
- `src/processors/signal-aggregator.test.ts` — extend (composite scoring additions only)
- `src/backtest/runner.test.ts`
- `src/backtest/evaluator.test.ts`
- `src/backtest/report.test.ts`

---

## Critical Architecture Decisions

### Decision 1: Signal algorithm replacement, not incremental change

The Phase 1 stubs (`evaluatePriceImpact`, `evaluateVelocity`) have **different algorithms** from the Phase 3 spec:

| Property | Phase 1 stub | Phase 3 spec |
|---|---|---|
| `evaluatePriceImpact` trigger | Price % change window | `actualImpact / expectedImpact > threshold` (anomaly score) |
| `evaluatePriceImpact` inputs | `priceHistory[]` + `liquidityUsdc` | `TradeEvent` + `order_book_snapshots` + `price_history` (DB) |
| `evaluateVelocity` trigger | Z-score on 5-min buckets | `\|priceVelocity\| > threshold AND tradeCountVelocity > multiplier` |
| `evaluateVelocity` architecture | Pure function, called every 5min | Class with in-memory rolling buffer per token, event-driven |

**Resolution:** Both files are completely replaced. The existing function signatures `evaluatePriceImpact()` and `evaluateVelocity()` are abandoned. New exports are **classes**: `PriceImpactSignalEvaluator` and `SentimentVelocityEvaluator`. The old tests are entirely replaced. `pipeline.ts` call sites are updated.

### Decision 2: `PriceImpactSignalEvaluator` requires DB access (async)

The spec requires fetching `order_book_snapshots` (max age 60s) and `price_history` (last 2 records) from the DB. This is an **async, DB-read operation** on the hot trade path.

**Resolution:**
- `PriceImpactSignalEvaluator` is a class injected with `db`
- `evaluate(trade: TradeEvent): Promise<PriceImpactSignal | null>` — called on `trade` events
- DB reads: `getLatestBook(db, tokenId)` for snapshot, `getRecentPriceHistory(db, tokenId, limit=2)` for price history
- Stale snapshot guard: `if (Date.now() - snapshot.capturedAt.getTime() > 60_000)` → skip + warn
- Insufficient history guard: `if (priceHistory.length < 2)` → skip (no warn needed, expected at startup)
- Requires a new query function: `getRecentPriceHistory(db, tokenId, limit)` in `src/db/queries/signals.ts` or a new file

**New query needed:** `src/db/queries/price-history.ts` — `getRecentPriceHistory(db, tokenId, limit)` using `price_history` table ordered by `recorded_at DESC LIMIT limit`.

### Decision 3: `SentimentVelocityEvaluator` is a stateful class with in-memory rolling buffer

The spec states: "In-memory rolling buffer per token — no DB reads on hot path." This means it is **not a pure function** like the Phase 1 stub.

**Resolution:**
- `SentimentVelocityEvaluator` is a class with `private priceBuffer: Map<TokenId, PriceRecord[]>` and `private tradeBuffer: Map<TokenId, TradeRecord[]>`
- `recordPrice(tokenId, price, timestamp)` — called from `price_change` and `last_trade_price` events
- `recordTrade(tokenId, timestamp)` — called from `trade` events
- `evaluate(tokenId): SentimentVelocitySignal | null` — called when needed (on `trade` event or on a timer)
- Rolling window: only records within `VELOCITY_WINDOW_SECONDS` (default 300s) are kept
- Prior window: same-length window immediately preceding the current window for trade count comparison
- Bootstrap on startup: query `price_history` table to pre-populate buffers (separate `bootstrap(tokenIds)` method)

### Decision 4: Pipeline wiring replaces old call sites

The old pipeline wired `evaluatePriceImpact` inside the `SnapshotWriter` callback (REST timer path) and `evaluateVelocity` inside a 5-min `setInterval`. Both are removed and replaced:

| Old wiring | New wiring |
|---|---|
| `evaluatePriceImpact()` called in `SnapshotWriter` callback | `priceImpactEvaluator.evaluate(trade)` called in `tradeHandler1` (or separate handler) — async |
| `evaluateVelocity()` called in 5-min `setInterval` | `velocityEvaluator.evaluate(tokenId)` called in `tradeHandler1` (after `recordTrade`) |

Both new evaluators write signals to the bus: `bus.emit("signal", signal)`. `SignalAggregator` handles persistence.

### Decision 5: Composite scoring is purely in-memory, no new signal type

The spec explicitly states: "Do NOT create a new signal type for composite — per PRD §10 deferral note, just enrich the payload."

**Resolution:**
- `SignalAggregator` maintains `private compositeMap: Map<TokenId, { signals: Array<{type: SignalType, confidence: number, createdAt: Date}>, windowStart: number }>`
- On each `handleSignal()` call (before DB insert), check for co-occurring signals within `COMPOSITE_WINDOW_MS`
- If 2+ co-occurring: compute `compositeConfidence = mean(confidences) * (1 + 0.15 * (count - 1))`, add `compositeScore` to `signal.payload`
- Log: `[COMPOSITE] tokenId: <score>, signals: [<types>]`
- Purge stale entries: remove entries where `windowStart < Date.now() - COMPOSITE_WINDOW_MS`
- Window starts from the **first** signal of a group for that tokenId

### Decision 6: Backtest module is standalone, no pipeline dependency

`BacktestRunner` is a CLI entry point that creates its own `db` connection. It does **not** import or instantiate `startPipeline()`.

**Resolution:**
- `src/backtest/runner.ts` has a `main()` function that: (1) parses CLI args, (2) creates DB client via `createDb()` from `src/db/client.ts`, (3) queries `signals` + `markets` tables, (4) calls `BacktestEvaluator`, (5) calls `BacktestReport`, (6) closes DB
- `pnpm backtest` script invokes `runner.ts` directly
- No mocked DB in runner.ts — test with a mock DB injected via parameter

### Decision 7: `getRecentPriceHistory` query placement

Rather than adding to the already-complex `signals.ts` query file, add to `src/db/queries/snapshots.ts` (already handles snapshot reads) — or create a dedicated `src/db/queries/price-history.ts`. **Decision: new file `src/db/queries/price-history.ts`** to keep responsibilities clean.

---

## Signal Algorithm Reference

### PriceImpactSignalEvaluator

**Inputs per trade:**
- `TradeEvent`: `{ tokenId, side, valueUsdc, priceUsdc }`
- DB: latest `order_book_snapshots` row for `tokenId` (max age 60s)
- DB: 2 most recent `price_history` rows for `tokenId` (ordered by `recorded_at DESC`)

**Algorithm:**
```
// 1. Fetch snapshot (max 60s old)
snapshot = getLatestBook(db, tokenId)
if (!snapshot || Date.now() - snapshot.capturedAt > 60_000) → skip + warn

// 2. Fetch price history (need at least 2)
history = getRecentPriceHistory(db, tokenId, 2)
if (history.length < 2) → skip silently

// 3. Expected impact
depthUsdc = side=BUY ? snapshot.bidDepthUsdc : snapshot.askDepthUsdc
if (depthUsdc === 0) → skip (division guard)
expectedImpact = trade.valueUsdc / depthUsdc

// 4. Actual impact
priceBeforeTrade = history[1].price  (older of the two)
priceNow = history[0].price           (newer of the two)
actualImpact = abs(priceNow - priceBeforeTrade) / priceBeforeTrade

// 5. Anomaly score
score = actualImpact / expectedImpact
if (score <= PRICE_IMPACT_ANOMALY_THRESHOLD) → no signal

// 6. Cooldown per token
if (Date.now() - lastEmit[tokenId] < PRICE_IMPACT_COOLDOWN_MS) → skip

// 7. Direction
direction = side=BUY ? BULL : BEAR

// 8. Confidence
confidence = min(1.0, (score - threshold) / threshold)
```

**Note on direction mapping:** The spec says `BUY → BULL`, `SELL → BEAR`. But the existing `SignalDirection` type uses `"BULLISH"` / `"BEARISH"` / `"NEUTRAL"`. Use `"BULLISH"` and `"BEARISH"` — the spec shorthand is informal.

**Note on `order_book_snapshots` query:** The `getLatestBook()` function in `snapshots.ts` already does `ORDER BY captured_at DESC LIMIT 1`. We re-use it.

**Note on `price_history` table schema:** `price_history` has columns `token_id`, `price`, `recorded_at`. The query returns rows ordered by `recorded_at DESC`.

### SentimentVelocityEvaluator

**State per token:**
```
priceBuffer: Array<{ price, timestamp }>  // records within [now - VELOCITY_WINDOW_SECONDS*2, now]
tradeBuffer: Array<{ timestamp }>          // same window range (doubled for prior window)
lastEmit: Map<tokenId, timestamp>          // cooldown
```

**Algorithm on `evaluate(tokenId)`:**
```
now = Date.now()
windowMs = VELOCITY_WINDOW_SECONDS * 1000

// Current window: [now - windowMs, now]
currentPrices = priceBuffer.filter(p => p.timestamp >= now - windowMs)
if (currentPrices.length < 2) → null

latestPrice = currentPrices[last].price
windowStartPrice = currentPrices[first].price
if (windowStartPrice === 0) → null

// Price velocity: % per minute
priceVelocity = (latestPrice - windowStartPrice) / windowStartPrice / VELOCITY_WINDOW_SECONDS * 60

if (|priceVelocity| <= VELOCITY_PRICE_THRESHOLD) → null

// Trade count velocity
currentTrades = tradeBuffer.filter(t => t.timestamp >= now - windowMs)
priorTrades = tradeBuffer.filter(t => t.timestamp >= now - 2*windowMs AND t.timestamp < now - windowMs)
currentTradeRate = currentTrades.length
priorTradeRate = priorTrades.length (if 0, treat as 1 to avoid div/0)
tradeCountVelocity = currentTradeRate / max(priorTradeRate, 1)

if (tradeCountVelocity <= VELOCITY_TRADE_COUNT_MULTIPLIER) → null

// Cooldown
if (Date.now() - lastEmit[tokenId] < VELOCITY_COOLDOWN_MS) → null

// Direction
direction = priceVelocity > 0 ? "BULLISH" : "BEARISH"

// Confidence
confidence = min(1.0, |priceVelocity| / (VELOCITY_PRICE_THRESHOLD * 3))

// Signal
return VelocitySignal { signalType: "SENTIMENT_VELOCITY", ... strength: tradeCountVelocity }
```

**Buffer management:** On each `recordPrice()` / `recordTrade()`, prune entries older than `2 * VELOCITY_WINDOW_SECONDS * 1000` (double window needed for prior-window comparison).

---

## Out of Scope
- Neg-risk signal generation (Phase 4)
- New DB schema changes or migrations
- Any other Phase 1 / Phase 2 source files not listed in the edit surface
- Deployment configuration changes
- Backtesting UI

---

## Tasks

### Chunk 1: Config + New Query Layer

- [x] **Task 1.1: Extend `src/config.ts`**
  - Files: `src/config.ts`
  - Add 7 new fields (all use `envNumber()`):
    ```typescript
    priceImpactAnomalyThreshold: envNumber("PRICE_IMPACT_ANOMALY_THRESHOLD", 2.5),
    priceImpactCooldownMs: envNumber("PRICE_IMPACT_COOLDOWN_MS", 30_000),
    velocityWindowSeconds: envNumber("VELOCITY_WINDOW_SECONDS", 300),
    velocityPriceThreshold: envNumber("VELOCITY_PRICE_THRESHOLD", 0.005),
    velocityTradeCountMultiplier: envNumber("VELOCITY_TRADE_COUNT_MULTIPLIER", 1.5),
    velocityCooldownMs: envNumber("VELOCITY_COOLDOWN_MS", 120_000),
    compositeWindowMs: envNumber("COMPOSITE_WINDOW_MS", 60_000),
    ```
  - **Also add** to `PipelineConfig` interface in `src/events/types.ts` — but wait: `PipelineConfig` is in `types.ts` which is not in the edit surface. Check: these new fields don't need to be in `PipelineConfig` because the new evaluators read directly from `config` (not from the `PipelineConfig` interface injected into pipeline). **Resolution: do NOT add to `PipelineConfig` unless needed for pipeline unit tests.** The evaluators use `config` directly.
  - Input: existing config shape
  - Output: 7 new fields on frozen config object
  - Test guidance: `src/config.test.ts` — add assertions for each new env var default and override
  - Edge cases: `envNumber()` throws on NaN — don't set invalid defaults

- [x] **Task 1.2: Update `.env.example`**
  - Files: `.env.example`
  - Add Phase 3 section with all 7 vars and defaults
  - No test needed

- [x] **Task 1.3: Create `src/db/queries/price-history.ts`**
  - Files: `src/db/queries/price-history.ts` (new)
  - Export: `getRecentPriceHistory(db: Db, tokenId: TokenId, limit: number): Promise<Array<{ price: number; recordedAt: Date }>>`
  - Query: `SELECT price, recorded_at FROM price_history WHERE token_id = $1 ORDER BY recorded_at DESC LIMIT $2`
  - Use `sql` template or drizzle select — look at how `snapshots.ts` uses `db.select()` as the pattern
  - Input: `db`, `tokenId`, `limit`
  - Output: array of `{ price: number, recordedAt: Date }` newest-first
  - Test guidance: `src/db/queries/price-history.test.ts` — mock `db.select()` chain, assert row mapping (numeric → number), empty result returns `[]`
  - Edge cases: `price` column is `numeric` (string in JS) — must `Number(row.price)`

---

### Chunk 2: PriceImpactSignalEvaluator

- [x] **Task 2.1: Rewrite `src/signals/price-impact-signal.ts`**
  - Files: `src/signals/price-impact-signal.ts`
  - Remove all Phase 1 code. Export `PriceImpactSignalEvaluator` class.
  - Class interface:
    ```typescript
    export class PriceImpactSignalEvaluator {
      constructor(private readonly db: Db, private readonly opts?: PriceImpactOptions) {}
      async evaluate(trade: TradeEvent): Promise<PriceImpactSignal | null>
    }
    export interface PriceImpactOptions {
      anomalyThreshold?: number;   // default config.priceImpactAnomalyThreshold
      cooldownMs?: number;         // default config.priceImpactCooldownMs
    }
    ```
  - Internal state: `private lastEmit: Map<TokenId, number>` for cooldown
  - DB reads: `getLatestBook(db, tokenId)` + `getRecentPriceHistory(db, tokenId, 2)`
  - Full algorithm per Decision 2 above
  - Signal fields: `signalType: "PRICE_IMPACT_ANOMALY"`, `direction` (`BULLISH`/`BEARISH`), `confidence`, `strength: score`, `priceAtSignal: priceNow`, `payload: { score, expectedImpact, actualImpact, depthUsdc, snapshotAgeMs }`
  - Existing interface `PriceImpactSignal` in `events/types.ts` stays unchanged — the existing fields (`priceChangePct`, `windowSeconds`, `triggeringTradeValueUsdc`) must still be populated:
    - `priceChangePct = actualImpact * 100`
    - `windowSeconds = 0` (not window-based anymore — set to 0 or snapshot age in seconds)
    - `triggeringTradeValueUsdc = trade.valueUsdc`
  - Input/Output: `TradeEvent → Promise<PriceImpactSignal | null>`
  - Test guidance: `price-impact-signal.test.ts` — mock `getLatestBook` + `getRecentPriceHistory`, test all skip conditions, test score math, test cooldown, test confidence formula
  - Edge cases: `depthUsdc === 0`, stale snapshot (>60s), fewer than 2 price records, division by zero in actualImpact (priceBeforeTrade=0)

- [x] **Task 2.2: Replace `src/signals/price-impact-signal.test.ts`**
  - Files: `src/signals/price-impact-signal.test.ts`
  - Replace entirely — old tests test the Phase 1 stub algorithm
  - Required test cases (from spec):
    1. Anomaly fires when score > threshold
    2. Skipped when snapshot age > 60s (log warn, no signal)
    3. Skipped when `getRecentPriceHistory` returns < 2 records
    4. Cooldown suppression (second call within cooldown window returns null)
    5. Confidence scaling: `confidence = min(1.0, (score-threshold)/threshold)`, clamped at 1.0
    6. Direction: BUY → BULLISH, SELL → BEARISH
    7. Score below threshold → no signal
    8. Depth = 0 → skip (division guard)
    9. No snapshot found → skip
    10. `opts` defaults used when not provided
  - Mock pattern: `vi.mock("../db/queries/price-history.js", ...)` and `vi.mock("../db/queries/snapshots.js", ...)`
  - Use `vi.fn()` for DB mock; pass `db` as `{} as Db` (queries are mocked at module level)

---

### Chunk 3: SentimentVelocityEvaluator

- [x] **Task 3.1: Rewrite `src/signals/velocity-signal.ts`**
  - Files: `src/signals/velocity-signal.ts`
  - Remove all Phase 1 code. Export `SentimentVelocityEvaluator` class.
  - Class interface:
    ```typescript
    export class SentimentVelocityEvaluator {
      constructor(private readonly opts?: VelocityOptions) {}
      recordPrice(tokenId: TokenId, price: number, timestamp?: number): void
      recordTrade(tokenId: TokenId, timestamp?: number): void
      evaluate(tokenId: TokenId, conditionId: string): VelocitySignal | null
      async bootstrap(db: Db, tokenIds: TokenId[]): Promise<void>
    }
    export interface VelocityOptions {
      windowSeconds?: number;              // default config.velocityWindowSeconds
      priceThreshold?: number;             // default config.velocityPriceThreshold
      tradeCountMultiplier?: number;       // default config.velocityTradeCountMultiplier
      cooldownMs?: number;                 // default config.velocityCooldownMs
    }
    ```
  - Internal state:
    - `private priceBuffers: Map<TokenId, Array<{ price: number; timestamp: number }>>`
    - `private tradeBuffers: Map<TokenId, Array<{ timestamp: number }>>`
    - `private lastEmit: Map<TokenId, number>`
  - `recordPrice`: push `{ price, timestamp: timestamp ?? Date.now() }`, prune entries older than `2 * windowSeconds * 1000`
  - `recordTrade`: push `{ timestamp: timestamp ?? Date.now() }`, prune same
  - `evaluate`: full algorithm per Decision 3 above — returns `VelocitySignal | null`
  - `bootstrap(db, tokenIds)`: for each tokenId, query `getRecentPriceHistory(db, tokenId, 200)` (last 200 price records) and call `recordPrice()` for each; does NOT pre-populate tradeBuffers (trades only come from live events)
  - `VelocitySignal` existing fields must be populated:
    - `velocityZScore: tradeCountVelocity` (reuse for strength, not a z-score anymore — note: the type field is named `velocityZScore` but Phase 3 algorithm doesn't compute z-scores; set it to `tradeCountVelocity`)
    - `hourlyPriceChangePct: priceVelocity * 60` (velocity is per-minute, * 60 = per hour)
    - `baselineStdDev: 0` (not computed in Phase 3 algorithm — set to 0)
  - Input/Output: in-memory state + event-driven
  - Test guidance: `velocity-signal.test.ts`
  - Edge cases: empty buffers, single price point, tradeCountVelocity edge case (0 prior trades → divisor = 1)

- [x] **Task 3.2: Replace `src/signals/velocity-signal.test.ts`**
  - Files: `src/signals/velocity-signal.test.ts`
  - Replace entirely — old tests test Phase 1 z-score algorithm
  - Required test cases (from spec):
    1. Fires when both `|priceVelocity| > threshold` AND `tradeCountVelocity > multiplier`
    2. No fire when only price threshold met (trade count insufficient)
    3. No fire when only trade count threshold met (price velocity insufficient)
    4. Cooldown: second `evaluate()` call for same token within cooldown → null
    5. Direction: positive velocity → BULLISH, negative → BEARISH
    6. Rolling window correctly excludes records older than `windowSeconds`
    7. Prior window correctly uses `[now-2w, now-w)` range for trade count comparison
    8. `recordPrice()` / `recordTrade()` prune buffer at `2 * windowSeconds`
    9. `evaluate()` returns null when fewer than 2 prices in current window
    10. `bootstrap()` pre-populates price buffer from DB records
  - All tests use `vi.useFakeTimers()` for deterministic timestamp control

---

### Chunk 4: SignalAggregator — Composite Scoring

- [x] **Task 4.1: Update `src/processors/signal-aggregator.ts`**
  - Files: `src/processors/signal-aggregator.ts`
  - Add private `compositeMap: Map<TokenId, { signals: Array<{ type: SignalType; confidence: number; createdAt: number }>; windowStart: number }>`
  - Update `handleSignal()` to:
    1. Before inserting to DB, call `updateCompositeMap(signal)` which:
       - Purges entries older than `compositeWindowMs` for all tokens
       - Adds current signal to the token's list
       - If 2+ signals in the window: computes `compositeConfidence` and logs
    2. If composite window has 2+ signals for this token, add `compositeScore` to `signal.payload` before insert
  - New private method `updateCompositeMap(signal: Signal): number | null` — returns composite score or null if only 1 signal
  - Formula: `compositeConfidence = mean(confidences) * (1 + 0.15 * (signalCount - 1))`
  - Log format: `[COMPOSITE] tokenId: <score>, signals: [<types>]`
  - Config: use `config.compositeWindowMs`
  - **Preserve all existing behavior** — new code only added to `handleSignal()`
  - Input/Output: `Signal` → enriched `payload` field before DB insert
  - Test guidance: `signal-aggregator.test.ts` additions (do NOT replace existing tests)
  - Edge cases: window boundary (signal at exactly `compositeWindowMs` — include or exclude; spec says "within", so exclude expired), single signal (no composite), payload immutability (spread signal before enriching to avoid mutation)

- [x] **Task 4.2: Extend `src/processors/signal-aggregator.test.ts`**
  - Files: `src/processors/signal-aggregator.test.ts`
  - **Add** new describe block: `"SignalAggregator — composite confidence scoring"`
  - Do NOT modify existing tests
  - Required test cases (from spec):
    1. 2 co-occurring signals → `compositeScore` added to both payloads, correct formula
    2. 3 signals → 1.30× bonus applied (`1 + 0.15 * 2 = 1.30`)
    3. Payload enriched: `signal.payload.compositeScore` present after insert
    4. Single signal → no composite (no `compositeScore` in payload)
    5. Window expiry: signal outside `compositeWindowMs` → not included in composite
    6. Different tokenIds: composite only for matching tokenId, not cross-token

---

### Chunk 5: Backtest Module

- [x] **Task 5.1: Create `src/backtest/types.ts`**
  - Files: `src/backtest/types.ts` (new)
  - Export interfaces:
    ```typescript
    export interface BacktestConfig {
      startDate: Date;
      endDate: Date;
      signalTypes?: SignalType[];
      minConfidence?: number;
      tokenIds?: string[];
    }
    
    export interface SignalOutcome {
      signalId: number;
      tokenId: string;
      signalType: SignalType;
      direction: string;
      confidence: number;
      createdAt: Date;
      resolved: boolean;       // market resolved in time range
      correct: boolean | null; // null if not resolved
    }
    
    export interface SignalMetrics {
      precision: number;       // correct / total fired (for resolved)
      recall: number;          // correct / total resolvable
      f1: number;
      avgConfidence: number;
      totalFired: number;
      totalResolved: number;
      totalCorrect: number;
    }
    
    export interface BacktestResult {
      config: BacktestConfig;
      byType: Partial<Record<SignalType, SignalMetrics>>;
      overall: SignalMetrics;
      generatedAt: Date;
    }
    ```
  - No test needed (type-only file)

- [x] **Task 5.2: Create `src/backtest/evaluator.ts`**
  - Files: `src/backtest/evaluator.ts` (new)
  - Export `BacktestEvaluator` class:
    ```typescript
    export class BacktestEvaluator {
      evaluate(outcomes: SignalOutcome[]): BacktestResult["byType"] & { overall: SignalMetrics }
    }
    ```
  - `evaluate()` groups outcomes by `signalType`, computes `SignalMetrics` for each group + overall
  - Precision = `totalCorrect / totalResolved` (or 0 if `totalResolved === 0`)
  - Recall = `totalCorrect / totalResolved` (same as precision here — recall requires knowing total positives; clarification: per spec, `recall = correct / total resolvable` where "total resolvable" = `totalResolved`. So precision ≡ recall in this formulation. Implement as-is per spec.)
  - F1 = `2 * precision * recall / (precision + recall)` (or 0 if both are 0)
  - avgConfidence = mean of all signal confidences in the group
  - Input: `SignalOutcome[]`
  - Output: `{ byType: ..., overall: ... }`
  - Test guidance: `backtest/evaluator.test.ts` — precision/recall/f1 math, zero-division (no resolved markets → all zeros), per-type breakdown, overall aggregation

- [x] **Task 5.3: Create `src/backtest/report.ts`**
  - Files: `src/backtest/report.ts` (new)
  - Export `BacktestReport` class:
    ```typescript
    export class BacktestReport {
      print(result: BacktestResult): void  // stdout table
      async save(result: BacktestResult, outputDir?: string): Promise<string>  // returns path written
    }
    ```
  - `print()`: renders the box-drawing table to `process.stdout` (use `console.log`)
  - `save()`: writes JSON to `backtest-results/{startDate}_{endDate}.json`
    - Date format in filename: `YYYY-MM-DD` (e.g., `2025-01-01_2025-04-01.json`)
    - Creates `backtest-results/` directory if not present (use `fs.mkdirSync` with `recursive: true`)
  - Table format: exact box-drawing chars from spec
  - Column widths: fixed at the widths shown in the spec
  - Test guidance: `backtest/report.test.ts`
    - JSON output shape matches `BacktestResult`
    - stdout output contains expected signal type names and numeric values
    - `save()` writes to correct path
    - Mock `fs.writeFileSync` and `fs.mkdirSync` in tests

- [x] **Task 5.4: Create `src/backtest/runner.ts`**
  - Files: `src/backtest/runner.ts` (new)
  - Export `BacktestRunner` class + `main()` function:
    ```typescript
    export class BacktestRunner {
      constructor(private readonly db: Db) {}
      async run(config: BacktestConfig): Promise<BacktestResult>
    }
    
    // CLI entry (called when file run directly)
    async function main(): Promise<void>
    ```
  - `run()`:
    1. Query `signals` table: `WHERE created_at BETWEEN config.startDate AND config.endDate [AND signal_type IN (...)] [AND confidence >= minConfidence] [AND token_id IN (...)]`
    2. For each signal, join to `markets` table: get `winner` field for the `tokenId`
    3. Determine correctness:
       - Signal direction `BULLISH` = predicted `winner = true` (Yes outcome wins)
       - Signal direction `BEARISH` = predicted `winner = false`
       - If `markets.winner IS NULL` → not resolved (resolved=false, correct=null)
       - If resolved: correct = `(direction=BULLISH && winner=true) || (direction=BEARISH && winner=false)`
    4. Build `SignalOutcome[]`, call `BacktestEvaluator.evaluate()`, call `BacktestReport.print()` + `.save()`
  - `main()`: parse `process.argv` for `--start`, `--end`, `--signal-types`, `--min-confidence`; create DB; run; close DB
  - Test guidance: `backtest/runner.test.ts` — mock DB (mock `execute()` or use drizzle mock), assert correct signal fetch query shape, assert `BacktestEvaluator.evaluate` called with correct outcomes, assert `BacktestReport.print` called

---

### Chunk 6: Pipeline Wiring

- [x] **Task 6.1: Update `src/pipeline.ts`**
  - Files: `src/pipeline.ts`
  - Changes:
    1. **Remove** old imports: `evaluatePriceImpact` from `price-impact-signal.js`, `evaluateVelocity` from `velocity-signal.js`
    2. **Add** new imports: `PriceImpactSignalEvaluator` from `price-impact-signal.js`, `SentimentVelocityEvaluator` from `velocity-signal.js`, `getRecentPriceHistory` from `db/queries/price-history.js`
    3. **Remove** `recentPrices` Map, `recordPrice()`, `priceBuckets` Map, `recordBucketPrice()` (replaced by evaluator-internal state)
    4. **Remove** the `SnapshotWriter` callback block that called `evaluatePriceImpact()`
    5. **Remove** the 5-min `setInterval` block that called `evaluateVelocity()`
    6. **Instantiate**: `const priceImpactEvaluator = new PriceImpactSignalEvaluator(db)` and `const velocityEvaluator = new SentimentVelocityEvaluator()`
    7. **Bootstrap** velocity evaluator on startup: `await velocityEvaluator.bootstrap(db, watchlistedTokenIds)` (after `getWatchlistedTokenIds`)
    8. **Wire trade handler**: In `tradeHandler1`, after existing logic, add:
       ```typescript
       velocityEvaluator.recordPrice(trade.tokenId, trade.priceUsdc);
       velocityEvaluator.recordTrade(trade.tokenId);
       const velSignal = velocityEvaluator.evaluate(trade.tokenId, conditionIdMap.get(trade.tokenId) ?? trade.tokenId);
       if (velSignal) bus.emit("signal", velSignal);
       const impactSignal = await priceImpactEvaluator.evaluate(trade);
       if (impactSignal) bus.emit("signal", impactSignal);
       ```
    9. **Wire book_update handler**: Also call `velocityEvaluator.recordPrice()` from `best_bid_ask` and `last_trade_price` CLOB WS events (mid-price from bid/ask, last trade price)
    10. **Shutdown**: add `velocityEvaluator` and `priceImpactEvaluator` cleanup (if they have any timers — they don't, so no action needed)
  - **CRITICAL**: `conditionIdMap` must be populated before `velocityEvaluator.evaluate()` is called. The existing code populates it lazily (on first `getMarketStats()` call). For the evaluate call, fall back to `tokenId` as `conditionId` when not yet populated (same as existing pattern).
  - Test guidance: Pipeline is integration-tested via the existing `tests/` directory — no new pipeline unit tests needed. Verify pipeline test file if it exists.
  - Edge cases: `PriceImpactSignalEvaluator.evaluate()` is async — must `await` in trade handler, handler must remain `async`

---

### Chunk 7: Package.json + `backtest-results/` directory

- [x] **Task 7.1: Add `backtest` script to `package.json`**
  - Files: `package.json`
  - Add: `"backtest": "node --import tsx/esm src/backtest/runner.ts"`
  - No test needed

- [x] **Task 7.2: Create `backtest-results/.gitkeep`**
  - Files: `backtest-results/.gitkeep` (new empty file)
  - Add `backtest-results/*.json` to `.gitignore` (keep the directory, ignore output files)
  - No test needed

---

### Chunk 8: Testing

- [x] **Task 8.1: `src/db/queries/price-history.test.ts`** (new)
  - Test: correct SQL query shape, row mapping, empty result
  - Mock: `db.select().from().where().orderBy().limit()` chain

- [x] **Task 8.2: `src/signals/price-impact-signal.test.ts`** (replace)
  - See Task 2.2

- [x] **Task 8.3: `src/signals/velocity-signal.test.ts`** (replace)
  - See Task 3.2

- [x] **Task 8.4: `src/processors/signal-aggregator.test.ts`** (extend)
  - See Task 4.2

- [x] **Task 8.5: `src/backtest/evaluator.test.ts`** (new)
  - Test precision/recall/f1 math with known inputs
  - Zero-division: `totalResolved = 0` → all zeros, no NaN
  - Per-type breakdown and overall aggregation
  - Multiple signal types mixed

- [x] **Task 8.6: `src/backtest/report.test.ts`** (new)
  - Mock `fs.mkdirSync`, `fs.writeFileSync`
  - Assert JSON structure matches `BacktestResult`
  - Assert stdout contains expected signal type names
  - Assert filename format `YYYY-MM-DD_YYYY-MM-DD.json`

- [x] **Task 8.7: `src/backtest/runner.test.ts`** (new)
  - Mock DB with `vi.fn()` for `execute` calls
  - Assert signal query includes date range filter
  - Assert `BacktestEvaluator.evaluate()` called with correct `SignalOutcome[]`
  - Assert resolved/unresolved market mapping correct
  - Test `--start`, `--end` CLI arg parsing in `main()`

- [x] **Task 8.8: `src/config.test.ts` additions**
  - Add assertions for 7 new Phase 3 env vars (default values + override)

---

### Chunk 9: Docs + Commit Strategy

- [x] **Task 9.1: Update `CLAUDE.md`**
  - Add Phase 3 section to current state
  - Update test counts (target: 357 + new tests)
  - Add new env vars to environment variables table

- [x] **Task 9.2: Commit sequence on `feat/phase-3`**
  ```
  feat: add getRecentPriceHistory query + Phase 3 config
  feat: PriceImpactSignalEvaluator (DB-backed anomaly detection)
  feat: SentimentVelocityEvaluator (in-memory rolling window)
  feat: SignalAggregator composite confidence scoring
  feat: backtest module (runner, evaluator, report, types)
  feat: wire Phase 3 evaluators in pipeline.ts
  chore: update docs for Phase 3
  ```

- [x] **Task 9.3: Push + open PR to `main`**

---

## Execution Order

Dependencies must be respected:

1. **Task 1.1** (config) — no deps
2. **Task 1.2** (.env.example) — no deps
3. **Task 1.3** (price-history query) — no deps
4. **Task 5.1** (backtest/types.ts) — no deps
5. **Task 2.1** (PriceImpactSignalEvaluator) — depends on 1.1, 1.3
6. **Task 3.1** (SentimentVelocityEvaluator) — depends on 1.1, 1.3 (bootstrap uses price-history query)
7. **Task 4.1** (SignalAggregator composite) — depends on 1.1
8. **Task 5.2** (BacktestEvaluator) — depends on 5.1
9. **Task 5.3** (BacktestReport) — depends on 5.1, 5.2
10. **Task 5.4** (BacktestRunner) — depends on 5.1, 5.2, 5.3
11. **Task 6.1** (pipeline wiring) — depends on 2.1, 3.1
12. **Task 7.1** (package.json script) — depends on 5.4
13. **Task 7.2** (backtest-results dir) — no deps
14. **All tests** — depend on their respective implementation tasks

---

## Risks & Unknowns

### Risk 1: `PriceImpactSignal` type field mismatch
The existing `PriceImpactSignal` interface has `priceChangePct`, `windowSeconds`, `triggeringTradeValueUsdc`. The new algorithm doesn't naturally produce these. Resolution documented in Task 2.1 — set them to derived/dummy values to preserve the type contract without changing `events/types.ts`.

### Risk 2: Phase 1 price-impact and velocity tests break on algorithm change
The existing `price-impact-signal.test.ts` and `velocity-signal.test.ts` test the Phase 1 stub algorithms. These tests will fail once the implementations are replaced. **This is expected** — both test files are completely replaced in Tasks 2.2 and 3.2. Zoro must replace them before running `pnpm test`.

### Risk 3: Hot-path async in tradeHandler1
`PriceImpactSignalEvaluator.evaluate()` does 2 DB reads per trade. On high-throughput markets this could back-pressure the trade pipeline. Mitigation: keep the DB calls non-blocking (fire and continue), wrap in try/catch that only warns. Do NOT `await` inside the synchronous portion of the handler — restructure as a separate async handler registered independently.

### Risk 4: `SentimentVelocityEvaluator.bootstrap()` DB query volume
Querying 200 price records for each of 200 watchlisted tokens on startup = up to 40,000 rows. This is a startup-only cost and acceptable, but Zoro should batch these queries (query all tokens at once with `WHERE token_id IN (...)` + subquery for `LIMIT per token`) if performance is a concern. Simple approach: sequential per-token queries with `await Promise.all()` batching.

### Risk 5: `markets.winner` field semantics
The schema has `winner: boolean` on the `markets` table (from `src/db/schema.ts`). For a binary Yes/No market, `winner = true` means "Yes" won. But signal direction is `BULLISH`/`BEARISH` relative to a trade side. A `BUY` on the "Yes" token is bullish — it's a bet that `winner = true`. A `BUY` on the "No" token (negRisk) is also a `BUY` but is bearish on the outcome. **Mitigation**: For Phase 3, assume all tokens in the watchlist are non-negRisk (consistent with Phase 1/2 architecture). The correctness mapping `BULLISH → winner=true` is valid for non-negRisk tokens only.

### Risk 6: Backtest `signals` query with date range on partitioned table
`trades` is partitioned. `signals` is NOT partitioned (see schema). `ORDER BY created_at` with `BETWEEN` on `signals` will do a full table scan without a date-range partition pruning. This is acceptable for a CLI backtest tool — not on the hot path.

---

## Board Questions for Law (Architecture/Strategy Trade-offs)

1. **Composite scoring placement:** The spec says enrich the `payload` column before insert. But `handleSignal()` currently receives the `Signal` object and spreads it into `insertSignal()`. To enrich `payload`, we need to mutate or create a new `Signal` with an updated `payload`. Is `{ ...signal, payload: { ...signal.payload, compositeScore } }` the right pattern, or should `insertSignal()` accept an extra `extraPayload` parameter?

2. **PriceImpactEvaluator on the trade hot path:** 2 DB reads per trade is risky under load. Should it fire-and-forget (no `await` in the trade handler — just detach the async work) or should there be an internal queue/buffer for evaluation work?

3. **`VelocitySignal.velocityZScore` field name:** The Phase 3 algorithm doesn't compute a z-score — it computes `tradeCountVelocity`. Should we rename the field in `events/types.ts` (but that would change the type) or just populate it with `tradeCountVelocity` and note the semantic drift? The spec says "Do NOT change `src/db/schema.ts`" — `events/types.ts` is not mentioned in the edit surface constraints.

4. **Backtest resolution correctness for multi-outcome markets:** The current schema has one row per token (Yes/No are separate rows). If a market has `winner=true` on the "Yes" token and `winner=false` on the "No" token, a `BULLISH` signal on the "No" token would be incorrectly counted as correct (`winner=true` but signal is on the "No" side). Does the backtest need to account for `outcomeIndex` when computing correctness?

---

## TODO
- [ ] Task 1.1 — Extend `src/config.ts` (7 Phase 3 fields)
- [ ] Task 1.2 — Update `.env.example`
- [ ] Task 1.3 — Create `src/db/queries/price-history.ts`
- [ ] Task 2.1 — Rewrite `src/signals/price-impact-signal.ts`
- [ ] Task 2.2 — Replace `src/signals/price-impact-signal.test.ts`
- [ ] Task 3.1 — Rewrite `src/signals/velocity-signal.ts`
- [ ] Task 3.2 — Replace `src/signals/velocity-signal.test.ts`
- [ ] Task 4.1 — Update `src/processors/signal-aggregator.ts` (composite scoring)
- [ ] Task 4.2 — Extend `src/processors/signal-aggregator.test.ts`
- [ ] Task 5.1 — Create `src/backtest/types.ts`
- [ ] Task 5.2 — Create `src/backtest/evaluator.ts`
- [ ] Task 5.3 — Create `src/backtest/report.ts`
- [ ] Task 5.4 — Create `src/backtest/runner.ts`
- [ ] Task 6.1 — Update `src/pipeline.ts`
- [ ] Task 7.1 — Add `backtest` script to `package.json`
- [ ] Task 7.2 — Create `backtest-results/.gitkeep`
- [ ] Task 8.1 — `src/db/queries/price-history.test.ts`
- [ ] Task 8.2 — `src/signals/price-impact-signal.test.ts` (replace)
- [ ] Task 8.3 — `src/signals/velocity-signal.test.ts` (replace)
- [ ] Task 8.4 — `src/processors/signal-aggregator.test.ts` (extend)
- [ ] Task 8.5 — `src/backtest/evaluator.test.ts`
- [ ] Task 8.6 — `src/backtest/report.test.ts`
- [ ] Task 8.7 — `src/backtest/runner.test.ts`
- [ ] Task 8.8 — `src/config.test.ts` (Phase 3 additions)
- [ ] Task 9.1 — Update `CLAUDE.md`
- [ ] Task 9.2 — Commit sequence
- [ ] Task 9.3 — Push + open PR to `main`
