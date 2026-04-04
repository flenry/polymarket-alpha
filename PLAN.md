# Plan: Phase 2 — CLOB WS Pool, Imbalance Engine, Webhook Alerts, Wallet Enrichment

> **Board-reviewed v2** — addresses all MAJOR and MINOR findings from Law's code review.
> Supersedes the previous draft. Zoro must follow this version.

## Goal
Fully implement the four Phase 2 modules — `ClobWsPool` (complete), `WsBookImbalanceEvaluator` (new, WS-path only), `WebhookEmitter`, `WalletEnricher` — wire them into the live pipeline, and deliver ≥ 95% test coverage across all new code, with all existing 256 tests continuing to pass.

## Branch
`feat/phase-2` (already created, clean branch from `main` at 32512fc)

## Project Status
**EXISTING project.** Phase 1 is complete: 256 tests passing, 30 test files, schema and migrations locked.

---

## Codebase State (as of Phase 1)

### What is LOCKED — must not change
- `src/db/schema.ts` — complete. Do not touch.
- `drizzle/` — migration files and journal. Locked.
- All Phase 1 files **not listed below** in the allowed edit surface.

### Allowed edit surface (Phase 2 may touch these files)
The following Phase 1 source files **may** be modified in Phase 2:

| File | Permitted change |
|---|---|
| `src/pipeline.ts` | Add ClobWsPool, WsBookImbalanceEvaluator, WebhookEmitter, WalletEnricher wiring |
| `src/config.ts` | Add Phase 2 config fields |
| `.env.example` | Add Phase 2 env vars |
| `src/sources/clob-ws-pool.ts` | Add `url` option, add reconnect jitter, add `market_resolved` handler |
| `src/db/queries/whales.ts` | Extend `enrichWhaleAlert` to include `walletFirstSeenAt` |
| `src/alerts/alert-emitter.ts` | Accept optional `webhookEmitter` for fire-and-forget webhook delivery |
| `src/processors/signal-aggregator.ts` | Add optional `onWhaleInserted` callback for WalletEnricher alertId handoff |

**All other Phase 1 source files are frozen.** `src/processors/book-imbalance-engine.ts` is frozen.

### What's already done
- `ClobWsPool` — fully implemented in Phase 1: sharding, per-shard reconnect, backoff, keepalive, Zod-validated parsing, emits typed local EventEmitter events. **Missing**: jitter on reconnect delay, `market_resolved` handling, `url` option (currently hardcodes WS URL).
- `OrderBookImbalanceEngine` (Phase 1 REST path) — fully implemented, frozen. Uses 5-min debounce + ratio-shift re-emit + Phase 1 confidence formula. **Will NOT be touched or reused for the WS path.**
- `src/config.ts` — already has `clobWsShardSize`, `imbalanceRatioThreshold`, `walletEnrichRps`, `reconnectBaseMs`, `reconnectMaxMs`. Needs Phase 2 additions.
- `src/db/queries/snapshots.ts` — has `insertBookSnapshot()` and `getLatestBook()`. No update path. Phase 2 adds snapshot persistence via new `ws_event` insert (not update).

### What needs to be built from scratch
- `src/processors/ws-book-imbalance-evaluator.ts` — new lightweight WS-only evaluator (does NOT replace `OrderBookImbalanceEngine`)
- `src/alerts/webhook-emitter.ts` — Discord + Slack webhook delivery with token-bucket rate limiting
- `src/enrichment/wallet-enricher.ts` — async wallet profiling via data-api, upserts `wallet_profiles`
- `src/db/queries/wallets.ts` — upsert function for `wallet_profiles` (not yet in queries layer)
- `src/db/queries/markets.ts` (addition) — `markMarketClosed(db, tokenId)` for `market_resolved` handling

---

## Architecture Decisions (Law-reviewed)

### Decision 1: Two separate imbalance evaluators (NOT one reused instance)

**Law finding [MAJOR]:** The Phase 1 `OrderBookImbalanceEngine` uses a 5-min debounce + ratio-shift + different confidence formula. Reusing it for the WS path is spec drift.

**Resolution:** Introduce a **second, lightweight evaluator** for the WS path:
- New file: `src/processors/ws-book-imbalance-evaluator.ts`
- Class: `WsBookImbalanceEvaluator`
- Spec-correct formulas:
  - Confidence: `min(1.0, (ratio - threshold) / threshold)`
  - Strength: total depth (`bidDepthUsdc + askDepthUsdc`)
  - Cooldown: `IMBALANCE_COOLDOWN_MS` (default 60s), simple per-token timestamp check
- Emits `ORDER_BOOK_IMBALANCE` signal (canonical type — see Decision 3) onto the bus
- Also persists a `ws_event` snapshot row via `insertBookSnapshot()` (see Decision 2)
- Phase 1 `OrderBookImbalanceEngine` is **untouched** — continues to serve the REST-timer path

### Decision 2: WS-driven snapshot persistence (NOT an update)

**Law finding [MAJOR]:** The spec requires writing `imbalanceRatio`, `bidDepthUsdc`, `askDepthUsdc` back to `order_book_snapshots`. The current plan had no task for this.

**Resolution:** After each qualifying `book_update` event, `WsBookImbalanceEvaluator.evaluate()` inserts a new `order_book_snapshots` row with `snapshotTrigger = "ws_event"` using the existing `insertBookSnapshot()`. No update path needed — the schema is append-only by design. The REST snapshot is authoritative for Phase 1 queries; the `ws_event` snapshot is supplementary for Phase 2 analytics.

### Decision 3: Canonical signal type is `ORDER_BOOK_IMBALANCE`

**Law finding [MAJOR]:** The old plan said `BOOK_IMBALANCE` in several places. This is wrong.

**Resolution:** All code, comments, and documentation use `ORDER_BOOK_IMBALANCE` exclusively. This matches:
- `src/events/types.ts` SignalType enum
- `src/processors/book-imbalance-engine.ts` existing emit
- DB signal records

### Decision 4: ClobWsPool must-have completions

**Law finding [MAJOR]:** Two behaviors required by spec are missing from Phase 1: jitter on reconnect and `market_resolved` handling.

**Resolution:** As part of Task 5.1, `ClobWsPool` receives:
- **Jitter**: `delay * (0.8 + Math.random() * 0.4)` applied in `scheduleShardReconnect()`
- **`market_resolved`**: parsed in `handleEvent()`, logs + calls `markMarketClosed(db, tokenId)`
- `ClobWsPool` constructor receives optional `db` reference for `market_resolved` updates
- Tests: add assertions for jitter bounds (0.8×–1.2× base delay) and `market_resolved` → DB update

### Decision 5: Wallet enrichment policy — persisted alerts only

**Law finding [MINOR]:** `insertWhaleAlert()` returns `null` when `emitSignal=false`. The plan's `onWhaleInserted` callback approach silently skips enrichment for non-persisted alerts.

**Resolution:** Policy is **explicit**: enrichment only runs for persisted whale alerts (`emitSignal=true`). The `onWhaleInserted` callback fires only when `insertWhaleAlert` returns a non-null ID. Non-persisted alerts (below liquidity threshold) skip enrichment. This is documented in `CLAUDE.md` and in code comments.

### Decision 6: Wallet re-enrichment deduplication guard

**Law finding [NIT]:** Repeated heavy traders will waste API calls and token-bucket budget.

**Resolution:** Before calling the data-api, `WalletEnricher` checks `wallet_profiles.updated_at` (or `enrichedAt` in `whale_alerts`) for a 24h recency guard. If a profile was updated within the last 24h, skip the external fetch and use the cached DB data to still fill `walletTotalVolumeUsdc` / `walletTradeCount` / `walletFirstSeenAt` on the alert row. This is a lightweight DB read before an external API call — worth the saved traffic.

---

## Must-Haves (goal-backward)

- [ ] ClobWsPool is wired into pipeline.ts (runs in parallel with LiveDataWsClient)
- [ ] ClobWsPool has jittered reconnect and handles `market_resolved` → marks `markets.closed=true`
- [ ] `BookUpdateEvent` from ClobWsPool flows to `WsBookImbalanceEvaluator` via bus
- [ ] `WsBookImbalanceEvaluator` fires `ORDER_BOOK_IMBALANCE` signal with spec-correct confidence formula, strength = total depth, 60s cooldown
- [ ] `WsBookImbalanceEvaluator` inserts `ws_event` snapshot row on qualifying book events
- [ ] Phase 1 `OrderBookImbalanceEngine` (REST path) is untouched and all existing tests pass
- [ ] WebhookEmitter sends correctly-shaped Discord + Slack payloads with 5 req/s token-bucket
- [ ] WalletEnricher enriches persisted whale alerts only, async non-blocking, 24h recency guard
- [ ] All new config env vars in `src/config.ts` and `.env.example`
- [ ] All new and modified modules have test coverage meeting spec requirements
- [ ] All 256 existing tests continue to pass
- [ ] Branch `feat/phase-2` pushed to origin with one commit per module

## Out of Scope
- No schema changes (schema is locked)
- No migration file changes
- No Phase 3+ work (backtesting, neg-risk signals)
- No new npm packages (package.json locked to existing deps: ws, zod, drizzle-orm, pg, pino, dotenv)
- Rate limiting: token-bucket must be implemented inline (no new deps)

---

## Critical Implementation Notes for Zoro

### Note 1: Two cooldown maps — no shared state between REST and WS evaluator
The Phase 1 `OrderBookImbalanceEngine` has its own `lastEmits` map for the 5-min REST path. The new `WsBookImbalanceEvaluator` has a separate `lastEmits` map for the 60s WS path. They do NOT share state. Per-path cooldown isolation is critical — the REST path must not suppress WS signals or vice-versa.

### Note 2: `WalletEnricher.enrich()` requires alertId — use `onWhaleInserted` callback
`SignalAggregator` gets the `alertId` from `insertWhaleAlert()`. Surface it via an optional `onWhaleInserted?: (alert: WhaleAlert, id: bigint) => void` callback in `SignalAggregator` constructor. Call it after `insertWhaleAlert` returns a non-null ID. Pipeline wires this callback to `walletEnricher.enrich(alert, id)`.

### Note 3: `enrichWhaleAlert` signature extension is backward-compatible
Add `walletFirstSeenAt?: Date` to the enrichment param type and update the `.set()` call. The field is nullable in schema, so passing `undefined` → `null` is safe. Existing test that omits the field still passes.

### Note 4: WebhookEmitter uses `globalThis.fetch` — Node 22 built-in
No `node-fetch`. No new deps. Tests mock with `vi.stubGlobal('fetch', mockFn)` and restore with `vi.unstubAllGlobals()` in afterEach.

### Note 5: `WsBookImbalanceEvaluator` snapshot insert always happens on qualifying events
Even when cooldown suppresses the signal emit, the snapshot insert still runs (it captures book state regardless). Signal is only emitted when cooldown has elapsed AND ratio is outside threshold band.

### Note 6: `market_resolved` — ClobWsPool needs `db` reference
Pass `db` as optional field in `ClobWsPoolOptions`. When `market_resolved` message arrives: log the resolution, call `markMarketClosed(db, tokenId)` if db is present. If db is absent (tests without DB), log-only fallback.

### Note 7: Enrichment 24h guard implementation
In `WalletEnricher._enrich()`: before fetching the API, query `wallet_profiles` for the proxyWallet. If a row exists and `updated_at > now - 24h`, skip the external fetch — call `enrichWhaleAlert()` directly with the cached `totalVolumeUsdc`, `tradeCount`, `firstSeenAt` from DB. If no row or stale, proceed with API fetch + upsert + enrich.

---

## Tasks

### Chunk 1: Config & env (no deps — do first)

- [ ] **Task 1.1: Extend `src/config.ts` with Phase 2 fields**
  - File: `src/config.ts`
  - Add fields (with defaults):
    - `clobWsUrl: string` (default `"wss://ws-subscriptions-clob.polymarket.com/ws/market"`)
    - `clobWsMaxReconnectDelayMs: number` (default `30000`) — note: `reconnectMaxMs` may already cover this; alias or unify
    - `imbalanceCooldownMs: number` (default `60000`)
    - `discordWebhookUrl: string` (default `""`) — optional, empty = disabled
    - `slackWebhookUrl: string` (default `""`) — optional, empty = disabled
    - `walletEnrichmentTimeoutMs: number` (default `5000`)
    - `walletEnrichmentRateLimitRps: number` (default `2`)
    - `walletEnrichmentRecencyHours: number` (default `24`) — 24h recency guard window
  - Already present (do not re-add): `clobWsShardSize`, `imbalanceRatioThreshold`, `walletEnrichRps`, `reconnectBaseMs`, `reconnectMaxMs`
  - Test guidance: `src/config.test.ts` — add assertions for all new fields with default values and env override

- [ ] **Task 1.2: Update `.env.example`**
  - File: `.env.example`
  - Add all Phase 2 env vars with comments:
    ```
    # Phase 2 — CLOB WS Pool
    CLOB_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
    CLOB_WS_SHARD_SIZE=150
    CLOB_WS_MAX_RECONNECT_DELAY_MS=30000

    # Phase 2 — Book Imbalance (WS path)
    IMBALANCE_RATIO_THRESHOLD=3.0
    IMBALANCE_COOLDOWN_MS=60000

    # Phase 2 — Webhook Alerts
    DISCORD_WEBHOOK_URL=
    SLACK_WEBHOOK_URL=

    # Phase 2 — Wallet Enrichment
    WALLET_ENRICHMENT_TIMEOUT_MS=5000
    WALLET_ENRICHMENT_RATE_LIMIT_RPS=2
    WALLET_ENRICHMENT_RECENCY_HOURS=24
    ```
  - No test needed

### Chunk 2: DB queries — wallet profiles + market close (no deps)

- [ ] **Task 2.1: Create `src/db/queries/wallets.ts`**
  - File: `src/db/queries/wallets.ts`
  - Export: `upsertWalletProfile(db, profile)` — INSERT ... ON CONFLICT (proxy_wallet) DO UPDATE into `wallet_profiles`
  - `profile` shape: `{ proxyWallet: string, totalVolumeUsdc: number, tradeCount: number, whaleTradeCount: number, firstSeenAt: Date, lastSeenAt: Date }`
  - Return type: `Promise<void>`
  - Export: `getWalletProfile(db, proxyWallet)` — returns the existing row or null (for 24h recency check)
  - Test guidance: `src/db/queries/wallets.test.ts`
    - Mock `db.execute` (or use drizzle mock pattern from existing tests)
    - Assert upsert called with correct field mapping
    - Assert ON CONFLICT path sets all fields
    - Assert `getWalletProfile` returns null when no row found

- [ ] **Task 2.2: Create `src/db/queries/markets.ts` addition — `markMarketClosed`**
  - File: `src/db/queries/markets.ts` (may already exist — check first; if so, add to it)
  - Export: `markMarketClosed(db, tokenId: string): Promise<void>` — UPDATE markets SET closed=true WHERE token_id={tokenId}
  - Test guidance: `src/db/queries/markets.test.ts` — mock db, assert update called with correct tokenId

- [ ] **Task 2.3: Extend `enrichWhaleAlert` to include `walletFirstSeenAt`**
  - File: `src/db/queries/whales.ts`
  - Add `walletFirstSeenAt?: Date` to the enrichment parameter type (optional — backward-compatible)
  - Update the `db.update().set()` call to include `walletFirstSeenAt: enrichment.walletFirstSeenAt ?? null`
  - Must not break existing `whales.test.ts` assertions (optional field safe)
  - Test guidance: add one assertion in `whales.test.ts` that when `walletFirstSeenAt` is provided, it is passed through; when omitted, the call still succeeds

### Chunk 3: ClobWsPool completions (dep: Task 2.2)

- [ ] **Task 3.1: Add `url` option + jitter + `market_resolved` to `ClobWsPool`**
  - File: `src/sources/clob-ws-pool.ts`
  - **URL option**: Add `url?: string` to `ClobWsPoolOptions`. Store as `private readonly url: string` in constructor (default `"wss://ws-subscriptions-clob.polymarket.com/ws/market"`). Use `this.url` in `openShard()` instead of hardcoded string.
  - **Jitter**: In `scheduleShardReconnect()`, apply jitter before capping: `const jittered = delay * (0.8 + Math.random() * 0.4); const capped = Math.min(jittered, this.reconnectMaxMs);`. Use `capped` as the actual delay.
  - **`db` option**: Add `db?: Db` to `ClobWsPoolOptions`. Store as `private readonly db: Db | undefined`.
  - **`market_resolved` handling**: In `handleEvent()`, add `case "market_resolved":` — parse `tokenId` from event, log `"ClobWsPool: market resolved"`, call `markMarketClosed(this.db, tokenId)` if `this.db` is defined, emit `"market_resolved"` event with `{ tokenId }`.
  - Test guidance: additions to `src/sources/clob-ws-pool.test.ts`
    - Assert custom URL is passed to `WsConstructor` (Task 5.1 from old plan — now here)
    - Assert jitter: spy on `scheduleShardReconnect`, trigger close 3 times, verify delays are in range `[0.8×base, reconnectMaxMs]` and vary (not identical)
    - Assert `market_resolved`: mock db, send a `market_resolved` message, assert `markMarketClosed` called with correct tokenId
    - Assert `market_resolved` without db: message arrives, no throw, `"market_resolved"` event emitted
  - Existing tests must still pass (all changes backward-compatible — new opts are optional)

### Chunk 4: WsBookImbalanceEvaluator (dep: Tasks 1.1, 2.1)

- [ ] **Task 4.1: Create `src/processors/ws-book-imbalance-evaluator.ts`**
  - File: `src/processors/ws-book-imbalance-evaluator.ts`
  - Class: `WsBookImbalanceEvaluator`
  - Constructor: `(bus: TypedEventBus, db: Db, opts?: { threshold?: number; cooldownMs?: number })`
  - Reads defaults from `config.imbalanceRatioThreshold` and `config.imbalanceCooldownMs`
  - Method: `evaluate(book: OrderBook): void`
    - Compute `bidDepthUsdc = sum(price × size)` for all bids, `askDepthUsdc` for all asks (spec does not restrict to top-N — use full book; leave a TODO if implementer wants to cap)
    - If `askDepthUsdc === 0`: return early
    - `ratio = bidDepthUsdc / askDepthUsdc`
    - **Always** insert `ws_event` snapshot: call `insertBookSnapshot(db, { tokenId, conditionId, bids, asks, bidDepthUsdc, askDepthUsdc, imbalanceRatio: ratio, snapshotTrigger: "ws_event", capturedAt: new Date() })`
    - Check threshold: `isBullish = ratio > threshold`, `isBearish = ratio < 1/threshold`
    - If neither: return (no signal)
    - Check cooldown: `lastEmits.get(tokenId)` — if within `cooldownMs`: return (no signal)
    - Compute signal:
      - `direction`: `"BULLISH"` when bids dominate, `"BEARISH"` when asks dominate
      - `confidence`: `min(1.0, (ratio - threshold) / threshold)` for BULLISH; `min(1.0, (1/ratio - threshold) / threshold)` for BEARISH
      - `strength`: `bidDepthUsdc + askDepthUsdc` (total depth — spec requirement, NOT ratio)
      - `priceAtSignal`: mid = `(bids[0].price + asks[0].price) / 2` if both present, else 0
    - Update `lastEmits.set(tokenId, Date.now())`
    - Build `ImbalanceSignal` with `signalType: "ORDER_BOOK_IMBALANCE"`
    - Call `this.bus.emit("signal", signal)`
  - Private: `lastEmits = new Map<TokenId, number>()` (timestamp only — simpler than Phase 1)
  - Export: `resetCooldown(tokenId: TokenId): void` for test reset
  - **Does NOT replace `OrderBookImbalanceEngine`** — that class is untouched
  - Test guidance: `src/processors/ws-book-imbalance-evaluator.test.ts`
    - Mock bus and db (mock `insertBookSnapshot`)
    - BULL signal: ratio 4.0 > threshold 3.0 → signal emitted with direction BULLISH, confidence = min(1, (4-3)/3) = 0.333
    - BEAR signal: ratio 0.25 < 1/3.0 = 0.333 → signal emitted with direction BEARISH
    - Cooldown: evaluate twice in rapid succession → second call emits no signal (snapshot still inserted)
    - No signal within band: ratio 2.0 (between 0.333 and 3.0) → no signal emitted, snapshot still inserted
    - Strength = total depth: verify `signal.strength === bidDepthUsdc + askDepthUsdc`
    - Confidence formula: verify value matches `min(1.0, (ratio - threshold) / threshold)` precisely
    - `askDepthUsdc === 0` guard: evaluate with empty asks → no signal, no snapshot insert (or insert with null imbalanceRatio — make this explicit in implementation)
    - Verify `insertBookSnapshot` called with `snapshotTrigger: "ws_event"` on every evaluate call (even when no signal fired)
    - Verify `ORDER_BOOK_IMBALANCE` signal type (not `BOOK_IMBALANCE`)

### Chunk 5: WebhookEmitter (dep: Task 1.1)

- [ ] **Task 5.1: Create `src/alerts/webhook-emitter.ts`**
  - File: `src/alerts/webhook-emitter.ts`
  - Class: `WebhookEmitter`
  - Constructor: `(opts?: { discordUrl?: string; slackUrl?: string; rps?: number })`
  - Reads `discordUrl` from `config.discordWebhookUrl` if not passed in opts (same for slack)
  - Method: `async send(payload: WhaleAlert | ImbalanceSignal): Promise<void>` — never throws
  - Internal: token-bucket (max 5 tokens, refill 5/s), in-memory async queue
  - **No-op**: when both `discordUrl` and `slackUrl` are empty/undefined, return immediately without touching `fetch`
  - **Discord payload** (POST to `discordUrl`):
    ```json
    { "embeds": [{ "title": "...", "description": "...", "color": 16729156, "fields": [...], "timestamp": "ISO" }] }
    ```
    - Whale alert: color `0xFF4444` (16729156), fields: market title, value USDC, wallet (truncated to 12 chars + …), sigma score, pct of daily volume
    - Imbalance signal: color `0xFFAA00` (16754176), fields: market (tokenId), ratio, direction, total depth
  - **Slack payload** (POST to `slackUrl`):
    ```json
    { "blocks": [{ "type": "section", "text": { "type": "mrkdwn", "text": "*🐋 Whale Alert*\n..." } }] }
    ```
    - Same data as Discord but formatted as mrkdwn section blocks
  - **Rate limiting**: before each `fetch`, await until a token is available; tokens refill at 5/s via `setInterval`
  - **429 retry**: if response status is 429, wait `Retry-After` header seconds (or 10s) then retry once; if retry also fails, log and move on
  - **Network errors**: catch all errors from `fetch`, log warning via `logger`, swallow (never propagate)
  - Uses `globalThis.fetch` (Node 22 built-in)
  - Test guidance: `src/alerts/webhook-emitter.test.ts`
    - `vi.stubGlobal('fetch', mockFn)` + `vi.unstubAllGlobals()` in afterEach
    - Assert Discord embed shape: whale alert → color `0xFF4444`, expected fields present
    - Assert Slack block shape: imbalance signal → `blocks[0].type === "section"`, text contains direction
    - Assert no-op: empty URLs → `fetch` never called, method resolves immediately
    - Assert rate limit: enqueue 10 sends synchronously, use `vi.useFakeTimers()`, advance < 2 seconds → `fetch` called ≤ 10 times but spaced by token availability
    - Assert 429 retry: mock returns 429 on first call, 200 on second → `fetch` called twice for one `send()`
    - Assert network error: `fetch` throws → method resolves (no propagation), logger.warn called

- [ ] **Task 5.2: Wire WebhookEmitter into `AlertEmitter`**
  - File: `src/alerts/alert-emitter.ts`
  - Add optional `webhookEmitter?: WebhookEmitter` to constructor
  - In `emit(alert)`: after `console.log(formatWhaleAlert(alert))`, call `this.webhookEmitter?.send(alert)` (fire-and-forget — do not await)
  - `AlertEmitter` constructor signature change is backward-compatible (optional param)
  - Must not break existing `alert-emitter.test.ts` (no webhookEmitter → same behavior)
  - Test: add one test: pass a mock webhookEmitter, verify `send()` called after `emit()`

### Chunk 6: WalletEnricher (deps: Tasks 1.1, 2.1, 2.3)

- [ ] **Task 6.1: Create `src/enrichment/wallet-enricher.ts`**
  - File: `src/enrichment/wallet-enricher.ts` (new directory `src/enrichment/`)
  - Class: `WalletEnricher`
  - Constructor: `(db: Db, opts?: { timeoutMs?: number; rps?: number; recencyHours?: number })`
    - `timeoutMs` default: `config.walletEnrichmentTimeoutMs` (5000)
    - `rps` default: `config.walletEnrichmentRateLimitRps` (2)
    - `recencyHours` default: `config.walletEnrichmentRecencyHours` (24)
  - Method: `enrich(alert: WhaleAlert, alertId: bigint): void` — sync return, fire-and-forget
    - Internally calls `this._enrich(alert, alertId).catch(err => logger.warn(...))`
  - Private async: `_enrich(alert: WhaleAlert, alertId: bigint): Promise<void>`
    1. **Recency guard**: `const existing = await getWalletProfile(db, alert.trade.proxyWallet)`
       - If `existing` and `existing.updatedAt > Date.now() - recencyHours * 3600_000`:
         - Skip API fetch; call `enrichWhaleAlert(db, alertId, { walletTotalVolumeUsdc: existing.totalVolumeUsdc, walletTradeCount: existing.tradeCount, walletFirstSeenAt: existing.firstSeenAt })`; return
    2. **Rate limit**: await token from token-bucket (max `rps` tokens, refill at `rps`/s)
    3. **Fetch with timeout**: `AbortController` with `timeoutMs`; fetch `https://data-api.polymarket.com/activity?user={proxyWallet}&limit=100`
    4. **429 handling**: if response status 429, wait `Retry-After` header value (or 10s), retry once; if still 429, log and return
    5. **Parse**: parse response as `ZDataApiTrade[]` (existing Zod schema)
    6. **Compute stats**:
       - `totalVolumeUsdc = sum(trade.size * trade.price)`
       - `tradeCount = trades.length`
       - `whaleTradeCount = trades.filter(t => t.size * t.price > 10_000).length`
       - `firstSeenAt = new Date(Math.min(...trades.map(t => t.timestamp)) * 1000)`
       - `lastSeenAt = new Date(Math.max(...trades.map(t => t.timestamp)) * 1000)`
       - Edge case: empty array → all zeros, `firstSeenAt = lastSeenAt = new Date(0)`
    7. **Upsert**: `await upsertWalletProfile(db, { proxyWallet, totalVolumeUsdc, tradeCount, whaleTradeCount, firstSeenAt, lastSeenAt })`
    8. **Enrich alert**: `await enrichWhaleAlert(db, alertId, { walletTotalVolumeUsdc, walletTradeCount, walletFirstSeenAt: firstSeenAt })`
    9. On `AbortError`: log warning `"WalletEnricher: timeout"`, return without DB writes
    10. On any other error: log warning, return without DB writes
  - `proxyWallet` truncation: if length > 42, log warning and truncate (schema `varchar(42)`)
  - Test guidance: `src/enrichment/wallet-enricher.test.ts`
    - Mock `globalThis.fetch` with `vi.stubGlobal`
    - Mock `upsertWalletProfile` and `enrichWhaleAlert` (vi.mock or manual mock)
    - Happy path: 5 trades including 2 > $10k → assert `upsertWalletProfile` called with `whaleTradeCount=2`, `enrichWhaleAlert` called with `walletFirstSeenAt`
    - 429: first call returns 429 with `Retry-After: 1`, second returns 200 with data → two fetch calls, upsert called
    - Timeout: `fetch` hangs (never resolves), AbortController fires after `timeoutMs` → `_enrich` resolves, no DB calls
    - Recency guard hit: mock `getWalletProfile` returns row with `updatedAt` = 1h ago → fetch NOT called, `enrichWhaleAlert` called with cached data
    - Recency guard miss: `getWalletProfile` returns row with `updatedAt` = 25h ago → fetch called
    - Empty trades: `fetch` returns `[]` → upsert called with zeros, enrich called
    - `enrich()` never throws: even if `_enrich` rejects, outer `enrich()` catches and returns

- [ ] **Task 6.2: Add `onWhaleInserted` callback to `SignalAggregator`**
  - File: `src/processors/signal-aggregator.ts`
  - Add optional `onWhaleInserted?: (alert: WhaleAlert, id: bigint) => void` to constructor options
  - In `handleWhaleAlert()`, after `insertWhaleAlert` returns a non-null `id`: call `this.onWhaleInserted?.(alert, id)`
  - Call happens AFTER the DB write (both transaction and non-transaction paths)
  - Must not break existing `signal-aggregator.test.ts` (optional param → no-op when absent)
  - Test: add assertion that `onWhaleInserted` is called with correct `(alert, id)` after successful insert; not called when `emitSignal=false`

### Chunk 7: Pipeline wiring (deps: all chunks 1–6)

- [ ] **Task 7.1: Wire Phase 2 in `src/pipeline.ts`**
  - File: `src/pipeline.ts`
  - Add imports: `ClobWsPool`, `WsBookImbalanceEvaluator`, `WalletEnricher`, `WebhookEmitter`
  - Add import: `markMarketClosed` from `../db/queries/markets.js`
  - Add import: `getWatchlistedTokenIds` (check if already present — if not, add to markets queries)
  - **Instantiate**:
    ```typescript
    const webhookEmitter = new WebhookEmitter();
    const walletEnricher = new WalletEnricher(db);
    const clobWsPool = new ClobWsPool({
      url: config.clobWsUrl,
      shardSize: config.clobWsShardSize,
      reconnectBaseMs: config.reconnectBaseMs,
      reconnectMaxMs: config.reconnectMaxMs,
      db,
    });
    const wsImbalanceEvaluator = new WsBookImbalanceEvaluator(bus, db);
    ```
  - **Update AlertEmitter**: pass `webhookEmitter` to `AlertEmitter` constructor
  - **Update SignalAggregator**: pass `onWhaleInserted: (alert, id) => walletEnricher.enrich(alert, id)` in constructor
  - **Wire ClobWsPool local events → bus**:
    ```typescript
    clobWsPool.on("book", (evt) => bus.emit("book_update", evt));
    clobWsPool.on("price_change", (evt) => bus.emit("price_change", evt));
    clobWsPool.on("best_bid_ask", (evt) => bus.emit("best_bid_ask", evt));
    clobWsPool.on("last_trade_price", (evt) => bus.emit("last_trade_price", evt));
    ```
  - **Wire `book_update` → `WsBookImbalanceEvaluator`**:
    ```typescript
    const bookUpdateHandler = (evt: BookUpdateEvent) => wsImbalanceEvaluator.evaluate(evt.book);
    bus.on("book_update", bookUpdateHandler);
    ```
  - **Wire `signal` (ORDER_BOOK_IMBALANCE) → WebhookEmitter**:
    ```typescript
    const imbalanceWebhookHandler = (signal: Signal) => {
      if (signal.signalType === "ORDER_BOOK_IMBALANCE") webhookEmitter.send(signal);
    };
    bus.on("signal", imbalanceWebhookHandler);
    ```
  - **Start ClobWsPool**: after GammaPoller starts and watchlisted token IDs are loaded:
    ```typescript
    const tokenIds = await getWatchlistedTokenIds(db);
    await clobWsPool.connect(tokenIds);
    ```
  - **Shutdown cleanup**: add to `shutdown()`:
    ```typescript
    clobWsPool.disconnect();
    bus.off("book_update", bookUpdateHandler);
    bus.off("signal", imbalanceWebhookHandler);
    ```
  - No test file for pipeline.ts (integration-level — covered by existing pipeline test if it exists, else skip)

### Chunk 8: Tests (alongside or after each module)

- [ ] **Task 8.1**: `src/alerts/webhook-emitter.test.ts` — see Task 5.1 guidance
- [ ] **Task 8.2**: `src/enrichment/wallet-enricher.test.ts` — see Task 6.1 guidance
- [ ] **Task 8.3**: `src/db/queries/wallets.test.ts` — see Task 2.1 guidance
- [ ] **Task 8.4**: `src/db/queries/markets.test.ts` — see Task 2.2 guidance (add `markMarketClosed` test)
- [ ] **Task 8.5**: Additions to `src/sources/clob-ws-pool.test.ts` — see Task 3.1 guidance (URL, jitter, market_resolved)
- [ ] **Task 8.6**: Additions to `src/db/queries/whales.test.ts` — see Task 2.3 guidance (walletFirstSeenAt)
- [ ] **Task 8.7**: Additions to `src/config.test.ts` — see Task 1.1 guidance (new Phase 2 fields)
- [ ] **Task 8.8**: `src/processors/ws-book-imbalance-evaluator.test.ts` — see Task 4.1 guidance
- [ ] **Task 8.9**: Additions to `src/alerts/alert-emitter.test.ts` — see Task 5.2 guidance (webhookEmitter wired)
- [ ] **Task 8.10**: Additions to `src/processors/signal-aggregator.test.ts` — see Task 6.2 guidance (onWhaleInserted callback)

### Chunk 9: Docs & commit

- [ ] **Task 9.1: Update `CLAUDE.md`**
  - Add Phase 2 modules to Current State section
  - Add new env vars table
  - Add note about two separate imbalance evaluators and their distinct trigger paths

- [ ] **Task 9.2: Commit sequence per spec**
  ```
  feat: ClobWsPool sharded WS        (Task 3.1 + Task 8.5)
  feat: WsBookImbalanceEvaluator      (Task 4.1 + Task 8.8 + snapshot persistence)
  feat: WebhookEmitter                (Tasks 5.1, 5.2, 8.1, 8.9)
  feat: WalletEnricher                (Tasks 2.1, 2.2, 2.3, 6.1, 6.2, 8.2, 8.3, 8.4, 8.6, 8.10)
  feat: phase-2 pipeline wiring       (Task 7.1)
  chore: update docs for Phase 2      (Task 9.1 + Tasks 1.1, 1.2, 8.7)
  ```

- [ ] **Task 9.3: Push `feat/phase-2` and open PR to `main`**

---

## Execution Order

```
1.1 → 1.2                           (config first — no deps)
2.1 → 2.2 → 2.3                     (DB queries — no deps, parallel with 1.x)
3.1                                  (ClobWsPool completions — dep: 2.2 for markMarketClosed)
4.1                                  (WsBookImbalanceEvaluator — dep: 1.1, 2.1)
5.1 → 5.2                           (WebhookEmitter — dep: 1.1)
6.1 → 6.2                           (WalletEnricher — dep: 1.1, 2.1, 2.3)
7.1                                  (pipeline wiring — dep: all above)
8.x                                  (tests alongside each module)
9.x                                  (docs + commits last)
```

Parallel tracks (can be done concurrently by different agents):
- Track A: 1.1 → 1.2 → 5.1 → 5.2 (config + webhooks)
- Track B: 2.1 → 2.2 → 2.3 → 6.1 → 6.2 (DB + wallet enrichment)
- Track C: 3.1 → 4.1 (ClobWsPool + WS evaluator)
- Track D: 7.1 (pipeline wiring — waits for all tracks)

---

## Risks & Mitigations (Law-reviewed)

| Risk | Severity | Status | Mitigation |
|---|---|---|---|
| Phase 1 `OrderBookImbalanceEngine` reused for WS path causes spec drift (confidence formula, strength, cooldown) | **MAJOR** | ✅ Resolved | New `WsBookImbalanceEvaluator` class, existing engine frozen |
| WS-driven imbalance metrics not persisted to `order_book_snapshots` | **MAJOR** | ✅ Resolved | `WsBookImbalanceEvaluator.evaluate()` always calls `insertBookSnapshot()` with `snapshotTrigger: "ws_event"` |
| `ClobWsPool` missing jitter and `market_resolved` handler | **MAJOR** | ✅ Resolved | Task 3.1 adds jitter and `market_resolved` → `markMarketClosed()` |
| Plan uses wrong signal name `BOOK_IMBALANCE` instead of `ORDER_BOOK_IMBALANCE` | **MAJOR** | ✅ Resolved | All occurrences corrected to `ORDER_BOOK_IMBALANCE` throughout |
| `onWhaleInserted` callback silently skips non-persisted alerts | **MINOR** | ✅ Resolved | Explicit policy: enrichment only for `emitSignal=true` alerts; documented in code and CLAUDE.md |
| "Must NOT change" list inconsistent with actual edit surface | **MINOR** | ✅ Resolved | Allowed edit surface table in Codebase State section replaces blanket prohibition |
| Wallet re-enrichment of heavy traders wastes API quota | **NIT** | ✅ Resolved | 24h recency guard in `WalletEnricher._enrich()` — skips fetch if profile updated within 24h |
| `walletFirstSeenAt` not in `enrichWhaleAlert` | Medium | ✅ Resolved | Task 2.3 adds it as optional field (backward-compatible) |
| `alertId` for `WalletEnricher` requires aggregator callback | Medium | ✅ Resolved | `onWhaleInserted` callback in Task 6.2 |
| `fetch` global in tests | Low | ✅ Resolved | `vi.stubGlobal` + `vi.unstubAllGlobals()` in afterEach — standard pattern |
| Rate limiter timing in tests | Low | ✅ Resolved | Use `vi.useFakeTimers()` for token-bucket refill assertions |
| Shared cooldown state if REST + WS both use same engine instance | Medium | ✅ Resolved | Two separate evaluators with independent `lastEmits` maps |

---

## Signal Type Reference (canonical — do not drift)

| Signal type | String literal | Source path | Evaluator |
|---|---|---|---|
| Whale trade | `"WHALE_TRADE"` | Live WS + data-api | `WhaleDetector` (Phase 1) |
| Book imbalance | `"ORDER_BOOK_IMBALANCE"` | REST timer (Phase 1) | `OrderBookImbalanceEngine` (Phase 1, frozen) |
| Book imbalance | `"ORDER_BOOK_IMBALANCE"` | WS book event (Phase 2) | `WsBookImbalanceEvaluator` (Phase 2, new) |
| Price impact | `"PRICE_IMPACT_ANOMALY"` | Phase 3+ | — |
| Sentiment velocity | `"SENTIMENT_VELOCITY"` | Phase 3+ | — |

**Both imbalance paths emit `ORDER_BOOK_IMBALANCE` — they share the same signal type and DB record format. The trigger path is distinguished by `order_book_snapshots.snapshot_trigger` (`"rest_timer"` vs `"ws_event"`).**

---

## TODO
- [ ] Task 1.1 — Extend `src/config.ts`
- [ ] Task 1.2 — Update `.env.example`
- [ ] Task 2.1 — Create `src/db/queries/wallets.ts`
- [ ] Task 2.2 — Create `markMarketClosed` in markets queries
- [ ] Task 2.3 — Extend `enrichWhaleAlert` for `walletFirstSeenAt`
- [ ] Task 3.1 — ClobWsPool: url option + jitter + market_resolved
- [ ] Task 4.1 — Create `src/processors/ws-book-imbalance-evaluator.ts`
- [ ] Task 5.1 — Create `src/alerts/webhook-emitter.ts`
- [ ] Task 5.2 — Wire WebhookEmitter into AlertEmitter
- [ ] Task 6.1 — Create `src/enrichment/wallet-enricher.ts`
- [ ] Task 6.2 — Add `onWhaleInserted` to SignalAggregator
- [ ] Task 7.1 — Wire Phase 2 in pipeline.ts
- [ ] Task 8.1 — `webhook-emitter.test.ts`
- [ ] Task 8.2 — `wallet-enricher.test.ts`
- [ ] Task 8.3 — `wallets.test.ts` (queries)
- [ ] Task 8.4 — `markets.test.ts` (markMarketClosed)
- [ ] Task 8.5 — `clob-ws-pool.test.ts` additions (URL, jitter, market_resolved)
- [ ] Task 8.6 — `whales.test.ts` additions (walletFirstSeenAt)
- [ ] Task 8.7 — `config.test.ts` additions (Phase 2 fields)
- [ ] Task 8.8 — `ws-book-imbalance-evaluator.test.ts`
- [ ] Task 8.9 — `alert-emitter.test.ts` additions (webhookEmitter)
- [ ] Task 8.10 — `signal-aggregator.test.ts` additions (onWhaleInserted)
- [ ] Task 9.1 — Update CLAUDE.md
- [ ] Task 9.2 — Commit sequence
- [ ] Task 9.3 — Push + open PR
