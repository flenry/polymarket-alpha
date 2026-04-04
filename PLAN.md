# Plan: Phase 3 — Signal Intelligence & Backtesting

> **Board-reviewed & Law-approved** — synthesised from Robin's research brief, Vegapunk's architecture
> review, and Law's critique. All MAJOR and MINOR findings addressed inline.
> Zoro implements. Usopp tests. Law approves architecture decisions.

## Goal
Deliver two new signal evaluators (`PriceImpactSignalEvaluator` v2, `SentimentVelocityEvaluator` v2 —
fully replacing the Phase 1 stubs), composite confidence scoring in `SignalAggregator`, a four-file
backtesting module (`src/backtest/`), pipeline wiring for all new components, and ≥ 95% test coverage
across all new code, with all existing 357 tests continuing to pass.

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
| `src/pipeline.ts` | Wire PriceImpactSignalEvaluator v2 + SentimentVelocityEvaluator v2 |
| `src/config.ts` | Add 7 Phase 3 env vars; remove legacy Phase 1 vars superseded by Phase 3 |
| `.env.example` | Add Phase 3 env vars |
| `package.json` | Add `backtest` script |
| `src/events/types.ts` | Update `VelocitySignal` type (rename `velocityZScore` → `tradeCountVelocity`, remove Phase 1 fields) |

### What is NEW (create from scratch)
- `src/db/queries/price-history.ts`
- `src/backtest/types.ts`
- `src/backtest/runner.ts`
- `src/backtest/evaluator.ts`
- `src/backtest/report.ts`
- `backtest-results/.gitkeep`
- `src/db/queries/price-history.test.ts`
- `src/signals/price-impact-signal.test.ts` — **replace** Phase 1 stub tests
- `src/signals/velocity-signal.test.ts` — **replace** Phase 1 stub tests
- `src/processors/signal-aggregator.test.ts` — extend (composite scoring additions only)
- `src/backtest/evaluator.test.ts`
- `src/backtest/report.test.ts`
- `src/backtest/runner.test.ts`

---

## Board Findings Resolved

### [LAW-MAJOR-1] Composite scoring — insert-then-update design selected

**Finding:** `SignalAggregator.handleSignal()` sees one signal at a time; prior signals are
already committed to the DB when a corroborating signal arrives. The original plan required
enriching "each participating signal" — which is impossible with an insert-only path.

**Resolution — Insert-then-update design:**

1. `SignalAggregator` maintains `private compositeMap: Map<tokenId, CompositeWindow>` where
   `CompositeWindow = { signals: Array<{id: bigint, type: SignalType, confidence: number, createdAt: number}>, windowStart: number }`.
2. **On each `handleSignal()` call:**
   a. Insert the signal into DB via `insertSignal()` → obtain `insertedId: bigint`.
   b. Register the new signal in `compositeMap[tokenId]` with its `id` and metadata.
   c. Purge entries older than `COMPOSITE_WINDOW_MS` from the window.
   d. If the window now has ≥ 2 signals: compute `compositeConfidence` and PATCH the `payload`
      jsonb column of **all signals in the window** (including the one just inserted and all prior
      ones) via a single SQL `UPDATE signals SET payload = payload || $patch WHERE id = ANY($ids)`.
   e. Log: `[COMPOSITE] tokenId: <score>, signals: [<types>]`.
3. A new query helper `updateSignalPayloads(db, ids, patch)` is added to `src/db/queries/signals.ts`.
4. The `compositeScore` field is merged into the `payload` jsonb of each participating signal row.

This means: the first signal in a window receives `compositeScore` retroactively when the second
signal arrives; the second and subsequent signals receive it immediately. This fully satisfies the
spec requirement that every participating signal carries the composite score.

### [LAW-MAJOR-2] Backtest runner — `createDb()` does not exist

**Finding:** `src/db/client.ts` exports `getDb()`, `db`, and `closeDb()` only. No `createDb()`.

**Resolution:** `runner.ts` uses `getDb()` (for the DB instance) and `closeDb()` (for teardown).
No new exports are added to `src/db/client.ts`. The plan reference to `createDb()` is removed
everywhere.

### [LAW-MAJOR-3] Backtest runner — `tsx` not in devDependencies, no new packages allowed

**Finding:** `node --import tsx/esm src/backtest/runner.ts` requires `tsx`, which is absent
from `package.json`. No new packages are permitted.

**Resolution:** The `backtest` script compiles first then runs compiled JS:
```json
"backtest": "tsc && node dist/backtest/runner.js"
```
`runner.ts` is a standard TypeScript file under `src/`, compiled by the existing `tsc` config.
CLI arg parsing uses `process.argv` with `process.env` variables as the stable interface — no
third-party arg parsers.

### [LAW-MAJOR-4] PriceImpactSignalEvaluator — async DB reads on the trade hot path cause timing races

**Finding:** `price_history` is written asynchronously by `PriceHistoryWriter`. At the moment
a `TradeEvent` arrives, the triggering price move may not yet be committed to `price_history`.

**Resolution — In-memory price state, no hot-path DB reads:**

`PriceImpactSignalEvaluator` does **not** read `price_history` from DB on the hot path. Instead:

- It is injected with **two price values directly at call time**:
  `evaluate(trade, priceBeforeTrade, priceNow, snapshot)`.
- `priceBeforeTrade` = the last price recorded *before* the current trade (maintained in-memory by
  pipeline in `recentPrices` map).
- `priceNow` = the current trade's `priceUsdc`.
- `snapshot` = a `SnapshotRecord | null` passed in from `snapshotWriter.getLatestBook()` (already
  in-memory in the pipeline).
- DB reads (snapshot and price history) are **not** performed inside `evaluate()`.
- The evaluator remains a **pure class with no DB dependency**; it receives all data as parameters.

This eliminates the race entirely. `priceBeforeTrade` is captured inside `tradeHandler1` from
`recentPrices.get(tokenId)` (last entry) **before** recording the new price; `priceNow` is
`trade.priceUsdc`. The snapshot is obtained from `snapshotWriter.getLatestBook(tokenId)`.

The DB query file `src/db/queries/price-history.ts` is **still created** (for the bootstrap path
in `SentimentVelocityEvaluator` and for backtest) but is **not called** on the hot path by
`PriceImpactSignalEvaluator`.

**Pipeline sequencing contract (explicit, addresses LAW-MINOR-2):**

```
tradeHandler1(trade):
  1. priceBeforeTrade = recentPrices.get(trade.tokenId)?.at(-1)?.price ?? null
  2. snapshot = snapshotWriter.getLatestBook(trade.tokenId)
  3. recordPrice(trade.tokenId, trade.priceUsdc)          ← updates recentPrices
  4. recordBucketPrice(trade.tokenId, trade.priceUsdc)
  5. tradeBatch.push(trade)  + flush if full
  6. velocityEvaluator.recordTrade(trade.tokenId, Date.now())
  7. (fire-and-forget) priceImpactEvaluator.evaluate(trade, priceBeforeTrade, priceNow, snapshot)
       .then(sig => { if (sig) bus.emit("signal", sig) })
       .catch(err => logger.error(err))
  8. velocityEvaluator.evaluate(trade.tokenId) → if signal, bus.emit("signal", signal)
```

Step 1 captures the price **before** step 3 updates it. "Evaluate" at step 7 uses `priceBeforeTrade`
and `trade.priceUsdc` — both available synchronously. No DB read is needed or performed.

### [LAW-MAJOR-5] SentimentVelocityEvaluator — cold restart distorts `tradeCountVelocity`

**Finding:** After restart, `tradeBuffer` starts empty. The prior-window trade count will be 0,
causing `tradeCountVelocity = currentCount / max(0,1) = currentCount` which is always ≥ 1.5× and
would produce false positives on startup.

**Resolution — warm-up suppression + trade bootstrap:**

Two complementary mitigations:

1. **Bootstrap from DB:** `SentimentVelocityEvaluator.bootstrap(db, tokenIds)` queries the
   `trades` table for timestamps within the last `2 * VELOCITY_WINDOW_SECONDS` for each token
   and pre-populates `tradeBuffer`. Query: `SELECT traded_at FROM trades WHERE token_id = $1
   AND traded_at >= NOW() - interval '$n seconds' ORDER BY traded_at ASC`.
   Called once at pipeline startup, after DB is available.

2. **Warm-up suppression:** A `private warmUntil: Map<TokenId, number>` records the time at
   which both current and prior trade windows will have been fully populated in-memory.
   - On first `recordTrade(tokenId, ts)` for a token that has **no bootstrap data**, set
     `warmUntil[tokenId] = ts + 2 * VELOCITY_WINDOW_SECONDS * 1000`.
   - In `evaluate(tokenId)`, return `null` if `Date.now() < warmUntil[tokenId]`.
   - If bootstrap data is present for both windows, `warmUntil` is not set (bootstrap covers it).
   - The price buffer already initialises from DB on bootstrap; cold price buffer is also guarded
     by `currentPrices.length < 2` check.

### [LAW-MAJOR-6] Backtest `recall` metric — definition was ambiguous and non-computable

**Finding:** `recall = correct / total resolvable` is only a filtered precision metric if the
only inputs are fired signals + resolutions. True recall requires knowing all eligible prediction
opportunities, not just the ones the system fired on.

**Resolution — rename to `resolvedHitRate`, document contract precisely:**

The metric is renamed `resolvedHitRate` throughout:
```
resolvedHitRate = signalsWithCorrectDirection / signalsWithAnyResolution
```

Where:
- `signalsWithAnyResolution` = fired signals (within backtest window) whose `tokenId` has a
  resolved `markets` row (`winner IS NOT NULL`).
- `signalsWithCorrectDirection` = subset of the above where signal direction matches the winner
  outcome.

This is a **hit rate on resolved markets** — meaningful, computable from the available data,
and accurately named. The `BacktestMetrics` type replaces `recall` with `resolvedHitRate`.

The backtest report table header is updated accordingly:
```
  Signal Type         Precision  HitRate  F1     Fired
```
F1 is computed as: `2 * precision * resolvedHitRate / (precision + resolvedHitRate)`.

### [LAW-MINOR-1] Depth mapping inversion — BUY should consume ask depth, not bid depth

**Finding:** A BUY order consumes resting ask-side liquidity. Using `bidDepthUsdc` for BUY
inverts the microstructure relationship and distorts anomaly scores.

**Resolution — corrected depth mapping:**
```
depthUsdc = side=BUY  ? snapshot.askDepthUsdc   // BUY consumes asks
          : side=SELL ? snapshot.bidDepthUsdc    // SELL consumes bids
```
This is the standard market microstructure convention. The algorithm reference below reflects this
corrected mapping. The original PRD had this backwards; the plan overrides it.

### [LAW-MINOR-2] Pipeline sequencing contract

Addressed under LAW-MAJOR-4. The explicit step-by-step order in `tradeHandler1` is the binding
implementation contract.

### [LAW-MINOR-3] Path typo — `events/types.ts` → `src/events/types.ts`

**Resolution:** All references in this plan use `src/events/types.ts`.

### [LAW-NIT-1] `velocityZScore` field name obsolete

**Resolution:** `VelocitySignal` in `src/events/types.ts` is updated:
- Remove: `velocityZScore`, `hourlyPriceChangePct`, `baselineStdDev` (Phase 1 vocabulary)
- Add: `tradeCountVelocity: number` (the new semantic field — the ratio of current/prior window
  trade counts, also stored as `strength` in the base signal)
- The `payload` jsonb will carry: `priceVelocityPctPerMin`, `tradeCountVelocity`,
  `windowSeconds`, `windowStartPrice`, `latestPrice`

### [VEGAPUNK] Fire-and-forget wrapper for async evaluation

**Resolution:** `priceImpactEvaluator.evaluate(...)` is invoked with:
```typescript
priceImpactEvaluator.evaluate(trade, priceBeforeTrade, priceNow, snapshot)
  .then(sig => { if (sig) bus.emit("signal", sig); })
  .catch(err => logger.error({ err }, "Pipeline: price impact eval failed"));
```
This prevents unhandled promise rejections while not back-pressuring WS ingestion.
The call is placed **after** `recordPrice()` so the buffer is updated, but `priceBeforeTrade`
is captured **before** `recordPrice()` as specified in the sequencing contract.

### [VEGAPUNK] `getRecentPriceHistory` — Drizzle v0.40 API

Uses `.select().from(priceHistory).where(eq(...)).orderBy(desc(...)).limit(n)` — standard Drizzle
chained query API, compatible with `drizzle-orm ^0.40.0`.

---

## Signal Algorithm Reference

### PriceImpactSignalEvaluator

**Signature:** `evaluate(trade: TradeEvent, priceBeforeTrade: number | null, priceNow: number, snapshot: SnapshotRecord | null): Promise<PriceImpactSignal | null>`

> Note: signature is `async` only to allow future DB use in non-hot paths; the hot-path impl
> is synchronous internally.

**Inputs:**
- `trade`: `{ tokenId, conditionId, side, valueUsdc, priceUsdc }`
- `priceBeforeTrade`: last recorded price from `recentPrices` before this trade (may be `null` on cold start)
- `priceNow`: `trade.priceUsdc`
- `snapshot`: result of `snapshotWriter.getLatestBook(tokenId)` (may be `null`)

**Algorithm:**
```
// 1. Guard: need a snapshot
if (!snapshot) → skip (no warn; expected on cold start)

// 2. Staleness guard
if (Date.now() - snapshot.capturedAt.getTime() > 60_000) → skip + warn

// 3. Guard: need prior price
if (priceBeforeTrade === null || priceBeforeTrade === 0) → skip silently

// 4. Depth lookup — CORRECTED (LAW-MINOR-1)
depthUsdc = trade.side === "BUY" ? snapshot.askDepthUsdc : snapshot.bidDepthUsdc
if (!depthUsdc || depthUsdc === 0) → skip (division guard)

// 5. Expected impact
expectedImpact = trade.valueUsdc / depthUsdc

// 6. Actual impact
actualImpact = Math.abs(priceNow - priceBeforeTrade) / priceBeforeTrade

// 7. Anomaly score
score = actualImpact / expectedImpact
if (score <= config.priceImpactAnomalyThreshold) → null

// 8. Cooldown per token
if (Date.now() - lastEmit.get(tokenId) < config.priceImpactCooldownMs) → null

// 9. Direction, confidence, signal
direction = trade.side === "BUY" ? "BULLISH" : "BEARISH"
confidence = min(1.0, (score - threshold) / threshold)
```

**Payload fields:** `{ score, expectedImpact, actualImpact, depthUsdc, valueUsdc, priceBeforeTrade, priceNow, snapshotAgeMs }`

### SentimentVelocityEvaluator

**State per token:**
```
priceBuffer: Map<TokenId, Array<{ price: number; timestamp: number }>>
tradeBuffer: Map<TokenId, Array<{ timestamp: number }>>
lastEmit:    Map<TokenId, number>
warmUntil:   Map<TokenId, number>   ← warm-up suppression
```

**Algorithm on `evaluate(tokenId: TokenId): VelocitySignal | null`:**
```
now = Date.now()
windowMs = config.velocityWindowSeconds * 1000

// Warm-up guard (LAW-MAJOR-5)
if (warmUntil.get(tokenId) > now) → null

// Current window: [now - windowMs, now]
currentPrices = priceBuffer[tokenId].filter(p => p.timestamp >= now - windowMs)
if (currentPrices.length < 2) → null

windowStartPrice = currentPrices[0].price
latestPrice = currentPrices[last].price
if (windowStartPrice === 0) → null

// Price velocity: % per minute
priceVelocity = (latestPrice - windowStartPrice) / windowStartPrice
              / config.velocityWindowSeconds * 60

if (|priceVelocity| <= config.velocityPriceThreshold) → null

// Trade count velocity
currentTrades = tradeBuffer[tokenId].filter(t => t.timestamp >= now - windowMs)
priorTrades   = tradeBuffer[tokenId].filter(t => t.timestamp >= now - 2*windowMs
                                               && t.timestamp <  now - windowMs)
tradeCountVelocity = currentTrades.length / max(priorTrades.length, 1)

if (tradeCountVelocity <= config.velocityTradeCountMultiplier) → null

// Cooldown
if (now - lastEmit.get(tokenId) < config.velocityCooldownMs) → null

// Direction, confidence, signal
direction = priceVelocity > 0 ? "BULLISH" : "BEARISH"
confidence = min(1.0, |priceVelocity| / (config.velocityPriceThreshold * 3))
strength   = tradeCountVelocity

payload = {
  priceVelocityPctPerMin: priceVelocity * 100,
  tradeCountVelocity,
  windowSeconds: config.velocityWindowSeconds,
  windowStartPrice,
  latestPrice
}
```

**Buffer management:** On each `recordPrice()` and `recordTrade()`, prune entries older than
`2 * windowMs` using `.filter()` — O(n) but bounded by `2 * windowSeconds * eventsPerSecond`.

**Warm-up rule (detail):**
- `bootstrap(db, tokenIds)` is called at pipeline startup. For each tokenId, it queries
  `trades` for the last `2 * VELOCITY_WINDOW_SECONDS` seconds and pre-populates `tradeBuffer`.
  It also queries `price_history` and pre-populates `priceBuffer`.
- If bootstrap returns data covering both windows for a token, `warmUntil` is not set for
  that token (sufficient history exists).
- If bootstrap returns no data (new token), `warmUntil[tokenId] = now + 2 * windowMs`.

---

## Config Reference (Phase 3 additions)

Add to `src/config.ts` and `.env.example`:

```
PRICE_IMPACT_ANOMALY_THRESHOLD=2.5     → config.priceImpactAnomalyThreshold
PRICE_IMPACT_COOLDOWN_MS=30000         → config.priceImpactCooldownMs
VELOCITY_WINDOW_SECONDS=300            → config.velocityWindowSeconds
VELOCITY_PRICE_THRESHOLD=0.005         → config.velocityPriceThreshold
VELOCITY_TRADE_COUNT_MULTIPLIER=1.5    → config.velocityTradeCountMultiplier
VELOCITY_COOLDOWN_MS=120000            → config.velocityCooldownMs
COMPOSITE_WINDOW_MS=60000              → config.compositeWindowMs
```

Legacy Phase 1 config vars superseded by Phase 3 (remove from `config.ts`):
- `priceImpactWindowSec` (was `PRICE_IMPACT_WINDOW_SEC`) — Phase 3 evaluator does not use a window
- `priceImpactMinChangePct` (was `PRICE_IMPACT_MIN_CHANGE_PCT`) — replaced by anomaly threshold
- `velocityZScoreThreshold` (was `VELOCITY_Z_SCORE_THRESHOLD`) — algorithm fully replaced

> **Caution:** Before removing legacy vars, confirm they are not referenced outside `pipeline.ts`
> and `price-impact-signal.ts`. If any test imports them from `config`, update those tests.

---

## Backtest Module Design

### Types (`src/backtest/types.ts`)
```typescript
export interface BacktestConfig {
  startDate: Date;
  endDate: Date;
  signalTypes?: SignalType[];
  minConfidence?: number;
  tokenIds?: string[];
}

export interface BacktestMetrics {
  totalFired: number;
  totalResolved: number;    // signals with a resolved market
  totalCorrect: number;     // resolved signals with correct direction
  precision: number;        // totalCorrect / totalFired
  resolvedHitRate: number;  // totalCorrect / max(totalResolved, 1)
  f1: number;               // harmonic mean of precision and resolvedHitRate
  avgConfidence: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  byType: Partial<Record<SignalType, BacktestMetrics>>;
  overall: BacktestMetrics;
}

export interface SignalOutcome {
  signalId: bigint;
  signalType: SignalType;
  direction: "BULLISH" | "BEARISH";
  confidence: number;
  tokenId: string;
  createdAt: Date;
  marketWinner: boolean | null;  // null = unresolved
}
```

### Runner (`src/backtest/runner.ts`)
- `BacktestRunner` class with `constructor(private db: Db)` — **no `createDb()`, uses `getDb()`**
- `run(config: BacktestConfig): Promise<BacktestResult>`
  1. Query `signals` joined to `markets` on `token_id`:
     `SELECT s.*, m.winner FROM signals s LEFT JOIN markets m ON s.token_id = m.token_id
     WHERE s.created_at BETWEEN $start AND $end [AND s.signal_type = ANY($types)]
     [AND s.confidence >= $minConf] [AND s.token_id = ANY($tokenIds)]`
  2. Map each row to `SignalOutcome` — resolved = `winner IS NOT NULL`
  3. Pass to `BacktestEvaluator.evaluate(outcomes, config)`
  4. Pass result to `BacktestReport.print(result)` + `BacktestReport.writeJson(result)`
- `main()` function parses `process.argv`:
  `--start YYYY-MM-DD`, `--end YYYY-MM-DD`, `--signal-types TYPE,TYPE`, `--min-confidence 0.5`
  Uses `getDb()` and `closeDb()` from `src/db/client.ts`.

### Evaluator (`src/backtest/evaluator.ts`)
- Pure function: `evaluate(outcomes: SignalOutcome[]): BacktestResult`
- Groups by `signalType`; computes per-type and overall `BacktestMetrics`
- Zero-division guard: `precision = totalFired > 0 ? totalCorrect / totalFired : 0`
- `resolvedHitRate = totalResolved > 0 ? totalCorrect / totalResolved : 0`
- `f1 = (precision + resolvedHitRate) > 0 ? 2 * p * r / (p + r) : 0`

### Report (`src/backtest/report.ts`)
- `print(result: BacktestResult): void` — formats box table to `process.stdout`
- `writeJson(result: BacktestResult, dir?: string): string` — writes to
  `backtest-results/{startDate}_{endDate}.json`; returns the file path
- Column headers in table: `Signal Type`, `Precision`, `HitRate`, `F1`, `Fired`

---

## Out of Scope
- Neg-risk signal generation (Phase 4)
- New DB schema changes or migrations
- Any other Phase 1 / Phase 2 source files not listed in the edit surface
- Deployment configuration changes
- Backtesting UI
- Streaming/pagination for large backtest windows (noted for Phase 4; bulk read acceptable for Phase 3)

---

## Tasks (Atomic, Testable, Ordered)

### Chunk 1 — Foundation (no other dependencies)

**Task 1.1 — Extend `src/config.ts`**
- Add 7 Phase 3 config vars (see Config Reference above)
- Remove 3 superseded Phase 1 vars (`priceImpactWindowSec`, `priceImpactMinChangePct`, `velocityZScoreThreshold`)
- ✅ Test: `src/config.test.ts` additions — verify each new var reads its env var and falls back to default

**Task 1.2 — Update `.env.example`**
- Add Phase 3 section with all 7 new vars + defaults
- Remove superseded Phase 1 vars
- ✅ No tests needed (documentation file)

**Task 1.3 — Update `src/events/types.ts`**
- Update `VelocitySignal`: remove `velocityZScore`, `hourlyPriceChangePct`, `baselineStdDev`; add `tradeCountVelocity: number`
- Update `PriceImpactSignal`: update `payload` type comment to match new fields
- ✅ Test: TypeScript compilation (`pnpm typecheck`) must pass

**Task 1.4 — Create `src/db/queries/price-history.ts`**
- Export `getRecentPriceHistory(db, tokenId, limit)` returning `Array<{ price: number, recordedAt: Date }>`
- Uses Drizzle `.select().from(priceHistory).where(eq(...)).orderBy(desc(...)).limit(n)` — v0.40 compatible
- Export `getRecentTradeTimestamps(db, tokenId, windowSeconds)` returning `Array<{ tradedAt: Date }>`
  Used by `SentimentVelocityEvaluator.bootstrap()` to pre-populate `tradeBuffer`
- ✅ Test: `src/db/queries/price-history.test.ts` — mocked DB, correct SQL shape, ordering

---

### Chunk 2 — PriceImpactSignalEvaluator (depends on Chunk 1)

**Task 2.1 — Rewrite `src/signals/price-impact-signal.ts`**
- Export class `PriceImpactSignalEvaluator` (no DB dependency — pure in-memory)
- Constructor: `constructor(opts?: { threshold?: number; cooldownMs?: number })`
- Method: `evaluate(trade: TradeEvent, priceBeforeTrade: number | null, priceNow: number, snapshot: SnapshotRecord | null): Promise<PriceImpactSignal | null>`
- Implements corrected depth mapping (LAW-MINOR-1): `BUY → askDepthUsdc`, `SELL → bidDepthUsdc`
- Stale snapshot guard: `Date.now() - snapshot.capturedAt.getTime() > 60_000` → skip + warn
- Division guards: `depthUsdc === 0`, `priceBeforeTrade === 0`
- Cooldown: `Map<TokenId, number>` per-token
- Signal payload fields: `score`, `expectedImpact`, `actualImpact`, `depthUsdc`, `valueUsdc`, `priceBeforeTrade`, `priceNow`, `snapshotAgeMs`
- Remove old `evaluatePriceImpact` function export entirely

**Task 2.2 — Replace `tests/signals/price-impact-signal.test.ts`**
- Test cases:
  - ✅ Fires when `score > threshold` (BUY, correct ask depth)
  - ✅ Fires when `score > threshold` (SELL, correct bid depth)
  - ✅ `BULL` direction for BUY, `BEAR` direction for SELL
  - ✅ Returns `null` when snapshot is `null`
  - ✅ Returns `null` + logs warn when snapshot older than 60s
  - ✅ Returns `null` when `priceBeforeTrade` is `null`
  - ✅ Returns `null` when `depthUsdc === 0` (division guard)
  - ✅ Returns `null` when `score <= threshold`
  - ✅ Cooldown suppression — second call within cooldown returns `null`
  - ✅ Cooldown resets after `cooldownMs`
  - ✅ Confidence scaling: `min(1.0, (score - threshold) / threshold)`
  - ✅ Custom `threshold` and `cooldownMs` via constructor opts

---

### Chunk 3 — SentimentVelocityEvaluator (depends on Chunk 1)

**Task 3.1 — Rewrite `src/signals/velocity-signal.ts`**
- Export class `SentimentVelocityEvaluator`
- Constructor: `constructor(opts?: { windowSeconds?: number; priceThreshold?: number; tradeCountMultiplier?: number; cooldownMs?: number })`
- Methods:
  - `recordPrice(tokenId: TokenId, price: number, timestamp?: number): void`
  - `recordTrade(tokenId: TokenId, timestamp?: number): void`
  - `evaluate(tokenId: TokenId): VelocitySignal | null`
  - `bootstrap(db: Db, tokenIds: TokenId[]): Promise<void>`
  - `clear(): void` — reset all buffers (for testing + shutdown)
- Warm-up suppression: `warmUntil` map — returns `null` until both windows are warm
- Buffer pruning: prune to `2 * windowMs` on every `recordPrice`/`recordTrade`
- Remove old `evaluateVelocity` function export entirely
- Signal uses `tradeCountVelocity` field (not `velocityZScore`)

**Task 3.2 — Replace `tests/signals/velocity-signal.test.ts`**
- Test cases:
  - ✅ Fires when both price velocity and trade count velocity exceed thresholds
  - ✅ Does NOT fire when only price velocity exceeded (trade count below multiplier)
  - ✅ Does NOT fire when only trade count velocity exceeded (price below threshold)
  - ✅ `BULLISH` direction when price rising, `BEARISH` when falling
  - ✅ Cooldown suppression
  - ✅ Returns `null` when fewer than 2 price records in current window
  - ✅ Rolling window correctly excludes records older than `windowSeconds`
  - ✅ Prior window trade count uses `[now-2W, now-W)` range
  - ✅ `tradeCountVelocity` = 1 when prior window is 0 (division guard)
  - ✅ Warm-up suppression — returns `null` before warm-up period expires
  - ✅ `bootstrap()` pre-populates buffers and suppresses warm-up when data present
  - ✅ Confidence: `min(1.0, |priceVelocity| / (threshold * 3))`
  - ✅ Custom opts via constructor

---

### Chunk 4 — SignalAggregator Composite Scoring (depends on Chunk 1)

**Task 4.1 — Update `src/processors/signal-aggregator.ts`**
- Add `private compositeMap: Map<TokenId, CompositeWindow>` where:
  `CompositeWindow = { signals: Array<{id: bigint, type: SignalType, confidence: number, createdAt: number}>, windowStart: number }`
- In `handleSignal()` (after existing insert):
  1. Capture `insertedId` from `insertSignal()` return value
  2. Add new signal to `compositeMap[tokenId]`
  3. Prune entries older than `config.compositeWindowMs`
  4. If window has ≥ 2 signals:
     - `compositeConfidence = mean(confidences) * (1 + 0.15 * (count - 1))`
     - Build `ids = window.signals.map(s => s.id)` (includes all signals in window)
     - Call `updateSignalPayloads(db, ids, { compositeScore: compositeConfidence })` — patches all prior rows
     - Log: `[COMPOSITE] tokenId: <score>, signals: [<types>]`
- Window `windowStart` is set to the timestamp of the **first** signal in the group
- Add `updateSignalPayloads(db, ids, patch)` to `src/db/queries/signals.ts`

**Task 4.2 — Extend `src/processors/signal-aggregator.test.ts`**
- Test cases (additions only — do not break existing 357 tests):
  - ✅ Single signal: no composite score, `updateSignalPayloads` not called
  - ✅ Two signals within window: `compositeScore` computed + both DB rows patched
  - ✅ Three signals: bonus factor applied `(1 + 0.15 * 2)` = 1.30
  - ✅ Window expiry: second signal after `compositeWindowMs` does NOT combine with first
  - ✅ Different tokenIds: separate windows, no cross-token composite
  - ✅ Log output contains `[COMPOSITE]` with correct tokenId and types

---

### Chunk 5 — Backtest Module (depends on Chunk 1)

**Task 5.1 — Create `src/backtest/types.ts`**
- All interfaces from Backtest Module Design above
- Export: `BacktestConfig`, `BacktestMetrics`, `BacktestResult`, `SignalOutcome`

**Task 5.2 — Create `src/backtest/evaluator.ts`**
- Pure function `evaluate(outcomes: SignalOutcome[], config: BacktestConfig): BacktestResult`
- Computes per-type and overall `BacktestMetrics`
- Uses `resolvedHitRate` (not `recall`)
- Zero-division guards on all metrics

**Task 5.3 — Create `src/backtest/report.ts`**
- `print(result: BacktestResult): void` — box table to stdout
- `writeJson(result: BacktestResult, dir?: string): string` — returns path written
- Column order: `Signal Type | Precision | HitRate | F1 | Fired`

**Task 5.4 — Create `src/backtest/runner.ts`**
- `BacktestRunner` class: `constructor(private db: Db)`
- `run(config: BacktestConfig): Promise<BacktestResult>`
- `main()`: parses `process.argv`, calls `getDb()` / `closeDb()` (NOT `createDb()`)
- Uses `LEFT JOIN markets` to obtain `winner` for each signal's `tokenId`

---

### Chunk 6 — Pipeline Wiring (depends on Chunks 2, 3, 4)

**Task 6.1 — Update `src/pipeline.ts`**
- Remove: `import { evaluatePriceImpact } from "./signals/price-impact-signal.js"`
- Remove: `import { evaluateVelocity } from "./signals/velocity-signal.js"`
- Remove: `recentPrices` map, `recordPrice()`, `PRICE_WINDOW_MS` (replaced by evaluator-internal state)
  > **Note:** Keep `recordBucketPrice` and `priceBuckets` only if still needed — they are NOT
  > needed after Phase 3 since `SentimentVelocityEvaluator` manages its own `priceBuffer`.
  > Remove `priceBuckets`, `BUCKET_MS`, `MAX_BUCKETS`, `recordBucketPrice`, and the `velocityTimer`
  > `setInterval` block.
- Add: `import { PriceImpactSignalEvaluator } from "./signals/price-impact-signal.js"`
- Add: `import { SentimentVelocityEvaluator } from "./signals/velocity-signal.js"`
- Instantiate: `const priceImpactEvaluator = new PriceImpactSignalEvaluator()`
- Instantiate: `const velocityEvaluator = new SentimentVelocityEvaluator()`
- Bootstrap: after `gammaPoller.start()`, call `velocityEvaluator.bootstrap(db, watchlistedTokenIds)` (non-blocking, catch errors)
- Wire `best_bid_ask` and `last_trade_price` → `velocityEvaluator.recordPrice(tokenId, price)`
- In `tradeHandler1`:
  1. Capture `priceBeforeTrade` from evaluator's last known price (see sequencing contract)
  2. Call `velocityEvaluator.recordTrade(tokenId)` and `velocityEvaluator.recordPrice(tokenId, trade.priceUsdc)`
  3. Fire-and-forget `priceImpactEvaluator.evaluate(trade, priceBeforeTrade, trade.priceUsdc, snapshot)` → emit signal
  4. Sync call `velocityEvaluator.evaluate(tokenId)` → emit signal if not null
- Remove `velocityTimer` setInterval (velocity evaluated per-trade now, not on a timer)
- In `shutdown()`: call `velocityEvaluator.clear()`
- Remove bus listener registrations for old handlers that no longer exist

---

### Chunk 7 — Package + Output Directory (no dependencies)

**Task 7.1 — Add `backtest` script to `package.json`**
```json
"backtest": "tsc && node dist/backtest/runner.js"
```

**Task 7.2 — Create `backtest-results/.gitkeep`**
- Empty file to track the output directory in git
- Add `backtest-results/*.json` to `.gitignore` (keep `.gitkeep`, ignore results)

---

### Chunk 8 — Tests (depends on respective implementation chunks)

**Task 8.1 — `src/db/queries/price-history.test.ts`**
- `getRecentPriceHistory`: returns rows ordered DESC, limits correctly, returns `[]` on no rows
- `getRecentTradeTimestamps`: returns timestamps within window, excludes older records

**Task 8.2 — `src/signals/price-impact-signal.test.ts`** (already specified in Task 2.2)

**Task 8.3 — `src/signals/velocity-signal.test.ts`** (already specified in Task 3.2)

**Task 8.4 — `src/processors/signal-aggregator.test.ts`** (already specified in Task 4.2)

**Task 8.5 — `src/backtest/evaluator.test.ts`**
- Precision/resolvedHitRate/f1 math with known inputs
- Zero-division: `totalFired = 0` → all metrics 0
- Zero-division: `totalResolved = 0` → `resolvedHitRate = 0`
- Per-type breakdown correctness
- Mixed signal types in one result

**Task 8.6 — `src/backtest/report.test.ts`**
- JSON output shape matches `BacktestResult`
- JSON written to correct path
- Stdout table contains expected column headers
- `HitRate` column (not `Recall`) is present in output

**Task 8.7 — `src/backtest/runner.test.ts`**
- Correct SQL query issued (signal fetch with date range)
- `LEFT JOIN markets` for resolution lookup
- Correct call to `BacktestEvaluator.evaluate()`
- Zero signals returned gracefully

**Task 8.8 — `src/config.test.ts` additions**
- Each of the 7 new Phase 3 vars reads its env var
- Each falls back to the correct default when env var unset
- Removed Phase 1 vars no longer appear on `config`

---

## Execution Order

```
Chunk 1 (1.1 → 1.4)   ← foundation, no deps
    ↓
Chunk 2 (2.1 → 2.2)   ← PriceImpactEvaluator (no DB dep)
Chunk 3 (3.1 → 3.2)   ← VelocityEvaluator (concurrent with Chunk 2)
Chunk 5 (5.1 → 5.4)   ← Backtest module (concurrent with Chunks 2+3)
    ↓
Chunk 4 (4.1 → 4.2)   ← SignalAggregator composite (depends on Chunk 1; safe to do after 2+3)
    ↓
Chunk 6 (6.1)          ← Pipeline wiring (depends on 2, 3, 4 complete)
Chunk 7 (7.1 → 7.2)   ← Package updates (no deps; can do anytime)
    ↓
Chunk 8 (8.1 → 8.8)   ← All tests (some overlap with their chunks above)
    ↓
Chunk 9 (docs + commit sequence)
```

---

### Chunk 9 — Docs + Commit Strategy

**Task 9.1 — Update `CLAUDE.md`**
- Update test count, coverage percentages once Phase 3 is complete
- Add Phase 3 component summary (PriceImpactSignalEvaluator, SentimentVelocityEvaluator, backtest module)

**Task 9.2 — Commit sequence on `feat/phase-3`**
```
feat: add Phase 3 config vars and price-history query helpers
feat: implement PriceImpactSignalEvaluator (v2 — in-memory, no hot-path DB reads)
feat: implement SentimentVelocityEvaluator (v2 — rolling buffers, warm-up suppression)
feat: add composite confidence scoring to SignalAggregator (insert-then-update)
feat: add backtesting module (runner, evaluator, report, types)
feat: wire Phase 3 evaluators into pipeline
chore: update docs for Phase 3
```

**Task 9.3 — Push + open PR to `main`**

---

## Risks & Mitigations (Final)

| Risk | Mitigation |
|---|---|
| Price impact evaluation on cold start (no prior price) | `priceBeforeTrade === null` guard — returns `null` silently |
| Velocity evaluator cold-restart false positives | Warm-up suppression + bootstrap from `trades` table |
| Composite scoring patches fail (DB error) | `updateSignalPayloads` errors are caught and logged; signal already inserted — no data loss |
| Backtest bulk read OOM on large windows | Acceptable for Phase 3; note for Phase 4 streaming |
| `tsc && node dist/...` backtest script requires successful compile | CI will catch build failures; local dev: run `pnpm build` first |
| Snapshot not available at trade time (new token) | `snapshot === null` guard — returns `null` silently |
| `priceBuckets` / `velocityTimer` removal breaking existing tests | Check for any test that imports these pipeline internals before deleting |
| Removing legacy config vars breaking existing tests | Audit `config.priceImpactWindowSec`, `config.priceImpactMinChangePct`, `config.velocityZScoreThreshold` usage before deletion |
