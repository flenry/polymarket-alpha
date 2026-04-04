# Plan: Phase 4 + Phase 5 — Neg-Risk Cross-Book Pricing + Analytics & Observability

> **Board-reviewed & Law-approved** — synthesised from Robin's research brief, Vegapunk's
> architecture review, and Law's strategic critique. All MAJOR and MINOR findings from the
> Law review are addressed inline. Zoro implements. Usopp tests. Law approves decisions.

## Goal
Ship a fully tested, type-clean implementation of Phase 4 (neg-risk cross-book arb/outlier signal
engine) and Phase 5 (wallet leaderboard, signal dashboard, market heat-map CLIs) on branch
`feat/phase-4-5`, with a PR to `main`. All 414 existing tests must continue to pass. Target
≥ 470 tests total (+56). Zero TypeScript errors.

## Branch
`feat/phase-4-5` (created from `main` at Phase 3 merge)

---

## Project Status
**EXISTING project — Phase 1 + Phase 2 + Phase 3 complete.** 414 tests, 95.88% stmt / 94.64% branch.

---

## Board Findings Resolved

### [LAW-MAJOR-1] Neg-risk trade routing — early-return must NOT skip persistence

**Finding:** The original plan's `tradeHandler1` would have added an early-return for neg-risk
tokens at the top, which would accidentally drop neg-risk trades before they are persisted to
the `trades` table.

**Resolution — split persistence from signal evaluation:**

In `tradeHandler1`, do NOT early-return for neg-risk tokens before the trade batch push.
Instead:
```
tradeHandler1(trade):
  1. tradeBatch.push(trade)   ← always, including neg-risk
  2. (flush if batch full)    ← always
  3. if (negRiskSet.has(trade.tokenId)) return  ← return HERE (after persist path)
  4. ... velocity / price-impact evaluation for non-neg-risk only ...
```

In `tradeHandler2` (WhaleDetector path), the same guard applies:
```
tradeHandler2(trade):
  1. if (negRiskSet.has(trade.tokenId)) return  ← top-of-handler; no DB write needed here
```

Neg-risk trades ARE persisted to `trades` (for analytics, wallet profiling, backtest).
They are NOT evaluated by WhaleDetector, PriceImpactSignalEvaluator, or SentimentVelocityEvaluator.

### [LAW-MAJOR-2] Outlier detection — direction-aware logic

**Finding:** The original `max(|price - mean| / stddev)` selector would fire `"BULLISH"` on an
overpriced token (negative spread from the group's perspective) — wrong direction.

**Resolution — direction-aware outlier detection:**

The `ArbDetector.evaluate()` outlier path uses a **directional filter**:
- Compute `priceDeviation = (mean24h - token.bestAsk) / stddev` for each token
  (positive → token is underpriced relative to its 24h mean)
- `outlierToken = token with max(priceDeviation)` where `priceDeviation > 0`
- Fire `NEG_RISK_OUTLIER` only when `priceDeviation > 3.0` (underpriced by 3σ)
- Direction is always `"BULLISH"` (underpriced token is a buy opportunity)
- To fire a `"BEARISH"` outlier signal (overpriced): `(token.bestAsk - mean24h) / stddev > 3.0`
  — For Phase 4 MVP, emit `BEARISH` for overpriced tokens too, with `direction = "BEARISH"`
  and use the token with max overpriced-deviation as the outlier

**Algorithm (Phase 4 MVP, symmetric):**
```
for each token in group:
  history = getTokenPriceHistory24h(db, token.tokenId)
  if history.length < 5: skip
  mean   = avg(history.prices)
  stddev = populationStddev(history.prices)
  if stddev === 0: skip

  underpricedDev = (mean - token.bestAsk) / stddev   // + means underpriced
  overpricedDev  = (token.bestAsk - mean) / stddev   // + means overpriced

Select outlier = token with max(|underpricedDev|) among tokens where |dev| > 3.0
If underpricedDev > 3.0  → direction = "BULLISH"
If overpricedDev  > 3.0  → direction = "BEARISH"
```

Confidence: `min(1.0, maxDeviation / 5.0)`

### [LAW-MAJOR-3] Arb detection — size-aware minimum to filter dust quotes

**Finding:** Arb detection based on `bids[0]` / `asks[0]` top-of-book prices ignores executable
size. A dust quote (e.g. ask size = 0.01) would trigger a false positive arb signal.

**Resolution — minimum size guard on top-of-book:**

In `GroupResolver.resolveGroups()`, when mapping books to `NegRiskToken`:
```
bestAsk = asks[0]?.price ?? 1
bestAskSize = asks[0]?.size ?? 0

// If best ask size < MIN_NEG_RISK_SIZE, use next ask or treat as 1.0
const MIN_NEG_RISK_SIZE = 10.0   // minimum 10 tokens notional to count as tradeable
if (bestAskSize < MIN_NEG_RISK_SIZE) {
  // Walk ask ladder to find first level with sufficient size
  const tradeable = asks.find(a => a.size >= MIN_NEG_RISK_SIZE)
  bestAsk = tradeable?.price ?? 1.0   // if no tradeable ask, treat as worst-case (1.0)
}
```

This means `sumAsk` reflects prices where at least `MIN_NEG_RISK_SIZE` tokens are available.
`MIN_NEG_RISK_SIZE` is a constant (not a config var for Phase 4 MVP) — set to `10.0`.

`bestBid` uses the same guard (minimum bid size before counting as a liquid bid):
```
if (bids[0]?.size ?? 0 < MIN_NEG_RISK_SIZE) bestBid = 0
else bestBid = bids[0].price
```

### [LAW-MAJOR-4] Group membership — dynamic refresh on `markets_updated`

**Finding:** `NegRiskEngine.start(negRiskTokenIds)` seeds from a static array at startup. As
`GammaPoller` discovers new neg-risk markets, those tokens are silently missed by the engine.
Also, newly-discovered neg-risk tokens are not subscribed in `ClobWsPool`.

**Resolution — refresh neg-risk membership on `markets_updated`:**

`NegRiskEngine` is wired to `GammaPoller`'s `markets_updated` event in `pipeline.ts`:
```ts
gammaPoller.on("markets_updated", (_newTokenIds: TokenId[], newNegRiskIds: TokenId[]) => {
  if (newNegRiskIds.length > 0) {
    negRiskEngine.addTokenIds(newNegRiskIds);
    clobWsPool.addTokenIds(newNegRiskIds);   // subscribe new neg-risk tokens to CLOB WS
  }
});
```

`NegRiskEngine.addTokenIds(ids: string[]): void`:
- Adds new IDs to `this.negRiskTokenIds` set
- Triggers a debounced `refresh()` (debounce 2000ms to batch rapid updates)
- Does NOT restart the interval — new tokens will be picked up on the next scheduled refresh
  OR the next `BookUpdateEvent` for those tokens

The initial call to `negRiskEngine.start()` uses `gammaPoller.getNegRiskIds()` (populated
synchronously after `gammaPoller.start()` completes). Subsequent additions come via `addTokenIds`.

### [LAW-MAJOR-5] Analytics SQL — parse cutoffs in Node, not string interpolation

**Finding:** Interpolating `--days` / `--hours` into SQL interval strings (`INTERVAL '${days} days'`)
is fragile and wrong for CLI inputs.

**Resolution — compute JS Date cutoff, pass as bound parameter:**

All analytics CLIs compute the cutoff as a `Date` object in Node:
```ts
// In leaderboard.ts / signal-dashboard.ts / heat-map.ts:
const days = parseInt(argv.days ?? "7", 10);
if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive integer");
const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

// Then in the query:
.where(gte(signals.createdAt, cutoff))   // Drizzle ORM
// OR raw SQL:
sql`WHERE created_at >= ${cutoff.toISOString()}::timestamptz`
```

All three CLIs validate their numeric args before issuing any query. Invalid args throw a
usage error before DB connection is opened.

### [LAW-MINOR-1] Must-have contradiction — `src/validation/schemas.ts` vs `src/events/types.ts`

**Finding:** The must-have list said "extend `src/validation/schemas.ts`" but Task 1.2 said
no change needed. Contradictory.

**Resolution — definitive answer:**

`src/validation/schemas.ts` does NOT need to change. The `ZSignalType` enum used in
`src/db/queries/signals.ts` is built from `SIGNAL_TYPES` in `src/events/types.ts` directly.
Extending `SIGNAL_TYPES` in `events/types.ts` (Task 1.1) automatically propagates to
`ZSignalType`. No separate change to `validation/schemas.ts` is required.

The must-have is updated: "Extend `src/events/types.ts` and `src/db/queries/signals.ts`
(via SIGNAL_TYPES propagation) with two new types."

### [LAW-MINOR-2] `SignalAggregator` guard — pick one design

**Finding:** The must-have required updating `SignalAggregator`'s `SIGNAL_TYPES` guard, but
the architecture bypasses `SignalAggregator` for neg-risk signals entirely.

**Resolution — independent subsystem design selected:**

`NegRiskEngine` is a fully independent subsystem. It calls `insertSignal()` directly (bypassing
the event bus and `SignalAggregator`). `SignalAggregator` is NOT updated. Consequently:
- `SIGNAL_TYPES` guard in `SignalAggregator.handleSignal()` does NOT need `NEG_RISK_ARB` or
  `NEG_RISK_OUTLIER` added — those types will never reach `SignalAggregator`.
- `ZSignalType` in `signals.ts` DOES need to include both new types (for `insertSignal`'s
  Zod validation of signals written directly by `NegRiskEngine`).
- The must-have requiring `SignalAggregator` guard update is removed.
- No webhook routing is added to the bus signal handler; `NegRiskEngine` calls
  `webhookEmitter.send()` directly.

### [LAW-MINOR-3] Group validity upper bound on `sumAsk`

**Finding:** `sumAsk >= 0.95 && sumBid <= 1.05` allows obviously broken books like `sumAsk=1.40`.

**Resolution — add explicit upper bound:**

```
isValid = sumBid <= 1.05 && sumAsk >= 0.95 && sumAsk <= 1.20 && tokens.length >= 2
```

The `sumAsk <= 1.20` guard filters groups with egregiously overpriced books (20% above fair
value suggests data integrity issues or extreme market conditions where arb calculations would
not be meaningful). Empirical upper bound: legitimate neg-risk groups rarely exceed 1.10 even
during high volatility.

### [LAW-MINOR-4] `handleBookUpdate` — missing group guard for startup races

**Finding:** `handleBookUpdate` assumes `evt.book.conditionId` maps cleanly to a cached group,
but the first `refresh()` may not have completed when early book updates arrive.

**Resolution — queue or ignore with debug logging:**

```ts
handleBookUpdate(evt: BookUpdateEvent): void {
  if (!this.negRiskTokenIds.has(evt.book.tokenId)) return;   // not a neg-risk token
  const group = this.groups.get(evt.book.conditionId);
  if (!group) {
    logger.debug({ conditionId: evt.book.conditionId }, "NegRiskEngine: group not yet resolved, skipping BookUpdateEvent");
    return;   // group will be populated on next refresh(); no queue needed (low frequency)
  }
  // ... partial update + evaluate
}
```

Test: `"book update arrives before first refresh completes"` — should silently return, no throw.

### [LAW-MINOR-5] Leaderboard — sourced from `wallet_profiles` only

**Finding:** The original spec promised joins with `whale_alerts` and `signals` for the
leaderboard, but the practical join is impractical (whale_alerts lacks a direct proxy_wallet
column for SQL JOIN).

**Resolution — documented trade-off:**

Phase 5 leaderboard is sourced from `wallet_profiles` only. `wallet_profiles` is maintained by
`WalletEnricher` and already tracks `trade_count`, `win_ratio`, `total_volume_usdc`, and
`whale_trade_count`. This is the correct data source for correctness and simplicity.

**This trade-off is documented explicitly:**
- In the leaderboard CLI output header: `# Source: wallet_profiles (enriched by WalletEnricher)`
- In CLAUDE.md / README.md Phase 5 description

### [LAW-NIT-1] WebhookEmitter — add explicit neg-risk payload builders

**Finding:** The fallback `JSON.stringify` branch in `WebhookEmitter` is safe but should not
be relied on long-term for neg-risk signals.

**Resolution:** Task 6.1 adds explicit `buildDiscordNegRiskEmbed()` and `buildSlackNegRiskPayload()`
builders with purple color `0x9B59B6`. The fallback remains as defensive code for any future
unknown signal types.

---

## Must-Haves (corrected post-Law review)

- `NegRiskEngine` produces `NEG_RISK_ARB` and `NEG_RISK_OUTLIER` signals stored in `signals` table
- `GroupResolver` correctly groups neg-risk tokens by conditionId, validates price sum with
  both lower and upper bounds (`0.95 ≤ sumAsk ≤ 1.20`, `sumBid ≤ 1.05`, `tokens.length ≥ 2`),
  and applies minimum ask-size guard to filter dust quotes
- `ArbDetector` fires arb signal when spread < -0.02, fires directionally-correct outlier signal
  (BULLISH for underpriced, BEARISH for overpriced), respects per-conditionId cooldown
- Neg-risk tokens watchlisted=true in DB; neg-risk trade persistence is NOT skipped (only
  signal evaluation is gated); neg-risk tokens flow to CLOB WS
- Newly discovered neg-risk tokens from `markets_updated` are dynamically added to
  `NegRiskEngine` and `ClobWsPool` (not just seeded at startup)
- `WebhookEmitter.send()` has explicit purple-embed builders for neg-risk signal types
- Three analytics CLIs use parsed JS Date cutoffs (not interpolated SQL intervals), validate
  numeric args, and follow the `tsc && node dist/...` pattern (no tsx)
- All Phase 4 + Phase 5 tests pass; no regressions in existing 414 tests
- Config extended with 6 new env vars
- Signal type union in `src/events/types.ts` extended with two new types; `SIGNAL_TYPES` array
  updated so `ZSignalType` in `signals.ts` accepts `NEG_RISK_ARB` and `NEG_RISK_OUTLIER`
- Docs updated: CLAUDE.md, README.md, `.env.example`

---

## Out of Scope

- No new DB tables — schema.ts is frozen; signals table handles arbitrary signalType strings
- No drizzle migrations — drizzle/ directory untouched
- Phase 1/2/3 source files untouched, **except**: `pipeline.ts`, `config.ts`, `.env.example`,
  `gamma-poller.ts`, `live-data-ws-client.ts`, `clob-ws-pool.ts`, `events/types.ts`,
  `db/queries/markets.ts`, `db/queries/price-history.ts`, `alerts/webhook-emitter.ts`
- No new npm packages; all CLIs use Node.js built-ins + existing deps
- Real network calls in tests (all mocked)
- `SignalAggregator` is NOT modified (NegRiskEngine is fully independent)
- `src/validation/schemas.ts` is NOT modified

---

## Codebase State (as of Phase 3)

### What is LOCKED — must not change
- `src/db/schema.ts`
- `drizzle/` directory
- `src/processors/signal-aggregator.ts` (no changes for Phase 4)
- `src/validation/schemas.ts` (no changes needed)
- All Phase 1/2/3 source files not listed in the edit surface below

### Allowed edit surface (Phase 4+5 may touch these files)

| File | Permitted change |
|---|---|
| `src/events/types.ts` | Add `NEG_RISK_ARB`, `NEG_RISK_OUTLIER` to `SignalType`, `SIGNAL_TYPES`, `Signal` union; add `NegRiskSignal` interface; add `PipelineConfig` Phase 4+5 fields |
| `src/config.ts` | Add 6 Phase 4+5 env vars |
| `.env.example` | Add Phase 4+5 sections |
| `src/db/queries/markets.ts` | Add `getNegRiskMarketsByCondition()`, `getAllWatchlistedTokenIds()` |
| `src/db/queries/price-history.ts` | Add `getTokenPriceHistory24h()` |
| `src/sources/gamma-poller.ts` | Flip neg-risk `watchlisted = true`; maintain `negRiskSet` |
| `src/sources/live-data-ws-client.ts` | Remove neg-risk filter block |
| `src/pipeline.ts` | Wire NegRiskEngine; add neg-risk guards; wire `markets_updated` → `addTokenIds` |
| `src/alerts/webhook-emitter.ts` | Add explicit neg-risk payload builders (purple embeds) |
| `package.json` | Add `leaderboard`, `dashboard`, `heatmap` scripts |

### What is NEW (create from scratch)
- `src/neg-risk/group-resolver.ts`
- `src/neg-risk/arb-detector.ts`
- `src/neg-risk/neg-risk-engine.ts`
- `src/neg-risk/index.ts` (barrel)
- `src/analytics/leaderboard.ts`
- `src/analytics/signal-dashboard.ts`
- `src/analytics/heat-map.ts`
- `analytics-results/.gitkeep`
- `src/neg-risk/group-resolver.test.ts`
- `src/neg-risk/arb-detector.test.ts`
- `src/neg-risk/neg-risk-engine.test.ts`
- `src/analytics/leaderboard.test.ts`
- `src/analytics/signal-dashboard.test.ts`
- `src/analytics/heat-map.test.ts`

---

## Architecture

### Neg-Risk Pipeline Flow (Phase 4)

```
GammaPoller      → upserts all markets with watchlisted=TRUE (including neg-risk)
                 → maintains negRiskSet for routing
LiveDataWsClient → all trades flow through (neg-risk filter removed)
ClobWsPool       → neg-risk tokenIds included in connect() call
pipeline.ts      → tradeHandler1: persist all trades; guard signal evaluation for neg-risk
                 → tradeHandler2: guard at top (neg-risk trades skip WhaleDetector)
                 → bus.on("book_update") → NegRiskEngine.handleBookUpdate()
                 → gammaPoller.on("markets_updated") → negRiskEngine.addTokenIds() + clobWsPool.addTokenIds()
NegRiskEngine    → GroupResolver → ArbDetector → insertSignal + AlertEmitter + WebhookEmitter
```

### Analytics Pipeline Flow (Phase 5)

```
pnpm leaderboard/dashboard/heatmap
  → tsc && node dist/analytics/xxx.js
  → parse CLI args (validate numeric, compute JS Date cutoff)
  → getDb() → query with Drizzle / raw SQL (bound params)
  → render ASCII table to stdout
  → (leaderboard) write JSON to analytics-results/
  → closeDb() → process.exit(0)
```

### NegRiskEngine Internal Design

```
NegRiskEngine
  ├── GroupResolver (queries DB + ClobRestClient.batchGetBooks)
  ├── ArbDetector   (pure evaluation, DB for price history only)
  ├── groups: Map<ConditionId, NegRiskGroup>   ← cache
  ├── negRiskTokenIds: Set<TokenId>            ← for routing in handleBookUpdate
  ├── refreshTimer                              ← setInterval(refresh, refreshIntervalMs)
  └── debounce timer                            ← for addTokenIds batch refresh
```

---

## Config Reference (Phase 4+5 additions)

Add to `src/config.ts` and `.env.example`:

```
# Phase 4
NEG_RISK_REFRESH_INTERVAL_MS=120000   → config.negRiskRefreshIntervalMs
NEG_RISK_ARB_THRESHOLD=-0.02          → config.negRiskArbThreshold   (negative — fire when arbSpread < this)
NEG_RISK_COOLDOWN_MS=60000            → config.negRiskCooldownMs

# Phase 5
DASHBOARD_REFRESH_MS=30000            → config.dashboardRefreshMs
LEADERBOARD_MIN_TRADES=5              → config.leaderboardMinTrades
LEADERBOARD_TOP_N=20                  → config.leaderboardTopN
```

`NEG_RISK_ARB_THRESHOLD=-0.02`: `Number("-0.02") = -0.02`. Comparison: `arbSpread < config.negRiskArbThreshold`
where `arbSpread = sumAsk - 1.0`. Fire when `sumAsk < 0.98`.

---

## Algorithm Reference

### GroupResolver — `resolveGroups()`

```
1. getNegRiskMarketsByCondition(db)           → NegRiskMarketRow[]
2. Group by conditionId (Map<string, row[]>)
3. For each group:
   a. clobClient.batchGetBooks(tokenIds)      → OrderBook[]
   b. Map books to NegRiskToken:
      - For each token, walk ask ladder for first ask with size ≥ MIN_NEG_RISK_SIZE (10.0)
        → bestAsk = ladder price, or 1.0 if no tradeable ask
      - For bid: bestBid = bids[0]?.size >= MIN_NEG_RISK_SIZE ? bids[0].price : 0
   c. sumBid = sum(token.bestBid)
   d. sumAsk = sum(token.bestAsk)
   e. isValid = sumBid <= 1.05
             && sumAsk >= 0.95
             && sumAsk <= 1.20
             && tokens.length >= 2
4. Return NegRiskGroup[]
```

### ArbDetector — `evaluate(group: NegRiskGroup)`

```
Guard: if (!group.isValid || group.tokens.length < 2) return []

impliedProb  = group.sumAsk
arbSpread    = impliedProb - 1.0
dominantToken = tokens.reduce(maxByBestAsk)

Cooldown: if (now - lastEmit.get(conditionId) < cooldownMs) return []

signals = []

// --- ARB signal ---
if (arbSpread < config.negRiskArbThreshold) {     // arbThreshold = -0.02
  confidence = min(1.0, abs(arbSpread) / 0.05)
  signals.push(buildArbSignal(dominantToken, group, arbSpread, confidence))
}

// --- OUTLIER signal ---
for each token in group:
  history = getTokenPriceHistory24h(db, token.tokenId)
  if history.length < 5: continue
  mean   = avg(history)
  stddev = populationStddev(history)
  if stddev === 0: continue
  underpricedDev = (mean - token.bestAsk) / stddev    // + = underpriced
  overpricedDev  = (token.bestAsk - mean) / stddev    // + = overpriced

Pick maxDev = max(underpricedDev, overpricedDev) across all tokens
if maxDev > 3.0:
  direction  = underpricedDev >= overpricedDev ? "BULLISH" : "BEARISH"
  confidence = min(1.0, maxDev / 5.0)
  signals.push(buildOutlierSignal(outlierToken, group, maxDev, direction, confidence))

if signals.length > 0:
  lastEmit.set(conditionId, now)   ← shared cooldown

return signals
```

### Analytics CLIs — Arg Parsing Pattern

```ts
// Safe numeric arg parsing (all three CLIs):
const raw = process.argv.find(a => a.startsWith("--days="))?.split("=")[1] ?? "7";
const days = parseInt(raw, 10);
if (!Number.isFinite(days) || days <= 0 || days > 365) {
  console.error("--days must be a positive integer (1–365)");
  process.exit(1);
}
const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
// Pass cutoff as bound parameter to Drizzle / sql`...${cutoff.toISOString()}::timestamptz`
```

---

## Tasks (Atomic, Testable, Ordered)

### Chunk 1 — Type System + Config Foundation (no dependencies)

**Task 1.1 — Extend `src/events/types.ts`**
- Add `"NEG_RISK_ARB"` and `"NEG_RISK_OUTLIER"` to `SignalType` union
- Add both to `SIGNAL_TYPES` readonly array
- Add `NegRiskSignal` interface extending `BaseSignal`:
  ```ts
  export interface NegRiskSignal extends BaseSignal {
    signalType: "NEG_RISK_ARB" | "NEG_RISK_OUTLIER";
    arbSpread?: number;          // for ARB signals
    priceDeviation?: number;     // for OUTLIER signals
    negRiskGroupSize: number;
    negRiskSumBid: number;
    negRiskSumAsk: number;
    conditionIdGroup: string;    // the group conditionId
  }
  ```
- Add `NegRiskSignal` to `Signal` union type (6-way union)
- Add Phase 4+5 fields to `PipelineConfig` interface:
  `negRiskRefreshIntervalMs`, `negRiskArbThreshold`, `negRiskCooldownMs`,
  `dashboardRefreshMs`, `leaderboardMinTrades`, `leaderboardTopN`
- ✅ Test: `pnpm typecheck` passes; `SIGNAL_TYPES.length === 6`

**Task 1.2 — Extend `src/config.ts` + `.env.example`**
- Add 6 new config vars with defaults (see Config Reference)
- Use `envNumber("NEG_RISK_ARB_THRESHOLD", -0.02)` — `Number("-0.02")` parses correctly
- ✅ Test: `src/config.test.ts` additions — each var reads its env var and falls back to default

---

### Chunk 2 — DB Query Extensions (no dependencies)

**Task 2.1 — Add `getNegRiskMarketsByCondition()` to `src/db/queries/markets.ts`**
- Query: `SELECT token_id, condition_id, question, slug FROM markets WHERE neg_risk = true AND closed = false`
- Returns: `NegRiskMarketRow[]` (type defined in query file, imported by GroupResolver)
  ```ts
  export interface NegRiskMarketRow {
    tokenId: string;
    conditionId: string;
    question: string;
    slug: string | null;
  }
  ```
- Application-layer grouping by conditionId (not SQL GROUP BY)
- ✅ Test: `src/db/queries/markets.test.ts` — returns correct rows, empty when no neg-risk markets

**Task 2.2 — Add `getAllWatchlistedTokenIds()` to `src/db/queries/markets.ts`**
- Query: returns all `tokenId` where `watchlisted = true` (no negRisk filter)
- Distinct from existing `getWatchlistedTokenIds` (which may filter negRisk)
- Used by pipeline.ts for `clobWsPool.connect()` so neg-risk tokens get CLOB WS book updates
- ✅ Test: returns both neg-risk and non-neg-risk watchlisted tokens

**Task 2.3 — Add `getTokenPriceHistory24h()` to `src/db/queries/price-history.ts`**
- Query: `price_history` table, `event_type = 'last_trade'` only (not best_bid_ask — too noisy)
- Returns: `Array<{ price: number; recordedAt: Date }>` for last 24h, ordered ASC
- Uses Drizzle `.where(and(eq(priceHistory.eventType, 'last_trade'), gte(priceHistory.recordedAt, cutoff24h)))` — no SQL interval interpolation
- ✅ Test: `src/db/queries/price-history.test.ts` — correct filter, ordering, 24h boundary

---

### Chunk 3 — Neg-Risk Module (`src/neg-risk/`)

**Task 3.1 — `src/neg-risk/group-resolver.ts`**
- Class `GroupResolver`, constructor: `(db: Db, clobClient: ClobRestClient)`
- Method `resolveGroups(): Promise<NegRiskGroup[]>`
- Exports:
  ```ts
  export interface NegRiskToken {
    tokenId: string;
    conditionId: string;
    bestBid: number;
    bestAsk: number;
    question: string;
  }
  export interface NegRiskGroup {
    conditionId: string;
    tokens: NegRiskToken[];
    sumBid: number;
    sumAsk: number;
    isValid: boolean;
  }
  ```
- Algorithm (see Architecture Reference above):
  - Size-aware top-of-book: walk ask/bid ladder for `MIN_NEG_RISK_SIZE = 10.0` guard
  - Validity bounds: `sumBid <= 1.05 && sumAsk >= 0.95 && sumAsk <= 1.20 && tokens.length >= 2`
- Edge cases:
  - Empty book (no asks for a token): `bestAsk = 1.0`, `bestBid = 0`
  - Single-token group: `isValid = false`
  - batchGetBooks returns partial results: missing tokens default to `bestBid=0, bestAsk=1`

**Task 3.2 — `src/neg-risk/arb-detector.ts`**
- Class `ArbDetector`, constructor: `(db: Db, opts?: { arbThreshold?: number; cooldownMs?: number })`
- Method `evaluate(group: NegRiskGroup): Promise<NegRiskSignal[]>`
- Direction-aware outlier (LAW-MAJOR-2 fix): BULLISH for underpriced, BEARISH for overpriced
- All edge cases handled (see Algorithm Reference above):
  - Invalid group: `return []`
  - Price history < 5 points: skip outlier
  - stddev = 0: skip outlier (division guard)
  - cooldown shared per conditionId (both signals suppressed together — acceptable for MVP)
- Signal `tokenId`: ARB uses `dominantToken.tokenId`; OUTLIER uses `outlierToken.tokenId`
- Signal `conditionId`: both use `group.conditionId`

**Task 3.3 — `src/neg-risk/neg-risk-engine.ts`**
- Class `NegRiskEngine`:
  ```ts
  constructor(
    db: Db,
    clobClient: ClobRestClient,
    alertEmitter: AlertEmitter,
    webhookEmitter: WebhookEmitter,
    opts?: { refreshIntervalMs?: number }
  )
  ```
- Private state:
  - `resolver: GroupResolver`
  - `detector: ArbDetector`
  - `groups: Map<ConditionId, NegRiskGroup>`
  - `negRiskTokenIds: Set<string>`
  - `refreshTimer: ReturnType<typeof setInterval> | null`
  - `debounceTimer: ReturnType<typeof setTimeout> | null`
- `start(negRiskTokenIds: string[]): void`
  - Populates `negRiskTokenIds` set, runs immediate `refresh()`, starts interval
- `stop(): void` — clears interval and debounce timer
- `addTokenIds(ids: string[]): void`
  - Adds new IDs to set; triggers debounced `refresh()` (2000ms debounce)
- `handleBookUpdate(evt: BookUpdateEvent): void`
  - Guard: if token not in `negRiskTokenIds` → return
  - Guard: if group not in cache → log debug + return (startup race — LAW-MINOR-4 fix)
  - Partial update: mutate `group.tokens[i].bestBid/bestAsk` for matching tokenId
  - Recompute `group.sumBid` and `group.sumAsk` and `group.isValid`
  - Fire-and-forget `detector.evaluate(group)` → emit signals
- `refresh(): Promise<void>`
  - `resolveGroups()` → update `this.groups` cache
  - For each valid group: `detector.evaluate(group)` → for each signal: insert + alert + webhook
- `private emitAlert(signal: NegRiskSignal): void`
  - Prints `[NEG-RISK] ${signal.signalType} conditionId=${signal.conditionIdGroup} conf=${signal.confidence.toFixed(2)}`

**Task 3.4 — `src/neg-risk/index.ts` (barrel)**
```ts
export { NegRiskEngine } from "./neg-risk-engine.js";
export type { NegRiskGroup, NegRiskToken } from "./group-resolver.js";
```

---

### Chunk 4 — Pipeline Changes (depends on Chunk 3)

**Task 4.1 — Update `src/sources/gamma-poller.ts`**
- Change: `const watchlisted = !isNegRisk;` → `const watchlisted = true;`
- Maintain `negRiskSet.add(tokenId)` for all neg-risk tokens (still tracked for routing)
- Change: neg-risk tokens now also added to `watchlistSet` for ClobWsPool subscription:
  ```ts
  this.watchlistSet.add(tokenId);
  if (isNegRisk) this.negRiskSet.add(tokenId);
  ```
  Remove the `if (isNegRisk) { ... } else { ... }` exclusive branching
- Stats bootstrap for neg-risk tokens: SKIP (neg-risk tokens use cross-book model, not single-token stats)
  Keep bootstrap only for non-neg-risk newly-watchlisted tokens
- ✅ Test: existing GammaPoller tests still pass; add test for neg-risk token having `watchlisted=true`

**Task 4.2 — Update `src/sources/live-data-ws-client.ts`**
- Remove the neg-risk filter block:
  ```ts
  // REMOVE:
  if (this.options.negRiskSet.has(tokenId)) { continue; }
  ```
- Keep the `negRiskSet` field in `options` type (backward-compat — tests that pass it still compile)
- ✅ Test: existing tests pass; add test that neg-risk tokenId trade events are NOT filtered

**Task 4.3 — Update `src/pipeline.ts`**

Routing changes:
- **Trade persistence**: neg-risk trades flow to `tradeBatch.push(trade)` unchanged
- **`tradeHandler1`**: after `tradeBatch.push(trade)`, add:
  ```ts
  if (negRiskSet.has(trade.tokenId)) return;   // signal evaluation only — persistence already done
  ```
- **`tradeHandler2`**: at top of handler:
  ```ts
  if (negRiskSet.has(trade.tokenId)) return;   // neg-risk whale detection skipped
  ```

NegRiskEngine wiring:
```ts
// After gammaPoller.start():
const negRiskEngine = new NegRiskEngine(db, clobClient, alertEmitter, webhookEmitter,
  { refreshIntervalMs: config.negRiskRefreshIntervalMs });
negRiskEngine.start(gammaPoller.getNegRiskIds());

// markets_updated handler — dynamic membership (LAW-MAJOR-4 fix):
gammaPoller.on("markets_updated", (_newTokenIds: TokenId[], newNegRiskIds: TokenId[]) => {
  if (newNegRiskIds.length > 0) {
    negRiskEngine.addTokenIds(newNegRiskIds);
    clobWsPool.addTokenIds(newNegRiskIds);
  }
});

// book_update routing:
const negRiskBookHandler = (evt: BookUpdateEvent) => negRiskEngine.handleBookUpdate(evt);
bus.on("book_update", negRiskBookHandler);
```

ClobWsPool — include neg-risk tokens:
- Use `getAllWatchlistedTokenIds(db)` (new query from Task 2.2) instead of `getWatchlistedTokenIds`
  to pass ALL watchlisted tokens (including neg-risk) to `clobWsPool.connect()`

Shutdown:
```ts
negRiskEngine.stop();
bus.off("book_update", negRiskBookHandler);
```

---

### Chunk 5 — WebhookEmitter Extension (depends on Task 1.1)

**Task 5.1 — Update `src/alerts/webhook-emitter.ts`**
- Add type guard: `isNegRiskSignal(p: Payload): p is NegRiskSignal`
  ```ts
  function isNegRiskSignal(p: Payload): p is NegRiskSignal {
    return !isWhaleAlert(p) &&
      ((p as Signal).signalType === "NEG_RISK_ARB" ||
       (p as Signal).signalType === "NEG_RISK_OUTLIER");
  }
  ```
- Add `buildDiscordNegRiskEmbed(signal: NegRiskSignal): object`:
  ```ts
  {
    embeds: [{
      title: signal.signalType === "NEG_RISK_ARB"
        ? "⚗️ Neg-Risk Arb Detected"
        : "📊 Neg-Risk Outlier Detected",
      description: `Condition: ${signal.conditionIdGroup}`,
      color: 0x9B59B6,  // purple
      fields: [
        { name: "Direction", value: signal.direction, inline: true },
        { name: "Confidence", value: signal.confidence.toFixed(2), inline: true },
        { name: "Group Size", value: String(signal.negRiskGroupSize), inline: true },
        { name: "Sum Ask", value: signal.negRiskSumAsk.toFixed(4), inline: true },
        signal.arbSpread != null
          ? { name: "Arb Spread", value: signal.arbSpread.toFixed(4), inline: true }
          : { name: "Price Deviation", value: (signal.priceDeviation ?? 0).toFixed(2) + "σ", inline: true },
      ],
      timestamp: new Date().toISOString(),
    }]
  }
  ```
- Add `buildSlackNegRiskPayload(signal: NegRiskSignal): object` — mrkdwn text equivalent
- Wire into `buildDiscordPayload()` and `buildSlackPayload()` before the generic fallback
- `Payload` type alias: extend to include `NegRiskSignal`
- ✅ Test: purple color used for both neg-risk types; fallback NOT hit for NEG_RISK_ARB/OUTLIER

---

### Chunk 6 — Analytics CLIs (`src/analytics/`)

All CLIs follow the `backtest/runner.ts` pattern. Scripts: `tsc && node dist/analytics/xxx.js`.

**Task 6.1 — `src/analytics/leaderboard.ts`**
- Argv parsing: `--min-trades N` (default: `config.leaderboardMinTrades`), `--min-volume N`
  (default 10000), `--top N` (default: `config.leaderboardTopN`), `--json`
- Validate: all numeric args are positive finite integers before DB connection
- Query (wallet_profiles only — LAW-MINOR-5 decision, documented in output header):
  ```sql
  SELECT proxy_wallet, total_volume_usdc, trade_count, win_ratio, win_count,
         resolved_trade_count, whale_trade_count
  FROM wallet_profiles
  WHERE trade_count >= $minTrades AND total_volume_usdc >= $minVolume
  ORDER BY win_ratio DESC, total_volume_usdc DESC
  LIMIT $topN
  ```
- Output: ASCII box table with header `# Source: wallet_profiles (enriched by WalletEnricher)`
- If `--json`: write JSON to `analytics-results/leaderboard_{timestamp}.json` AND stdout
- If NOT `--json`: table to stdout, JSON to file only
- Create `analytics-results/` via `fs.mkdirSync(dir, { recursive: true })`
- Pattern: `main()` async function, `getDb()` / `closeDb()` from `src/db/client.ts`

**Task 6.2 — `src/analytics/signal-dashboard.ts`**
- Argv parsing: `--days N` (default 7), `--once`
- Validate days: positive integer, 1–365
- Compute cutoff: `new Date(Date.now() - days * 24 * 60 * 60 * 1000)` — pass as bound param
- Query 1 (per-type counts):
  ```sql
  SELECT signal_type,
         COUNT(*) FILTER (WHERE created_at >= $cutoff24h) AS last_24h,
         COUNT(*) FILTER (WHERE created_at >= $cutoff) AS last_nd,
         AVG(confidence) FILTER (WHERE created_at >= $cutoff) AS avg_conf
  FROM signals WHERE created_at >= $cutoff
  GROUP BY signal_type
  ```
  Where `$cutoff24h = new Date(Date.now() - 86400000)` (computed, not interpolated)
- Query 2 (whale stats last 24h): COUNT, AVG, MAX of `usdc_value`
- Query 3 (largest whale last 24h): top 1 by `usdc_value`
- Render function: formats box table to stdout
- Refresh loop: `setInterval(render, config.dashboardRefreshMs)` when NOT `--once`
  - Clear terminal: `process.stdout.write('\x1b[2J\x1b[H')`
- `--once`: call `render()` once, `closeDb()`, `process.exit(0)`

**Task 6.3 — `src/analytics/heat-map.ts`**
- Argv parsing: `--hours N` (default 24)
- Validate: positive integer, 1–168 (7 days max)
- Compute cutoff: `new Date(Date.now() - hours * 3600 * 1000)` — bound param
- Query:
  ```sql
  SELECT s.token_id, m.question, m.slug,
         COUNT(*)::int AS signal_count,
         COUNT(*) FILTER (WHERE s.signal_type = 'WHALE_TRADE')::int AS whale_count,
         MAX(s.confidence) AS max_conf
  FROM signals s
  LEFT JOIN markets m ON s.token_id = m.token_id
  WHERE s.created_at >= $cutoff
  GROUP BY s.token_id, m.question, m.slug
  ORDER BY signal_count DESC
  LIMIT 20
  ```
- Bar: `"█".repeat(Math.round((count / maxCount) * 8)).padEnd(8, "░")`
- Render and exit (`--once` implicit — heatmap is always a single snapshot)

**Task 6.4 — Update `package.json` scripts**
```json
"leaderboard": "tsc && node dist/analytics/leaderboard.js",
"dashboard": "tsc && node dist/analytics/signal-dashboard.js",
"heatmap": "tsc && node dist/analytics/heat-map.js"
```

**Task 6.5 — Create `analytics-results/.gitkeep`**
- Empty file; add `analytics-results/*.json` to `.gitignore`

---

### Chunk 7 — Tests (Phase 4)

All tests in `src/neg-risk/` colocated with source. All mock DB and HTTP.

**Task 7.1 — `src/neg-risk/group-resolver.test.ts`** (≥ 7 tests)
1. Valid group (3 tokens, sizes all ≥ 10): `sumBid=0.95`, `sumAsk=1.05` → `isValid=true`
2. Invalid group — sumBid > 1.05: tokens with overlapping high bids → `isValid=false`
3. Invalid group — sumAsk > 1.20: `isValid=false` (LAW-MINOR-3 upper bound)
4. Invalid group — single token: `isValid=false`
5. Groups by conditionId: 2 conditionIds → 2 separate groups returned
6. Empty book for one token: defaults to `bestBid=0, bestAsk=1.0`
7. Dust quote filter: ask at top of book but `size < 10` → walk ladder; if no tradeable ask → `bestAsk=1.0`
8. Valid group exactly at bounds: `sumAsk=1.20` → `isValid=true`; `sumAsk=1.21` → `isValid=false`

**Task 7.2 — `src/neg-risk/arb-detector.test.ts`** (≥ 9 tests)
1. ARB signal fires: 3 tokens, `sumAsk=0.90` → `arbSpread=-0.10 < -0.02` → signal emitted
2. ARB signal NOT fired: `sumAsk=0.99` → `arbSpread=-0.01 >= -0.02` → `[]`
3. OUTLIER signal fires (BULLISH): mock 24h history, token underpriced by 4σ → `NEG_RISK_OUTLIER, BULLISH`
4. OUTLIER signal fires (BEARISH): token overpriced by 4σ → `NEG_RISK_OUTLIER, BEARISH`
5. Cooldown suppresses second evaluate() within `cooldownMs` for same conditionId
6. Invalid group (`isValid=false`): `return []` immediately
7. Price history < 5 points: outlier check skipped, only ARB can fire
8. stddev = 0: outlier skipped (division guard)
9. Confidence scaling: `arbSpread=-0.10` → `min(1.0, 0.10/0.05) = 1.0`; deviation=3.5 → `min(1.0, 3.5/5.0)=0.70`
10. Both ARB + OUTLIER can fire in same evaluate() call (two signals in array)

**Task 7.3 — `src/neg-risk/neg-risk-engine.test.ts`** (≥ 6 tests)
1. `handleBookUpdate` re-evaluates correct group (conditionId A re-evaluated; B unchanged)
2. `handleBookUpdate` silently returns when group not yet cached (startup race guard)
3. Alert emitted to console.log on arb detection (spy on emitAlert)
4. WebhookEmitter called with purple embed color `0x9B59B6` on signal
5. `start()` runs immediate `refresh()` (detector.evaluate called after start)
6. `stop()` clears the interval (refresh not called after stop + delay)
7. `addTokenIds()` triggers debounced refresh (new tokens appear in negRiskTokenIds set)

---

### Chunk 8 — Tests (Phase 5)

All tests in `src/analytics/` colocated with source. All mock DB.

**Task 8.1 — `src/analytics/leaderboard.test.ts`** (≥ 5 tests)
1. Correct ranking: wallet A (win_ratio=0.718) ranks above wallet B (win_ratio=0.701)
2. min-trades filter: wallet with `trade_count=3` excluded when `--min-trades=5`
3. min-volume filter: wallet with `total_volume_usdc=5000` excluded when `--min-volume=10000`
4. JSON output shape: result has `proxyWallet`, `totalVolumeUsdc`, `winRatio`, `whaleTrades` fields
5. `--json` flag: JSON goes to stdout (mocked stdout)
6. Arg validation: `--min-trades=abc` → process.exit(1) before DB call

**Task 8.2 — `src/analytics/signal-dashboard.test.ts`** (≥ 4 tests)
1. Correct 24h and 7d counts per signal type (mock signals at different timestamps)
2. Largest whale displays correctly (highest `usdc_value` in 24h window)
3. `--once` flag: `render()` called exactly once, no setInterval, process exits
4. `--days=3`: cutoff computed correctly (Date.now() - 3 * 86400000), passed as bound param

**Task 8.3 — `src/analytics/heat-map.test.ts`** (≥ 4 tests)
1. Correct ranking: market with 23 signals ranks above market with 14
2. Bar length: max-count market gets 8 `█` chars; half-count market gets 4
3. `--hours=12`: signals older than 12h excluded from count
4. Arg validation: `--hours=0` → process.exit(1)

---

### Chunk 9 — Documentation

**Task 9.1 — Update `CLAUDE.md`**
- Add Phase 4+5 status block (target test count, coverage)
- Add `src/neg-risk/` and `src/analytics/` to project structure
- Add `NegRiskEngine`, `GroupResolver`, `ArbDetector` to Key Components
- Add `pnpm leaderboard`, `pnpm dashboard`, `pnpm heatmap` to How to Run
- Add 6 new env vars to Environment Variables table
- Update "Not yet built" section: remove Phase 4 entry

**Task 9.2 — Update `README.md`**
- Architecture diagram: add NegRiskEngine path
- Phase 4+5 feature descriptions
- Config table additions

---

## Execution Order

```
Chunk 1 (1.1 → 1.2)   ← types + config, no deps
Chunk 2 (2.1 → 2.3)   ← DB query extensions (concurrent with Chunk 1)
    ↓
Chunk 3 (3.1 → 3.4)   ← neg-risk module (depends on Chunk 1 types + Chunk 2 queries)
    ↓
Chunk 4 (4.1 → 4.3)   ← pipeline changes (depends on Chunk 3)
Chunk 5 (5.1)          ← WebhookEmitter extension (depends on Chunk 1 types; concurrent with Chunk 4)
Chunk 6 (6.1 → 6.5)   ← analytics CLIs (depends on Chunk 1 config; concurrent with Chunk 4)
    ↓
Chunk 7 (7.1 → 7.3)   ← Phase 4 tests (depends on Chunks 3+4+5)
Chunk 8 (8.1 → 8.3)   ← Phase 5 tests (depends on Chunk 6)
    ↓
Chunk 9 (9.1 → 9.2)   ← docs
```

Commit strategy (per spec):
```
feat: Phase 4 type system (NEG_RISK_ARB, NEG_RISK_OUTLIER signal types + config)
feat: Phase 4 neg-risk group-resolver + arb-detector
feat: Phase 4 neg-risk-engine + pipeline integration
feat: Phase 5 analytics CLIs (leaderboard, dashboard, heatmap)
test: Phase 4 neg-risk tests
test: Phase 5 analytics tests
chore: update docs for Phase 4+5
```

---

## Risks & Mitigations (Final, post-Law review)

| Risk | Mitigation |
|---|---|
| Neg-risk trade persistence accidentally skipped | Early-return placed AFTER `tradeBatch.push(trade)` — persistence always runs (LAW-MAJOR-1) |
| Outlier fires BULLISH for overpriced token | Directional `underpricedDev` / `overpricedDev` split — correct direction per token (LAW-MAJOR-2) |
| Dust quotes trigger false arb signals | Walk ask/bid ladder for first level with `size ≥ MIN_NEG_RISK_SIZE` (10.0) (LAW-MAJOR-3) |
| New neg-risk markets silently missed post-startup | `addTokenIds()` wired to `markets_updated` event; debounced refresh + `clobWsPool.addTokenIds()` (LAW-MAJOR-4) |
| SQL interval interpolation — injection / type error | All CLIs compute JS `Date` cutoff, validate args as finite positive integers, pass as bound params (LAW-MAJOR-5) |
| `sumAsk > 1.20` (egregiously broken book) accepted as valid | Upper bound `sumAsk <= 1.20` in validity check (LAW-MINOR-3) |
| `handleBookUpdate` throws on missing group (startup race) | Guard: if group not in cache → log debug + return (LAW-MINOR-4) |
| Leaderboard join on whale_alerts impractical | Use `wallet_profiles` only (enriched by WalletEnricher) — documented in output and README (LAW-MINOR-5) |
| WebhookEmitter falls back to JSON for neg-risk signals | Explicit `buildDiscordNegRiskEmbed` / `buildSlackNegRiskPayload` added (LAW-NIT-1) |
| `ZSignalType` in signals.ts rejects new types | `SIGNAL_TYPES` in types.ts updated → `ZSignalType` auto-extends (Task 1.1) |
| SignalAggregator rejects neg-risk types from bus | NegRiskEngine bypasses bus/aggregator entirely — inserts directly (LAW-MINOR-2) |
| Pipeline misses neg-risk tokens in ClobWsPool | `getAllWatchlistedTokenIds()` returns all watchlisted including neg-risk (Task 2.2) |

---

## TODO (implementation checklist for Zoro)

### Chunk 1 — Foundation
- [ ] Task 1.1 — extend `src/events/types.ts` (NegRiskSignal, 6-way union, SIGNAL_TYPES, PipelineConfig)
- [ ] Task 1.2 — extend `src/config.ts` + `.env.example` (6 new vars)

### Chunk 2 — DB Queries
- [ ] Task 2.1 — `getNegRiskMarketsByCondition()` in `src/db/queries/markets.ts`
- [ ] Task 2.2 — `getAllWatchlistedTokenIds()` in `src/db/queries/markets.ts`
- [ ] Task 2.3 — `getTokenPriceHistory24h()` in `src/db/queries/price-history.ts`

### Chunk 3 — Neg-Risk Module
- [ ] Task 3.1 — `src/neg-risk/group-resolver.ts` (size-aware, bounded validity)
- [ ] Task 3.2 — `src/neg-risk/arb-detector.ts` (directional outlier, shared cooldown)
- [ ] Task 3.3 — `src/neg-risk/neg-risk-engine.ts` (addTokenIds, debounce, startup guard)
- [ ] Task 3.4 — `src/neg-risk/index.ts` (barrel)

### Chunk 4 — Pipeline Integration
- [ ] Task 4.1 — `src/sources/gamma-poller.ts` (neg-risk watchlisted=true, negRiskSet maintained)
- [ ] Task 4.2 — `src/sources/live-data-ws-client.ts` (remove neg-risk filter)
- [ ] Task 4.3 — `src/pipeline.ts` (tradeHandler guards, NegRiskEngine wiring, markets_updated)

### Chunk 5 — WebhookEmitter
- [ ] Task 5.1 — `src/alerts/webhook-emitter.ts` (purple neg-risk embeds)

### Chunk 6 — Analytics CLIs
- [ ] Task 6.1 — `src/analytics/leaderboard.ts` (wallet_profiles only, bound params, --json)
- [ ] Task 6.2 — `src/analytics/signal-dashboard.ts` (cutoff as bound Date param, --once)
- [ ] Task 6.3 — `src/analytics/heat-map.ts` (bar proportional, cutoff as bound Date param)
- [ ] Task 6.4 — `package.json` scripts (tsc && node dist/... pattern)
- [ ] Task 6.5 — `analytics-results/.gitkeep`

### Chunk 7 — Phase 4 Tests
- [ ] Task 7.1 — `src/neg-risk/group-resolver.test.ts` (≥8 tests incl. dust/bounds)
- [ ] Task 7.2 — `src/neg-risk/arb-detector.test.ts` (≥10 tests incl. directional outlier)
- [ ] Task 7.3 — `src/neg-risk/neg-risk-engine.test.ts` (≥7 tests incl. startup race + addTokenIds)

### Chunk 8 — Phase 5 Tests
- [ ] Task 8.1 — `src/analytics/leaderboard.test.ts` (≥6 tests incl. arg validation)
- [ ] Task 8.2 — `src/analytics/signal-dashboard.test.ts` (≥4 tests incl. bound param cutoff)
- [ ] Task 8.3 — `src/analytics/heat-map.test.ts` (≥4 tests incl. arg validation)

### Chunk 9 — Docs
- [ ] Task 9.1 — `CLAUDE.md`
- [ ] Task 9.2 — `README.md`
