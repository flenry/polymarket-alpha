# Polymarket Alpha — Status

Last updated: 2026-04-04

---

## Phase 1–5: Pipeline ✅ Complete

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Core pipeline, DB schema, Drizzle migrations | ✅ Done — 256 tests |
| 2 | ClobWsPool, WsBookImbalanceEvaluator, WebhookEmitter, WalletEnricher | ✅ Done — 357 tests |
| 3 | PriceImpactSignalEvaluator v2, SentimentVelocityEvaluator v2, SignalAggregator composite scoring, backtesting | ✅ Done — 414 tests |
| 4+5 | NegRiskEngine, GroupResolver, ArbDetector, analytics CLIs (leaderboard/dashboard/heatmap) | ✅ Done — 480 tests |

**Root test suite**: 480/480 passing, 97.33% stmt / 95.91% branch coverage.

---

## Phase 6: Dashboard ✅ Complete — QA Confirmed

| Feature | Status | QA Note |
|---------|--------|---------|
| Monorepo `pnpm-workspace.yaml` | ✅ Done | ✅ QA confirmed — `apps/*` and `.` present |
| `apps/dashboard/` Next.js 14 + Tailwind + shadcn/ui + strict TS | ✅ Done | ✅ QA confirmed — `pnpm typecheck` 0 errors |
| DB connection layer (`lib/db.ts` singleton pool) | ✅ Done | ✅ QA confirmed — globalThis guard present; graceful on offline DB |
| `lib/alert-hydration.ts` — 6-tuple JOIN (LAW-MAJOR-1) | ✅ Done | ✅ QA confirmed — used in both alerts routes |
| `lib/utils.ts` — `formatUSDC`, `formatAddress`, `timeAgo`, `cn` | ✅ Done | ✅ QA confirmed — 108 dashboard tests passing |
| `/api/alerts` — hours filter, limit, LAW-MAJOR-1 join | ✅ Done | ✅ QA confirmed — unit tested |
| `/api/signals` — types filter, minConfidence, tokenId | ✅ Done | ✅ QA confirmed — unit tested |
| `/api/signals/volume` — `date_trunc('hour')` GROUP BY (LAW-MAJOR-3) | ✅ Done | ✅ QA confirmed — separate route, unit tested |
| `/api/markets` — deterministic topSignalType (LAW-MINOR-4) | ✅ Done | ✅ QA confirmed — tie-break unit tested |
| `/api/wallets` — `resolved_trade_count` filter (LAW-MAJOR-2) | ✅ Done | ✅ QA confirmed — filter asserted in unit test |
| `/api/wallets/[address]/alerts` — uses ALERT_TRADE_JOIN_SQL | ✅ Done | ✅ QA confirmed — grep verified `ALERT_TRADE_JOIN_SQL` import |
| `/api/health` — 6 DB queries, null safety | ✅ Done | ✅ QA confirmed — unit tested |
| 5 pages (alerts/signals/markets/wallets/health) + SWR polling | ✅ Done | ✅ QA confirmed — 49/49 E2E tests passing (headed Chromium) |
| shadcn/ui components vendored, pinned versions (LAW-MINOR-5) | ✅ Done | ✅ QA confirmed — 10 component files present |
| Playwright E2E suite (49 tests) | ✅ Done | ✅ QA confirmed — 49/49 pass, 0 failures |
| Dashboard Vitest suite (108 tests, 8 files) | ✅ Done | ✅ QA confirmed — 108/108 pass |

### Known Issues (from QA — no blockers)

| # | Item | Severity | File |
|---|------|----------|------|
| 1 | `lib/db.ts` throws if `DATABASE_URL` absent at module load time | Medium | `apps/dashboard/lib/db.ts` — needs fix |
| 2 | Playwright test 12 (alert table headers) skipped in DB-empty mode | Low | `apps/dashboard/e2e/dashboard.spec.ts` — needs mock fixture |
| 3 | `AlertRow` type imported from server route into client page | Low | `apps/dashboard/app/alerts/page.tsx` — move to `lib/types.ts` |
| 4 | Signal sparkline hydration flash (no skeleton) | Low | `apps/dashboard/components/signal-sparkline.tsx` |
| 5 | No CI pipeline | Medium | Missing `.github/workflows/ci.yml` |
| 6 | E2E wallets filter label assertion is substring-only | Low | `apps/dashboard/e2e/dashboard.spec.ts` test 26 |

---

## Branches

| Branch | Status |
|--------|--------|
| `main` | ✅ Phases 1–5 complete, Phase 6 dashboard complete |
| `feat/dashboard` | ✅ Merged to main |
| `feat/phase-4-5` | ✅ Complete |
| `feat/phase-3` | ✅ Complete |
| `feat/phase-2` | ✅ Complete |
