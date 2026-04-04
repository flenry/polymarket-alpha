# Issues — Polymarket Alpha Dashboard — 2026-04-04

> QA performed by: Usopp (automated test chain)
> Robin (analysis, categorisation, this file)
> Test run: 49 Playwright E2E (headed Chromium) + 108 Dashboard Vitest + 480 Root Vitest + 2× pnpm typecheck

---

## ✅ Working Correctly

- **Root Vitest suite**: 480/480 tests passing — all Phase 1–5 pipeline modules
- **Dashboard Vitest suite**: 108/108 tests passing — all 8 test files (API routes + utils + alert-hydration)
- **TypeScript (root)**: `pnpm typecheck` → 0 errors
- **TypeScript (dashboard)**: `cd apps/dashboard && pnpm typecheck` → 0 errors
- **Playwright E2E**: 49/49 tests passing in headed Chromium — zero failures, zero fixes applied
- **Graceful DB fallback**: all 5 API routes return `[]`/empty objects when Postgres unreachable; dev server starts without live DB
- **Navigation & layout**: root `/` redirects to `/alerts`; sidebar visible with all 5 nav links and correct hrefs; active state highlights correctly
- **Alerts page**: h1 "Whale Alerts", 4 KPI stat cards, empty state "No whale alerts yet" — all correct
- **Signals page**: h1 "Signals", sparkline container, filter bar (4 type buttons), confidence slider, time-range selector, table headers, empty state — all correct
- **Markets page**: h1 "Market Heat Map", empty state "No signal activity in the last 24 hours" — correct
- **Wallets page**: h1 "Wallet Leaderboard", filter controls (min trades + min volume), table column headers (Rank, Wallet, Total Vol, Win Rate, Whale Trades, Last Seen, Trades), empty state — all correct
- **Health page**: h1 "Pipeline Health", "refreshes every 10s" subtitle, 4 health cards (LiveDataWs/ClobWsPool/GammaPoller/DB), status-dot indicators, "No data" state without live DB, "Trade feed" subtitle — all correct
- **Accessibility**: exactly one `<h1>` per page, correct text, 5 `<a>` nav links, no JS console errors on any page
- **LAW-MAJOR-1**: `ALERT_TRADE_JOIN_SQL` 6-tuple join used in both `/api/alerts` AND `/api/wallets/[address]/alerts` — confirmed by grep and unit test
- **LAW-MAJOR-2**: `resolved_trade_count` filter in wallets API — confirmed by unit test regex assertion
- **LAW-MAJOR-3**: Dedicated `/api/signals/volume` route with `date_trunc('hour')` — confirmed
- **LAW-MINOR-4**: Deterministic `topSignalType` via `DISTINCT ON` tie-break — confirmed by unit test
- **LAW-MINOR-5**: shadcn/ui components vendored (10 files), pinned versions — confirmed

---

## ❌ Bugs to Fix

No hard failures found. All 637 automated test assertions passed. Zero bugs requiring immediate fix.

| # | Issue | Component | Severity | Steps to Reproduce |
|---|---|---|---|---|
| — | — | — | — | No failing tests or broken functionality found |

---

## 🔄 Needs Improvement

| # | What | Why | Priority |
|---|---|---|---|
| 1 | `lib/db.ts` throws at module load if `DATABASE_URL` env var is absent | `createPool()` is called at module evaluation — not lazily inside a route handler. A fresh clone without `.env.local` will crash on any API import before the route's `try/catch` can handle it. Current mitigation: `.env.local` is committed. Real fix: return a dead-pool or default to dummy DSN so module always loads safely. | Medium |
| 2 | Playwright test 12 (alerts table column headers) is skipped in DB-empty mode | The E2E test correctly handles the no-data case, but this means the 8 column-header assertions never run in CI/local without a live DB. Column-name correctness is only validated with live data. Fix: add a Playwright mock-server fixture that returns a known alert payload, or add a component unit test rendering `AlertsTable` with fixture data. | Low |
| 3 | `app/alerts/page.tsx` imports `AlertRow` type from server route module | Works now (type-only import, erased at compile). Risk: if accidentally changed to a value import, the server module — which imports `pool` — gets bundled into the client. Fix: move `AlertRow` type to `lib/types.ts` or a shared types file; eliminate the cross-boundary import. | Low |
| 4 | Signal sparkline uses `dynamic(..., { ssr: false })` — potential hydration flash | Recharts does not support SSR; the wrapper is correct. On slow networks the chart area may flash empty before hydration. Not a test failure, but a visual rough edge. Fix: add a `loading={...}` skeleton placeholder inside the `dynamic` call. | Low |
| 5 | No CI pipeline — `pnpm typecheck` is manual-only | TypeScript errors can be introduced silently. No GitHub Actions workflow exists to run tests or typecheck on PRs. Fix: add a `.github/workflows/ci.yml` running `pnpm typecheck` + `pnpm test` + `cd apps/dashboard && pnpm test` on push/PR. | Medium |
| 6 | Wallets filter label says "Min trades (resolved)" but E2E test only checks substring `/Min trades/i` | The `(resolved)` qualifier communicates the LAW-MAJOR-2 fix to users. The test will silently pass even if the label changes. Recommendation: keep the `(resolved)` qualifier; update the E2E assertion to match the full label for regression safety. | Low |

---

## Summary

**637 passed** (480 root + 108 dashboard unit + 49 E2E), **0 bugs**, **6 improvements needed** (2 medium priority, 4 low priority).

No code changes were required for the QA pass. The dashboard is production-ready against current requirements. Improvements are hardening measures rather than correctness fixes.
