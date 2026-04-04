# Plan: Phase 4 + Phase 5 — Neg-Risk Cross-Book Pricing + Analytics & Observability

## Goal
Ship a fully tested, type-clean implementation of Phase 4 (neg-risk cross-book arb/outlier signal engine) and Phase 5 (wallet leaderboard, signal dashboard, market heat-map CLIs) on branch `feat/phase-4-5`, pushing a PR to `main`. All 414 existing tests must continue to pass. New test count target: ≥470 (add ~56+ new tests). Zero TypeScript errors.

---

## Must-Haves (goal-backward)

- [ ] `NegRiskEngine` produces `NEG_RISK_ARB` and `NEG_RISK_OUTLIER` signals stored in `signals` table
- [ ] `GroupResolver` correctly groups neg-risk tokens by conditionId, validates price sum
- [ ] `ArbDetector` fires on spread < -0.02 and on 3σ outlier, respects per-conditionId cooldown
- [ ] Neg-risk tokens no longer filtered out at ingestion (GammaPoller, LiveDataWsClient, ClobWsPool); they flow to NegRiskEngine instead
- [ ] `WebhookEmitter.send()` handles neg-risk signals with purple color `0x9B59B6`
- [ ] Three analytics CLIs (`leaderboard`, `dashboard`, `heatmap`) runnable via `pnpm` scripts
- [ ] All Phase 4 + Phase 5 tests pass; no regressions in existing 414 tests
- [ ] Config extended with 5 new env vars (Phase 4: 3, Phase 5: 2 meaningful vars)
- [ ] Signal type union in `src/events/types.ts` + `src/validation/schemas.ts` extended with two new types
- [ ] SignalAggregator's `SIGNAL_TYPES` guard updated to allow new types through
- [ ] Docs updated: CLAUDE.md, README.md, `.env.example`

---

## Out of Scope

- No new DB tables (schema.ts is frozen — signals table already handles arbitrary signalType strings)
- No drizzle migrations (schema.ts off-limits)
- `drizzle/` directory untouched
- Phase 1/2/3 source files untouched, **except**: `pipeline.ts`, `config.ts`, `.env.example`, `gamma-poller.ts`, `live-data-ws-client.ts`, `clob-ws-pool.ts`, `validation/schemas.ts`, `events/types.ts`
- No new npm packages (all CLIs use Node.js built-ins + existing deps)
- Real network calls in tests (all mocked)

---

## Architecture Notes & Risk Assessment

### Neg-Risk Pipeline Flow
```
GammaPoller            → upserts neg-risk markets with watchlisted=TRUE now
LiveDataWsClient       → REMOVE neg-risk filter (let trades through)
ClobWsPool             → connect() called with neg-risk token IDs included
pipeline.ts            → NegRiskEngine.handleBookUpdate(evt) on book_update events
NegRiskEngine          → GroupResolver → ArbDetector → signals table + alertEmitter + webhook
```

### Critical Design Decision: GroupResolver uses `batchGetBooks` not DB stats
The spec says `GroupResolver` calls `ClobRestClient.batchGetBooks()` for the group's current prices. This is correct — it's a refresh operation run every 120s and on BookUpdateEvent. It does NOT read from `market_stats` (which may be stale).

### Critical Design Decision: Signal type union must be extensible
`SIGNAL_TYPES` in `events/types.ts` is used by:
1. `SignalAggregator.handleSignal()` — validation guard (rejects unknown types)
2. `insertSignal()` in `signals.ts` — Zod enum validation before insert

Both must be updated to allow `NEG_RISK_ARB` and `NEG_RISK_OUTLIER`. The `Signal` union type must include two new interfaces.

### Risk: Outlier detection needs 24h price history
`ArbDetector` computes σ-deviation of `outlierToken` against its 24h price mean. This requires calling `getRecentPriceHistory()`. Unlike Phase 3 hot-path signals, this runs on a 120s cadence (not every trade), so DB reads are acceptable.

### Risk: GammaPoller neg-risk reversal
Currently `watchlisted = !isNegRisk`. Changing this to `watchlisted = true` for ALL markets (including neg-risk) means neg-risk tokens flow into `ClobWsPool.connect()`. We must ensure `NegRiskEngine` is the only consumer of neg-risk book updates, and existing pipeline logic (WhaleDetector, PriceImpactEvaluator, VelocityEvaluator) does NOT fire on neg-risk tokens. The cleanest approach: keep the existing `negRiskSet` in pipeline.ts for filtering those evaluators; only NegRiskEngine listens to neg-risk book_update events.

Actually re-reading the spec more carefully:
- `GammaPoller`: flip `watchlisted = true` for neg-risk markets
- `LiveDataWsClient`: remove neg-risk filter so trades from neg-risk markets flow through
- `ClobWsPool`: neg-risk tokens included in connect() so book updates arrive
- `NegRiskEngine`: listens to `BookUpdateEvent`, filters to only neg-risk tokens
- Existing processors: add negRisk guard in pipeline.ts tradeHandler1/2 — skip if tokenId is in negRiskSet for whale/velocity/priceImpact signals

### Risk: Analytics CLIs — no `tsx` available
Phase 3's `pnpm backtest` was implemented as `tsc && node dist/...`. The spec suggests `node --import tsx/esm src/analytics/...` but `tsx` is NOT in devDependencies. Must use the same pattern as backtest: `tsc && node dist/analytics/....js`. Alternatively, implement the CLI as pure .ts files that import using `getDb()` from db/client — same as backtest runner.ts. **Decision: follow exact same pattern as `pnpm backtest` — compile then run.**

Actually re-reading `package.json`: the spec says `"node --import tsx/esm src/analytics/..."` — but tsx is not installed and the spec also says "No new packages". **Use the backtest pattern: `tsc && node dist/analytics/leaderboard.js`**. But that breaks `pnpm leaderboard` if the user hasn't built. The compromise: write the analytics files as valid .ts that compile cleanly, and document that `pnpm build` must run first (or wire as `tsc && node dist/...`).

### Risk: SignalAggregator rejects unknown signal types
`handleSignal()` checks `SIGNAL_TYPES.includes(signal.signalType)`. NEG_RISK_ARB and NEG_RISK_OUTLIER will be **rejected** unless `SIGNAL_TYPES` is updated. The `NegRiskSignal` type must be added to the `Signal` union and `SIGNAL_TYPES` must include the new values. `insertSignal()` uses `ZSignalType = z.enum(SIGNAL_TYPES ...)` — must also be regenerated from the extended array.

**BUT**: `ArbDetector` writes signals directly via `insertSignal()` (bypassing the bus), since the spec doesn't say NEG_RISK signals go through the SignalAggregator's signal handler. The NegRiskEngine is a self-contained emitter. This is the safest path — avoids touching SignalAggregator and its guard logic. The `signals` table's `signalType` column is `varchar(40)` with no DB-level constraint; the app-layer Zod check only runs in `insertSignal`. We add the new types to the Zod enum in `insertSignal` so it accepts them.

### Risk: WebhookEmitter.send() signature
`WebhookEmitter.send()` currently accepts `WhaleAlert | Signal`. For Phase 4, we need to send a `NegRiskSignal`. Looking at the implementation, `send()` probably branches on the type. We need to add a `NEG_RISK_ARB` / `NEG_RISK_OUTLIER` branch that produces a purple embed. **The NegRiskEngine calls `webhookEmitter.send(signal)` directly** — same interface as existing signal webhooks.

---

## Tasks

### Chunk 1: Type System + Schema Extensions
**Goal**: Establish type foundation before any implementation.

- [ ] **Task 1.1**: Extend `src/events/types.ts` with new signal types
  - Files: `src/events/types.ts`
  - Add `NEG_RISK_ARB` and `NEG_RISK_OUTLIER` to `SignalType` union and `SIGNAL_TYPES` array
  - Add `NegRiskSignal` interface extending `BaseSignal` with: `arbSpread?: number`, `priceDeviation?: number`, `negRiskGroupSize: number`, `negRiskSumBid: number`, `negRiskSumAsk: number`, `conditionIdGroup: string`
  - Add `NegRiskSignal` to `Signal` union type
  - Outcome: `Signal` type is now a 6-way union; `SIGNAL_TYPES` has 6 values
  - Edge case: `SIGNAL_TYPES as readonly` constraint — update correctly so `z.enum()` in signals.ts still compiles

- [ ] **Task 1.2**: Update `src/validation/schemas.ts` — no change needed
  - `ZSignalType` in `signals.ts` is built from `SIGNAL_TYPES` directly — updating types.ts automatically fixes it
  - But `ZLiveTradeEvent` doesn't need change; neg-risk trades have the same shape
  - Files: `src/validation/schemas.ts` — no change (confirm)
  - Outcome: compile-time check confirms no change needed

### Chunk 2: Config Extension
- [ ] **Task 2.1**: Extend `src/config.ts` with Phase 4 and Phase 5 env vars
  - Files: `src/config.ts`, `.env.example`
  - Add to config object:
    ```ts
    // Phase 4
    negRiskRefreshIntervalMs: envNumber("NEG_RISK_REFRESH_INTERVAL_MS", 120_000),
    negRiskArbThreshold: envNumber("NEG_RISK_ARB_THRESHOLD", -0.02),  // note: negative
    negRiskCooldownMs: envNumber("NEG_RISK_COOLDOWN_MS", 60_000),
    // Phase 5
    dashboardRefreshMs: envNumber("DASHBOARD_REFRESH_MS", 30_000),
    leaderboardMinTrades: envNumber("LEADERBOARD_MIN_TRADES", 5),
    leaderboardTopN: envNumber("LEADERBOARD_TOP_N", 20),
    ```
  - Note: `NEG_RISK_ARB_THRESHOLD=-0.02` — `envNumber` parses negatives correctly (Number("-0.02") = -0.02)
  - Update `.env.example` with Phase 4 and Phase 5 sections
  - Outcome: `config.negRiskRefreshIntervalMs` etc. available; `.env.example` documented

### Chunk 3: DB Query Extensions (Phase 4 needs)
- [ ] **Task 3.1**: Add `getNegRiskMarketsByCondition()` to `src/db/queries/markets.ts`
  - Files: `src/db/queries/markets.ts`
  - Query: `SELECT token_id, condition_id, question, slug, event_slug FROM markets WHERE neg_risk = true AND closed = false`
  - Returns: `NegRiskMarketRow[]` — `{ tokenId, conditionId, question, slug }`
  - Groups by `conditionId` in application layer (not SQL) for clarity
  - Outcome: GroupResolver can fetch the full neg-risk market catalog

- [ ] **Task 3.2**: Add `getTokenPriceHistory24h()` to `src/db/queries/price-history.ts`
  - Files: `src/db/queries/price-history.ts`
  - Query: fetch last 24h of `last_trade_price` events for a tokenId from `price_history` table
  - Returns: `PriceRecord[]` (same as `getRecentPriceHistory` but with 24h cutoff)
  - ArbDetector uses this for σ-deviation calculation of outlier token
  - Outcome: ArbDetector can compute 24h mean/stddev for outlier detection

### Chunk 4: Neg-Risk Module (`src/neg-risk/`)
- [ ] **Task 4.1**: `src/neg-risk/group-resolver.ts`
  - Files: `src/neg-risk/group-resolver.ts`
  - Class `GroupResolver`, constructor: `(db: Db, clobClient: ClobRestClient)`
  - Method `resolveGroups(): Promise<NegRiskGroup[]>`:
    1. Calls `getNegRiskMarketsByCondition(db)` → gets all open neg-risk token rows
    2. Groups by `conditionId` using a `Map<string, NegRiskMarketRow[]>`
    3. For each group, calls `clobClient.batchGetBooks(tokenIds)` to get current books
    4. Maps books to `NegRiskToken[]`: `{ tokenId, conditionId, bestBid, bestAsk, question }`
       - `bestBid = bids[0]?.price ?? 0` (top-of-book bid)
       - `bestAsk = asks[0]?.price ?? 1` (top-of-book ask, default 1 if empty)
    5. Computes `sumBid = sum(token.bestBid)` and `sumAsk = sum(token.bestAsk)`
    6. Validates: `isValid = sumBid <= 1.05 && sumAsk >= 0.95`
    7. Returns `NegRiskGroup[]`
  - Interface `NegRiskGroup`:
    ```ts
    export interface NegRiskToken { tokenId: string; conditionId: string; bestBid: number; bestAsk: number; question: string; }
    export interface NegRiskGroup { conditionId: string; tokens: NegRiskToken[]; sumBid: number; sumAsk: number; isValid: boolean; }
    ```
  - Edge cases:
    - Empty group (0 tokens): return `isValid = false`
    - `batchGetBooks` returns partial results (some tokens missing): use `bestBid=0, bestAsk=1` for missing
    - Single-token group (shouldn't happen, but guard: `isValid = false` if < 2 tokens)
  - Outcome: Returns `NegRiskGroup[]` with validity flags; no side effects

- [ ] **Task 4.2**: `src/neg-risk/arb-detector.ts`
  - Files: `src/neg-risk/arb-detector.ts`
  - Class `ArbDetector`, constructor: `(db: Db, opts?: { arbThreshold?: number; cooldownMs?: number })`
  - Internal state: `lastEmit = new Map<string, number>()` (per conditionId)
  - Method `evaluate(group: NegRiskGroup): Promise<NegRiskSignal[]>`:
    1. Guard: `if (!group.isValid || group.tokens.length < 2) return []`
    2. Compute `impliedProb = sum(bestAsk)` (same as `group.sumAsk`)
    3. Compute `arbSpread = impliedProb - 1.0`
    4. Compute `dominantToken = tokens.reduce(maxByBestAsk)`
    5. Cooldown check per conditionId: `if (now - lastEmit < cooldownMs) return []`
    6. **ARB signal** (if `arbSpread < arbThreshold` where threshold is -0.02):
       - `direction = "BULL"` (buy all outcomes for free money) → actually use `"BULLISH"` per `SignalDirection` type
       - `confidence = min(1.0, abs(arbSpread) / 0.05)`
       - `tokenId = dominantToken.tokenId` (signals table requires a tokenId)
       - `conditionId = group.conditionId`
       - `payload.negRiskGroupSize = group.tokens.length`, `negRiskSumBid = group.sumBid`, `negRiskSumAsk = group.sumAsk`
    7. **OUTLIER signal** (computed independently, same cooldown):
       - `outlierToken = token with max(|price - mean24h| / stddev24h)`
       - Fetch 24h prices via `getTokenPriceHistory24h(db, token.tokenId)` for all tokens (or just top candidates)
       - Compute mean and stddev from price history; if < 5 data points: skip outlier detection
       - `priceDeviation = |token.bestAsk - mean| / stddev`
       - Fire if `priceDeviation > 3.0`
       - `confidence = min(1.0, priceDeviation / 5.0)`
       - `direction = "BULLISH"` (underpriced relative to group)
    8. Set cooldown: `lastEmit.set(conditionId, now)`
    9. Return array of 0, 1, or 2 signals
  - Edge cases:
    - All tokens have same price (stddev = 0): guard division by zero → skip outlier
    - Price history empty for outlier candidate: skip outlier signal
    - Cooldown blocks BOTH signals together (per conditionId, not per signal type)

- [ ] **Task 4.3**: `src/neg-risk/neg-risk-engine.ts` (barrel in `src/neg-risk/index.ts`)
  - Files: `src/neg-risk/neg-risk-engine.ts`, `src/neg-risk/index.ts`
  - Class `NegRiskEngine`:
    ```ts
    constructor(private readonly db: Db, private readonly clobClient: ClobRestClient,
                private readonly alertEmitter: AlertEmitter, private readonly webhookEmitter: WebhookEmitter,
                opts?: { refreshIntervalMs?: number })
    ```
  - Private state:
    - `resolver = new GroupResolver(db, clobClient)`
    - `detector = new ArbDetector(db, { arbThreshold: config.negRiskArbThreshold, cooldownMs: config.negRiskCooldownMs })`
    - `groups = new Map<ConditionId, NegRiskGroup>()` — cached groups, keyed by conditionId
    - `refreshTimer: ReturnType<typeof setInterval> | null`
    - `negRiskTokenIds = new Set<string>()` — for quick lookup in handleBookUpdate
  - Method `start(negRiskTokenIds: string[]): void`:
    - Populates `negRiskTokenIds` set
    - Runs immediate `refresh()` (fire-and-forget with catch)
    - Starts `setInterval(refresh, refreshIntervalMs)`
  - Method `stop(): void`: clears interval
  - Method `refresh(): Promise<void>`:
    - Calls `resolver.resolveGroups()` → updates `this.groups` cache
    - For each group: calls `detector.evaluate(group)` → signals
    - For each signal: calls `insertSignal(db, signal)` + `emitAlert(signal)` + `webhookEmitter.send(signal)`
    - Logs `[NEG-RISK]` prefix on any signal
  - Method `handleBookUpdate(evt: BookUpdateEvent): void`:
    - If `evt.book.tokenId` not in `negRiskTokenIds`: return (filter non-neg-risk updates)
    - Find which group this token belongs to: `this.groups.get(evt.book.conditionId)`
    - If group found: update token's bestBid/bestAsk in the cached group, re-evaluate with detector
    - Emit signals immediately (fire-and-forget)
  - Private `emitAlert(signal: NegRiskSignal): void`:
    - Prints `[NEG-RISK] ${signal.signalType} conditionId=${signal.conditionId} arbSpread=${...} conf=${...}` to stdout
  - `index.ts` barrel: `export { NegRiskEngine } from "./neg-risk-engine.js"; export type { NegRiskGroup, NegRiskToken } from "./group-resolver.js";`

### Chunk 5: Pipeline Integration (Phase 4)
- [ ] **Task 5.1**: Update `src/sources/gamma-poller.ts` — flip neg-risk `watchlisted` to `true`
  - Files: `src/sources/gamma-poller.ts`
  - Change: `const watchlisted = !isNegRisk;` → `const watchlisted = true;` (all active markets watchlisted)
  - Remove: the `if (isNegRisk) { this.negRiskSet.add(tokenId); } else { this.watchlistSet.add(tokenId); }` split
  - Change to: `this.watchlistSet.add(tokenId);` for all tokens, `if (isNegRisk) this.negRiskSet.add(tokenId);`
  - The `negRiskSet` is still maintained (used by pipeline.ts to route neg-risk vs non-neg-risk processing)
  - Update `upsertMarket` call: `watchlisted: true` (always)
  - Outcome: neg-risk tokens have `watchlisted=true` in DB; `negRiskSet` still tracks which are neg-risk

- [ ] **Task 5.2**: Update `src/sources/live-data-ws-client.ts` — remove neg-risk trade filter
  - Files: `src/sources/live-data-ws-client.ts`
  - Remove: `if (this.options.negRiskSet.has(tokenId)) { continue; }`
  - The `negRiskSet` option can remain (no breaking change) but the filter body is removed OR the option is removed if no longer needed
  - **Decision**: Remove the filter logic but keep the option type for backward compat in tests; OR remove option entirely and update tests
  - **Simpler**: Remove the filter block, keep `negRiskSet` field (it's just unused now). Tests that pass a `negRiskSet` still compile.
  - Outcome: All trade events from the WS flow to the bus. Pipeline.ts guards neg-risk trades before whale/signal evaluators.

- [ ] **Task 5.3**: Update `src/pipeline.ts` — wire NegRiskEngine, add neg-risk guards
  - Files: `src/pipeline.ts`
  - Add neg-risk guard to `tradeHandler1` and `tradeHandler2`: skip neg-risk tokenIds for existing evaluators
    ```ts
    // In tradeHandler1:
    if (negRiskSet.has(trade.tokenId)) return; // neg-risk trades routed to NegRiskEngine only
    // In tradeHandler2:
    if (negRiskSet.has(trade.tokenId)) return;
    ```
  - Update `getWatchlistedTokenIds` call to include neg-risk tokens for ClobWsPool:
    - Change `getWatchlistedTokenIds` query to also include neg-risk (or use `getAllWatchlistedTokenIds`)
    - Add new query `getAllWatchlistedTokenIds(db)` that returns `watchlisted=true` regardless of negRisk
    - OR: pass neg-risk token IDs separately: `clobWsPool.connect([...watchlistedTokenIds, ...negRiskTokenIds])`
  - Wire `NegRiskEngine`:
    ```ts
    const negRiskEngine = new NegRiskEngine(db, clobClient, alertEmitter, webhookEmitter, { refreshIntervalMs: config.negRiskRefreshIntervalMs });
    const negRiskTokenIds = await getNegRiskTokenIds(db).catch(() => [] as TokenId[]);
    negRiskEngine.start(negRiskTokenIds);
    ```
  - Wire `book_update` events to NegRiskEngine:
    ```ts
    const negRiskBookHandler = (evt: BookUpdateEvent) => negRiskEngine.handleBookUpdate(evt);
    bus.on("book_update", negRiskBookHandler);
    ```
  - Add to shutdown: `negRiskEngine.stop(); bus.off("book_update", negRiskBookHandler);`
  - Edge case: `NegRiskEngine` must be started after `ClobWsPool.connect()` to avoid race
  - DB query: update `getWatchlistedTokenIds` or add `getAllWatchlistedTokenIds` to return all `watchlisted=true` regardless of negRisk flag

- [ ] **Task 5.4**: Add `getAllWatchlistedTokenIds()` to `src/db/queries/markets.ts`
  - Files: `src/db/queries/markets.ts`
  - New query: returns all `tokenId` where `watchlisted=true` (no negRisk filter)
  - Used by pipeline.ts for `clobWsPool.connect()` so neg-risk tokens get CLOB WS book updates
  - Keep existing `getWatchlistedTokenIds` (non-neg-risk only) for backward compat

### Chunk 6: WebhookEmitter Extension (Phase 4)
- [ ] **Task 6.1**: Update `src/alerts/webhook-emitter.ts` to handle NegRiskSignal
  - Files: `src/alerts/webhook-emitter.ts`
  - Read current `send()` signature. It currently accepts `WhaleAlert | Signal`.
  - Add branch for `signalType === "NEG_RISK_ARB" || signalType === "NEG_RISK_OUTLIER"`:
    - Discord embed color: `0x9B59B6` (purple)
    - Title: `"⚗️ NEG-RISK ARB DETECTED"` or `"📊 NEG-RISK OUTLIER DETECTED"`
    - Description: `conditionId`, `arbSpread` or `priceDeviation`, confidence
  - Outcome: Purple webhook fires on neg-risk signals

### Chunk 7: Analytics CLIs (`src/analytics/`)
Note: All analytics CLIs follow the `backtest/runner.ts` pattern — they import `getDb()`, run queries, print, and exit. Scripts use `tsc && node dist/analytics/xxx.js`.

- [ ] **Task 7.1**: `src/analytics/leaderboard.ts`
  - Files: `src/analytics/leaderboard.ts`
  - CLI entry point (follows runner.ts pattern, same argv parsing style)
  - Query:
    ```sql
    SELECT wp.proxy_wallet, wp.total_volume_usdc, wp.trade_count, wp.win_ratio, 
           wp.win_count, wp.resolved_trade_count,
           COUNT(wa.id) as whale_trade_count
    FROM wallet_profiles wp
    LEFT JOIN whale_alerts wa ON wa.token_id = wp.proxy_wallet -- WRONG: join on wa.token_id
    ```
    Actually: `whale_alerts` doesn't have `proxy_wallet`. Looking at schema: `whale_alerts` has `trade_lookup_key` but NOT `proxy_wallet` directly. The `wallet_profiles` table has `proxy_wallet` as PK. The join must be via `whale_alerts.trade_lookup_key` which encodes `proxyWallet`. This is impractical for SQL JOIN. **Alternative**: join via `trades` table... but trades is partitioned. **Simplest**: use only `wallet_profiles` for the main stats, and count whale_alerts by querying whales separately or just use `wallet_profiles.whale_trade_count` which is maintained by WalletEnricher.
    - Final query: just `wallet_profiles` — use `win_ratio`, `trade_count`, `total_volume_usdc`, `whale_trade_count` columns
    - Filters: `WHERE trade_count >= minTrades AND total_volume_usdc >= minVolume`
    - Order: `ORDER BY win_ratio DESC, total_volume_usdc DESC`
    - Limit: `LIMIT topN`
  - Argv: `--min-trades N`, `--min-volume N`, `--top N`, `--json`
  - Output: ASCII box table (implemented with string padding, no new deps)
  - JSON output: writes to `analytics-results/leaderboard_{timestamp}.json` AND stdout if `--json`
  - Creates `analytics-results/` directory if missing (via `fs.mkdirSync`)
  - Outcome: `pnpm leaderboard` prints ranked wallet table

- [ ] **Task 7.2**: `src/analytics/signal-dashboard.ts`
  - Files: `src/analytics/signal-dashboard.ts`
  - Query 1 (signal counts): 
    ```sql
    SELECT signal_type, 
           COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day') as last_24h,
           COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as last_7d,
           AVG(confidence) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as avg_conf
    FROM signals WHERE created_at > NOW() - INTERVAL '${days} days'
    GROUP BY signal_type
    ```
  - Query 2 (whale stats):
    ```sql
    SELECT COUNT(*) as count_24h, AVG(usdc_value) as avg_size, MAX(usdc_value) as max_size
    FROM whale_alerts WHERE alerted_at > NOW() - INTERVAL '1 day'
    ```
  - Query 3 (largest whale):
    ```sql
    SELECT wa.usdc_value, wa.token_id FROM whale_alerts wa WHERE alerted_at > NOW() - INTERVAL '1 day' ORDER BY usdc_value DESC LIMIT 1
    ```
  - Argv: `--days N` (default 7), `--once`
  - Refresh loop: `setInterval(render, dashboardRefreshMs)` using `config.dashboardRefreshMs`; clears terminal with `process.stdout.write('\x1b[2J\x1b[H')`
  - `--once`: render once and exit (no interval)
  - Outcome: `pnpm dashboard` shows live-refreshing signal counts

- [ ] **Task 7.3**: `src/analytics/heat-map.ts`
  - Files: `src/analytics/heat-map.ts`
  - Query:
    ```sql
    SELECT s.token_id, m.question, m.slug,
           COUNT(*) as signal_count,
           COUNT(*) FILTER (WHERE s.signal_type = 'WHALE_TRADE') as whale_count,
           MAX(s.confidence) as max_conf
    FROM signals s
    LEFT JOIN markets m ON s.token_id = m.token_id
    WHERE s.created_at > NOW() - INTERVAL '${hours} hours'
    GROUP BY s.token_id, m.question, m.slug
    ORDER BY signal_count DESC
    LIMIT 20
    ```
  - Argv: `--hours N` (default 24)
  - Bar: `"█".repeat(Math.round(count / maxCount * 8))`
  - Outcome: `pnpm heatmap` shows top 20 markets by signal density

- [ ] **Task 7.4**: Update `package.json` scripts
  - Files: `package.json`
  - Add:
    ```json
    "leaderboard": "tsc && node dist/analytics/leaderboard.js",
    "dashboard": "tsc && node dist/analytics/signal-dashboard.js",
    "heatmap": "tsc && node dist/analytics/heat-map.js"
    ```
  - Note: `tsc &&` ensures fresh compile; same pattern as `pnpm backtest`
  - Analytics files must NOT have a top-level `await` outside async functions — follow runner.ts pattern

### Chunk 8: Tests (Phase 4)
All tests in `src/neg-risk/` next to source files. All mock DB and HTTP.

- [ ] **Task 8.1**: `src/neg-risk/group-resolver.test.ts`
  - 4 tests minimum:
    1. Valid group: 3 tokens, sumBid ≤ 1.05 (e.g. 0.30+0.35+0.30=0.95), sumAsk ≥ 0.95 → `isValid=true`
    2. Invalid group: sumBid > 1.05 (e.g. 0.40+0.40+0.40=1.20) → `isValid=false`
    3. Groups by conditionId correctly: 2 different conditionIds → 2 separate groups
    4. Empty group: `batchGetBooks` returns [] for a conditionId → `isValid=false`, `tokens=[]`
    5. Missing book for one token: defaulted to `bestBid=0, bestAsk=1` → group still returns

- [ ] **Task 8.2**: `src/neg-risk/arb-detector.test.ts`
  - 5 tests minimum:
    1. ARB signal fires when `sumAsk < 0.98` (spread < -0.02): e.g. 3 tokens with ask prices 0.30+0.30+0.30=0.90 → spread=-0.10 → fires
    2. OUTLIER signal fires when deviation > 3σ: mock price history with mean=0.30, stddev=0.05, token bestAsk=0.15 → dev=3.0 → fires
    3. Cooldown suppresses second call within cooldownMs for same conditionId
    4. No signal when arbSpread >= threshold AND no outlier
    5. Confidence scaling: arbSpread=-0.10 → `min(1.0, 0.10/0.05)=1.0`; outlier deviation=3.5 → `min(1.0, 3.5/5.0)=0.70`
    6. Skips evaluation for invalid group (`isValid=false`)
    7. Price history < 5 points: outlier skipped (no stddev)
    8. stddev = 0: outlier skipped (division guard)

- [ ] **Task 8.3**: `src/neg-risk/neg-risk-engine.test.ts`
  - 3 tests minimum:
    1. `handleBookUpdate` triggers re-evaluation of affected group only (group for conditionId A re-evaluated; group B unchanged)
    2. Alert emitted to stdout on arb detection (spy on `console.log` or the emitAlert method)
    3. WebhookEmitter called with purple color `0x9B59B6` on signal
    4. `start()` calls `refresh()` immediately on startup
    5. `stop()` clears the interval (timer not called after stop)

### Chunk 9: Tests (Phase 5)
All tests in `src/analytics/` next to source files.

- [ ] **Task 9.1**: `src/analytics/leaderboard.test.ts`
  - 4 tests:
    1. Correct ranking by win_ratio DESC (wallet A 71.8% > wallet B 70.1%)
    2. min-trades filter: wallet with trade_count=3 excluded when min=5
    3. min-volume filter: wallet with volume=5000 excluded when min=10000
    4. JSON output shape: has `wallet`, `volume`, `winRate`, `whaleTrades` fields

- [ ] **Task 9.2**: `src/analytics/signal-dashboard.test.ts`
  - 3 tests:
    1. Correct 24h and 7d counts per signal type
    2. Largest whale correct (highest usdc_value in 24h)
    3. `--once` flag: renders once (render function called exactly once, no interval set up)

- [ ] **Task 9.3**: `src/analytics/heat-map.test.ts`
  - 3 tests:
    1. Correct ranking by signal density (market with 23 signals ranks above market with 14)
    2. Bar length proportional to signal count (max 8 chars for highest-count market)
    3. `--hours` flag filters correctly: signals outside window excluded from count

### Chunk 10: Documentation
- [ ] **Task 10.1**: Update `CLAUDE.md`
  - Phase 4 + 5 status block
  - New env vars table entries
  - Test count update (414 + new tests)
  - Add `src/neg-risk/` and `src/analytics/` to project structure
  - Add `pnpm leaderboard`, `pnpm dashboard`, `pnpm heatmap` to "How to Run"

- [ ] **Task 10.2**: Update `README.md`
  - Architecture diagram: add NegRiskEngine path
  - Phase 4 + 5 feature descriptions
  - Config table additions

---

## Execution Order

```
1.  Task 1.1  — extend types.ts (foundation for everything)
2.  Task 2.1  — extend config.ts + .env.example
3.  Task 3.1  — getNegRiskMarketsByCondition()
4.  Task 3.2  — getTokenPriceHistory24h()
5.  Task 5.4  — getAllWatchlistedTokenIds()
6.  Task 4.1  — GroupResolver (depends on 3.1)
7.  Task 4.2  — ArbDetector (depends on 3.2, 4.1)
8.  Task 4.3  — NegRiskEngine (depends on 4.1, 4.2)
9.  Task 6.1  — WebhookEmitter extension (depends on 1.1)
10. Task 5.1  — GammaPoller neg-risk flip
11. Task 5.2  — LiveDataWsClient filter removal
12. Task 5.3  — pipeline.ts integration (depends on 4.3, 5.1, 5.2, 5.4)
13. Task 7.1  — leaderboard.ts
14. Task 7.2  — signal-dashboard.ts
15. Task 7.3  — heat-map.ts
16. Task 7.4  — package.json scripts
17. Task 8.1  — group-resolver.test.ts
18. Task 8.2  — arb-detector.test.ts
19. Task 8.3  — neg-risk-engine.test.ts
20. Task 9.1  — leaderboard.test.ts
21. Task 9.2  — signal-dashboard.test.ts
22. Task 9.3  — heat-map.test.ts
23. Task 10.1 — CLAUDE.md update
24. Task 10.2 — README.md update
```

Commit strategy (per spec):
- `feat: Phase 4 type system (NEG_RISK_ARB, NEG_RISK_OUTLIER signal types + config)`
- `feat: Phase 4 neg-risk group-resolver + arb-detector`
- `feat: Phase 4 neg-risk-engine + pipeline integration`
- `feat: Phase 5 analytics CLIs (leaderboard, dashboard, heatmap)`
- `test: Phase 4 neg-risk tests`
- `test: Phase 5 analytics tests`
- `chore: update docs for Phase 4+5`

---

## Flags for Law (Architecture / Strategy Review)

### LAW-QUESTION-1: neg-risk trade routing in pipeline.ts
Adding `if (negRiskSet.has(trade.tokenId)) return;` to both trade handlers means neg-risk trades are ingested to DB (via `insertTrade`) but skipped by WhaleDetector and signal evaluators. Is this the correct behavior, or should neg-risk trades be entirely dropped before DB insert? The spec says "no longer skip" for CLOB WS book updates, but is silent on LiveDataWsClient trade events for neg-risk. **Assumption**: DB persist (for analytics), but skip whale/signal evaluation. Confirm?

### LAW-QUESTION-2: `analytics-results/` directory creation
`leaderboard.ts` writes JSON to `analytics-results/leaderboard_{ts}.json`. The backtest module uses `backtest-results/`. Should analytics CLIs create `analytics-results/` via `fs.mkdirSync(..., { recursive: true })` at startup? Or is this pre-created by convention? **Assumption**: create at runtime if missing, same as backtest.

### LAW-QUESTION-3: `NEG_RISK_ARB_THRESHOLD` env var sign
The spec sets `NEG_RISK_ARB_THRESHOLD=-0.02`. `envNumber("NEG_RISK_ARB_THRESHOLD", -0.02)` will parse `-0.02` as a negative number correctly. The comparison `arbSpread < config.negRiskArbThreshold` (where threshold = -0.02) means: fire when `(sumAsk - 1.0) < -0.02`, i.e., sumAsk < 0.98. This is correct. Confirm understanding?

### LAW-QUESTION-4: Analytics CLIs compile-before-run vs tsx
Spec says `node --import tsx/esm src/analytics/...` but `tsx` is not installed and no new packages are allowed. Using `tsc && node dist/analytics/...` is the same pattern as `backtest`. However, if TypeScript compilation is slow, this may be painful for a quick analytics check. Should we add tsx as a devDependency exception, or use the compile pattern? **Assumption**: compile pattern (no new deps).

### LAW-QUESTION-5: WebhookEmitter `send()` signature expansion
If `WebhookEmitter.send()` currently accepts `WhaleAlert | Signal`, adding `NegRiskSignal` to `Signal` union (Task 1.1) means it's automatically handled. But if there's a type switch inside `send()` that doesn't have a `default` branch, TypeScript will not catch the missing case. Need to audit `webhook-emitter.ts` to ensure new signal types produce a valid payload (not silently dropped or erroring). **Pre-check needed before Task 6.1.**

---

## TODO (complete checklist)

### Phase 4 — Neg-Risk Cross-Book Pricing
- [ ] Task 1.1 — Extend `src/events/types.ts` (new signal types + NegRiskSignal interface)
- [ ] Task 2.1 — Extend `src/config.ts` + `.env.example` (Phase 4 + 5 vars)
- [ ] Task 3.1 — `getNegRiskMarketsByCondition()` in `src/db/queries/markets.ts`
- [ ] Task 3.2 — `getTokenPriceHistory24h()` in `src/db/queries/price-history.ts`
- [ ] Task 4.1 — `src/neg-risk/group-resolver.ts`
- [ ] Task 4.2 — `src/neg-risk/arb-detector.ts`
- [ ] Task 4.3 — `src/neg-risk/neg-risk-engine.ts` + `src/neg-risk/index.ts`
- [ ] Task 5.1 — Update `src/sources/gamma-poller.ts` (neg-risk watchlisted=true)
- [ ] Task 5.2 — Update `src/sources/live-data-ws-client.ts` (remove neg-risk filter)
- [ ] Task 5.3 — Update `src/pipeline.ts` (NegRiskEngine wiring + guards)
- [ ] Task 5.4 — `getAllWatchlistedTokenIds()` in `src/db/queries/markets.ts`
- [ ] Task 6.1 — Update `src/alerts/webhook-emitter.ts` (purple neg-risk embeds)
- [ ] Task 8.1 — `src/neg-risk/group-resolver.test.ts`
- [ ] Task 8.2 — `src/neg-risk/arb-detector.test.ts`
- [ ] Task 8.3 — `src/neg-risk/neg-risk-engine.test.ts`

### Phase 5 — Analytics & Observability
- [ ] Task 7.1 — `src/analytics/leaderboard.ts`
- [ ] Task 7.2 — `src/analytics/signal-dashboard.ts`
- [ ] Task 7.3 — `src/analytics/heat-map.ts`
- [ ] Task 7.4 — Update `package.json` scripts
- [ ] Task 9.1 — `src/analytics/leaderboard.test.ts`
- [ ] Task 9.2 — `src/analytics/signal-dashboard.test.ts`
- [ ] Task 9.3 — `src/analytics/heat-map.test.ts`

### Documentation
- [ ] Task 10.1 — Update `CLAUDE.md`
- [ ] Task 10.2 — Update `README.md`

---

## Vegapunk's Architecture Review & Board Brief (2026-04-04)

✅ **Approved as-is** — The plan correctly routes neg-risk through `NegRiskEngine`, bypasses the strict `SignalAggregator` guard safely (writing directly via `insertSignal`), and introduces the analytics CLIs following the proven `backtest` pattern.

### Addressed Unknowns & Answers

- **V1 (Group Update)**: *Should `handleBookUpdate` update only the one token's prices in the group cache (partial update, fast), or trigger a full `resolveGroups()` re-fetch?*
  - **Answer**: Partial update. A full `resolveGroups()` calls `batchGetBooks` which makes a network request. `BookUpdateEvent` from WS is zero-latency. Update the token's prices in the cached group and call `detector.evaluate()` immediately.
- **V2 (24h History)**: *Should `getTokenPriceHistory24h()` query `price_history` WHERE `event_type = 'last_trade'` only?*
  - **Answer**: Yes, `event_type = 'last_trade'` only. `best_bid` / `best_ask` events are noisy and don't represent matched value. This gives stable mean/stddev.
- **L1 (Routing)**: *Should neg-risk trades be completely dropped before DB insert?*
  - **Answer**: No. Persist them to `trades` for analytics, but skip signal evaluation as defined in Task 5.3 (`if (negRiskSet.has(trade.tokenId)) return`).
- **L2 (Cooldown)**: *Is it acceptable that `ArbDetector` suppresses both signals on a single conditionId cooldown?*
  - **Answer**: Yes, acceptable for MVP to avoid spamming alerts on a highly volatile condition group.
- **L4 (Bus bypass)**: *Is bypassing the bus signal handler acceptable?*
  - **Answer**: Yes. `NegRiskEngine` acts as an independent subsystem. It evaluates and inserts its own signals directly.

### Additional Recommendations

- `webhook-emitter.ts` has a safe `default` fallback (returns generic embed), ensuring the app doesn't crash before Task 6.1 adds explicit branches.
- Analytics directory `analytics-results/` should be created via `fs.mkdirSync(..., { recursive: true })` on startup to mimic `backtest-results/`.
- Ensure `NEG_RISK_ARB` and `NEG_RISK_OUTLIER` are correctly unioned into `Signal` type so `ZSignalType` safely parses them.

Proceed with Law's strategy review or Zoro's implementation.
