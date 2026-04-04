# Progress Log — polymarket-alpha

## 2026-04-03 — Robin: Phase 2 planning

**Workflow**: Robin research + planning  
**Status**: PLAN.md written, ready for implementation  
**Branch**: `feat/phase-2` (created from main @ 32512fc)

**Key decisions:**
- ClobWsPool is already fully implemented in Phase 1 (not a stub) — Phase 2 only needs pipeline wiring and a `url` option addition
- BookImbalanceEngine is also fully implemented — Phase 2 adds a second trigger path (`book_update` bus event from ClobWsPool) without replacing Phase 1 REST-timer path
- `enrichWhaleAlert` in `whales.ts` lacks `walletFirstSeenAt` — needs safe extension (optional field)
- `wallet_profiles` has no queries layer yet — need new `src/db/queries/wallets.ts`
- `alertId` for WalletEnricher surfaced via `onWhaleInserted` callback on SignalAggregator (clean, non-breaking)
- WebhookEmitter uses `globalThis.fetch` (Node 22 built-in, no new deps)
- All 256 Phase 1 tests confirmed passing on `feat/phase-2` branch before any changes

**Next steps**: Zoro to implement 19 tasks per PLAN.md, one commit per module, push `feat/phase-2` + open PR to main

## 2026-04-03 — Law: Phase 2 plan stress test

**Workflow**: Architecture review / feasibility analysis  
**Verdict**: Approved with changes required to plan before implementation

**Key flags:**
- Current plan underestimates spec drift in `BookImbalanceEngine`: existing engine behavior (5 min debounce, non-spec confidence, strength=ratio) does not satisfy Phase 2 requirements without either refactoring engine or introducing a dedicated WS-path engine.
- `order_book_snapshots` write-back requirement is not covered by the current plan; Phase 2 spec explicitly requires WS-driven imbalance metrics to persist back to snapshots.
- `ClobWsPool` still does not address spec-required `market_resolved` DB closure path, and reconnect behavior lacks the promised jitter.
- Wallet enrichment approach is feasible, but repeated-alert re-enrichment should be deduped/cached to avoid waste and soft rate-limit pressure.

**Next step**: Amend `PLAN.md` before Zoro starts implementation so the build target matches the spec and avoids hidden rework.

## 2026-04-03 — Zoro: Phase 2 implementation complete

**Workflow**: Implementation  
**Status**: DONE ✅  
**Branch**: `feat/phase-2` — pushed to origin, PR open

**Results:**
- **303 tests passing** (34 test files, +47 new tests vs Phase 1's 256)
- **0 type errors** (`tsc --noEmit` clean)
- All 256 Phase 1 tests continue to pass

**Modules implemented (one commit each):**
1. `feat: ClobWsPool sharded WS` — url option, jitter `(0.8–1.2x)` reconnect, `market_resolved` → `markMarketClosed`, new `wallets.ts` queries, `markMarketClosed`, `walletFirstSeenAt` in `enrichWhaleAlert`, Phase 2 config fields
2. `feat: WsBookImbalanceEvaluator` — WS-path evaluator, confidence = `min(1, (ratio-threshold)/threshold)`, strength = total depth, 60s cooldown, `ws_event` snapshot insert on every evaluate
3. `feat: WebhookEmitter` — Discord (color 0xFF4444/0xFFAA00) + Slack Block Kit, 5 req/s token-bucket, 429 retry once, network errors swallowed, AlertEmitter wired (optional, backward-compatible)
4. `feat: WalletEnricher` — async wallet profiling, 24h recency guard, 2 req/s bucket, 5s AbortController timeout, upserts `wallet_profiles`, enriches `whale_alerts`, `SignalAggregator.onWhaleInserted` callback
5. `feat: phase-2 pipeline wiring` — ClobWsPool + WsBookImbalanceEvaluator + WebhookEmitter + WalletEnricher wired; ClobWsPool events forwarded to bus; `book_update` → evaluator; `ORDER_BOOK_IMBALANCE` → webhooks
6. `chore: update docs for Phase 2`

**Architecture notes:**
- Two separate imbalance evaluators with independent `lastEmits` maps — no shared cooldown state between REST and WS paths
- Policy: wallet enrichment only for `emitSignal=true` alerts (persisted alerts only)
- No new npm packages added (token-bucket implemented inline)
2026-04-04 11:41:07 - [VEGAPUNK] Phase 3 architecture reviewed. PLAN.md updated.

## 2026-04-04 — Law: Phase 3 plan stress test

**Workflow**: Architecture review / feasibility analysis  
**Verdict**: CHANGES REQUIRED before implementation

**Key flags:**
- Composite scoring plan cannot satisfy the requirement to enrich all participating signals without either buffering inserts or adding a DB update path for prior signals.
- Backtest runner plan references a non-existent `createDb()` API and a `tsx` runtime that is not currently installed, so the proposed CLI path will fail as written.
- PriceImpact v2 on the trade hot path is exposed to ordering/race issues because `price_history` persistence is asynchronous; the “last 2 DB records” may not include the triggering move.
- SentimentVelocity bootstrap currently seeds price history only; trade-count velocity remains cold after restart and will skew early signals unless trades are also bootstrapped or warm-up is enforced.
- Backtest “recall” is not well-defined from fired signals alone; either redefine the metric or expand the dataset used by the evaluator.

**Next step**: Amend PLAN.md before Zoro starts Phase 3 so the implementation target is internally consistent and testable.
