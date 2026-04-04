# TEST-PLAN.md — Polymarket Alpha Dashboard
> Produced by Robin (research/planning). Last updated: 2026-04-04.
> Status as of this plan: **All 49 Playwright E2E tests PASS** (run in headed Chromium, 2026-04-04).

---

## 1. Automated Tests

### 1A. Dashboard Unit Tests (Vitest)

| File | What it covers | Run command |
|------|---------------|-------------|
| `apps/dashboard/__tests__/utils.test.ts` | `formatUSDC`, `formatAddress`, `timeAgo`, `cn` — all edge cases (null, undefined, boundary values) | `cd apps/dashboard && pnpm test` |
| `apps/dashboard/__tests__/alert-hydration.test.ts` | Regression guard on LAW-MAJOR-1: asserts `ALERT_TRADE_JOIN_SQL` uses all 6 split_part fields (full-tuple join, not 2-field) | `cd apps/dashboard && pnpm test` |
| `apps/dashboard/__tests__/api-alerts.test.ts` | `/api/alerts` route handler: default params, hours filter, empty result → `{alerts:[],total:0}`, invalid hours → 400, limit clamped to 500, SQL contains `split_part(...,'|',3)` | `cd apps/dashboard && pnpm test` |
| `apps/dashboard/__tests__/api-signals.test.ts` | `/api/signals` route: types filter (valid/invalid → 400), minConfidence clamp, tokenId filter, default 200 limit | `cd apps/dashboard && pnpm test` |
| `apps/dashboard/__tests__/api-signals-volume.test.ts` | `/api/signals/volume` route: `date_trunc('hour',...)` grouping, empty window → `{buckets:[]}`, hours param pass-through, hours > 168 clamped | `cd apps/dashboard && pnpm test` |
| `apps/dashboard/__tests__/api-markets.test.ts` | `/api/markets` route: hours filter, empty signals → `{markets:[]}`, tie-breaking test (equal counts → lexical winner wins), no matching market row (null question) | `cd apps/dashboard && pnpm test` |
| `apps/dashboard/__tests__/api-wallets.test.ts` | `/api/wallets` route: sort by `win_ratio DESC`, filter on `resolved_trade_count` (not `trade_count` — LAW-MAJOR-2 lock), `minVolume` filter, per-wallet alerts route (valid / unknown → `[]`) | `cd apps/dashboard && pnpm test` |
| `apps/dashboard/__tests__/api-health.test.ts` | `/api/health` route: all 6 DB queries fired, response shape, null MAX → null timestamps, `shardsConnected` always null | `cd apps/dashboard && pnpm test` |

**Run all dashboard unit tests:**
```bash
cd apps/dashboard && pnpm test
```

### 1B. Pipeline Unit Tests (Vitest — repo root)

357 tests covering all Phase 1–4 pipeline modules. These must not regress.

```bash
pnpm test   # from repo root
```

Expected: **357 tests passing**, 97.33% stmt coverage.

### 1C. Playwright E2E Tests (Chromium)

File: `apps/dashboard/e2e/dashboard.spec.ts`
Config: `apps/dashboard/playwright.config.ts` (baseURL `http://localhost:3001`, webServer auto-start)

**Run (headed, real browser):**
```bash
cd apps/dashboard && npx playwright test e2e/dashboard.spec.ts \
  --headed --browser=chromium --reporter=list
```

**Run (headless, CI):**
```bash
cd apps/dashboard && npx playwright test e2e/dashboard.spec.ts --reporter=list
```

#### Full test inventory (49 tests)

| # | Suite | Test | Expected |
|---|-------|------|---------|
| 1 | Navigation & Layout | root `/` redirects to `/alerts` | URL contains `/alerts` |
| 2 | Navigation & Layout | sidebar is visible with all 5 nav links | Alerts, Signals, Markets, Wallets, Health all visible in `<aside>` |
| 3 | Navigation & Layout | sidebar nav links have correct hrefs | `/alerts`, `/signals`, `/markets`, `/wallets`, `/health` |
| 4 | Navigation & Layout | active nav item highlighted on /alerts | Link has class `bg-slate-100` |
| 5 | Navigation & Layout | active nav item highlighted on /signals | Link has class `bg-slate-100` |
| 6 | Navigation & Layout | active nav item highlighted on /health | Link has class `bg-slate-100` |
| 7 | Alerts page | page loads without JS errors | `pageerror` events = 0 |
| 8 | Alerts page | h1 is visible | `main h1` visible |
| 9 | Alerts page | h1 text is 'Whale Alerts' | exact text match |
| 10 | Alerts page | 4 KPI stat cards are visible | first `.grid` has exactly 4 direct children |
| 11 | Alerts page | empty state message visible when no data | "No whale alerts yet" visible within 8s |
| 12 | Alerts page | table column headers match spec when data present (graceful) | if empty state, table absent; if live data, all 8 headers visible |
| 13 | Signals page | page loads without JS errors | `pageerror` events = 0 |
| 14 | Signals page | h1 text is 'Signals' | exact text match |
| 15 | Signals page | signal sparkline container visible | "Signal Volume" text visible within 8s |
| 16 | Signals page | filter bar visible with signal type buttons | 4 core type buttons visible (WHALE_TRADE, ORDER_BOOK_IMBALANCE, PRICE_IMPACT_ANOMALY, SENTIMENT_VELOCITY) |
| 17 | Signals page | confidence slider input visible | "Min conf:" text visible |
| 18 | Signals page | time range selector visible | `role=combobox` visible |
| 19 | Signals page | signals table headers visible | Time, Market, Signal Type, Direction, Confidence |
| 20 | Signals page | empty state visible when no data | "No signals in the selected window" visible |
| 21 | Markets page | page loads without JS errors | `pageerror` events = 0 |
| 22 | Markets page | h1 text is 'Market Heat Map' | exact text match |
| 23 | Markets page | empty state renders gracefully | "No signal activity in the last 24 hours" visible |
| 24 | Wallets page | page loads without JS errors | `pageerror` events = 0 |
| 25 | Wallets page | h1 text is 'Wallet Leaderboard' | exact text match |
| 26 | Wallets page | filter controls visible (min trades, min volume) | "Min trades" and "Min volume" text, 2 number inputs |
| 27 | Wallets page | table column headers correct | Rank, Wallet, Total Vol, Win Rate, Whale Trades, Last Seen, Trades (exact) |
| 28 | Wallets page | empty state when no wallets match | "No wallets match the current filters" visible |
| 29 | Health page | page loads without JS errors | `pageerror` events = 0 |
| 30 | Health page | h1 text is 'Pipeline Health' | exact text match |
| 31 | Health page | auto-refresh subtitle visible | "refreshes every 10s" text visible |
| 32 | Health page | 4 health cards visible with correct names | LiveDataWs, ClobWsPool, GammaPoller, DB all visible |
| 33 | Health page | each card has status indicator dot | 4× `span.rounded-full` elements |
| 34 | Health page | cards show 'No data' when DB unreachable | "No data" text visible (DB is localhost-only) |
| 35 | Health page | trade feed subtitle in LiveDataWs card | "Trade feed" text visible |
| 36–45 | Accessibility | each of 5 pages has exactly one `<h1>` | `h1` count = 1 per page |
| 36–45 | Accessibility | each h1 has correct text | Whale Alerts / Signals / Market Heat Map / Wallet Leaderboard / Pipeline Health |
| 46 | Accessibility | all sidebar nav links are `<a>` elements | `aside nav a` count = 5 |
| 47 | Accessibility | no console errors on /alerts | `pageerror` = 0 |
| 48 | Accessibility | no console errors on /signals | `pageerror` = 0 |
| 49 | Accessibility | no console errors on /health | `pageerror` = 0 |

---

## 2. Manual / Functional Checks

These are not covered by automated tests and require a human or browser-based verification.

### Prerequisites
```bash
cd apps/dashboard
[ -f .env.local ] || echo "DATABASE_URL=postgres://localhost:5432/polymarket_alpha" > .env.local
pnpm dev
```

### 2A. Navigation & Layout

| Check | Steps | Pass condition |
|-------|-------|---------------|
| Root redirect | Visit `http://localhost:3001/` | Browser lands on `/alerts`, no flash |
| Sidebar active state changes on nav | Click each nav link in sequence | Active highlight moves correctly to each link |
| Sidebar on all 5 routes | Visit `/alerts`, `/signals`, `/markets`, `/wallets`, `/health` | Sidebar persists on every page, correct item highlighted |
| Layout does not break at 1280px | Resize window to 1280px | Sidebar + main content both fully visible |
| Layout does not break at 768px (tablet) | Resize window to 768px | No overflow, no truncated sidebar |

### 2B. Alerts Page (`/alerts`)

| Check | Steps | Pass condition |
|-------|-------|---------------|
| Empty state displayed without DB | Start server without live DB (or empty DB) | "No whale alerts yet — pipeline may still be warming up" shown inside the table area |
| 4 stat cards render with `—` values when empty | See above | All 4 StatCards visible; values show `—` or `0` |
| SWR polling fires every 5s | Open Network tab, watch for `/api/alerts` fetches | Request repeats at ~5s intervals |
| Graceful API error (DB down) | Kill Postgres, reload `/alerts` | Page shows empty state; no JS crash, no unhandled error in console |
| Stat card titles correct | Load page (with or without data) | Titles: "Total Alerts (24h)", "Largest Alert", "Avg Size", "Most Active Market" |

### 2C. Signals Page (`/signals`)

| Check | Steps | Pass condition |
|-------|-------|---------------|
| Signal sparkline renders (no SSR crash) | Load `/signals`, watch for "Signal Volume" section | Chart area appears (even if empty/no bars) |
| Filter by signal type (toggle) | Click "WHALE_TRADE" button | Button turns blue/active; URL param `types=WHALE_TRADE` appears |
| Clear type filter | Click same button again | Button deactivates; all types shown |
| Confidence slider changes min confidence | Drag slider to 50% | "Min conf: 50%" label updates |
| Time range selector changes hours | Select "Last 7d" | SWR refetches with `hours=168` |
| Empty state correct text | Load with no signals in DB | "No signals in the selected window" shown inside table |
| SWR polling fires every 5s | Open Network tab | `/api/signals?...` repeats at ~5s intervals |

### 2D. Markets Page (`/markets`)

| Check | Steps | Pass condition |
|-------|-------|---------------|
| Empty state message exact text | Load `/markets` with no signal data | "No signal activity in the last 24 hours" shown |
| SWR polls every 30s | Open Network tab | `/api/markets?hours=24` repeats at ~30s intervals |
| Click-through to signals | When market cards visible (live DB), click one | Browser navigates to `/signals?tokenId=<id>` |
| Heat map color gradient | With live data: markets have varying blue intensities | Higher signal count = darker blue card |

### 2E. Wallets Page (`/wallets`)

| Check | Steps | Pass condition |
|-------|-------|---------------|
| Empty state correct text | Load with empty DB | "No wallets match the current filters" in table |
| Min trades filter works | Enter `0` in min trades, observe results change | Debounce 300ms then SWR refetches |
| Min volume filter works | Enter `1000` in min volume field | SWR refetches with new param |
| Side panel opens on row click | (With live data) Click a wallet row | Sheet slides in from right with wallet address in title |
| Side panel close button works | Click X or outside sheet | Sheet closes, table still visible |
| `?wallet=0x...` pre-opens panel | Navigate to `/wallets?wallet=0xABC` | Sheet opens on mount with that wallet |
| SWR polls every 30s | Open Network tab | `/api/wallets?...` repeats at ~30s intervals |
| Win rate coloring | (With data) Verify colors | >60% = green, 40–60% = amber, <40% = red |

### 2F. Health Page (`/health`)

| Check | Steps | Pass condition |
|-------|-------|---------------|
| 4 cards visible with correct names | Load `/health` | LiveDataWs, ClobWsPool, GammaPoller, DB all present |
| No data state (no live DB) | Run without live Postgres | All 4 cards show "No data" and `—` timestamp |
| Status dot is gray for "No data" | See above | Gray (`bg-slate-400`) dots on all 4 cards |
| SWR polls every 10s | Open Network tab | `/api/health` repeats at ~10s intervals |
| "Trade feed" subtitle in LiveDataWs | Load `/health` | "Trade feed" subtitle visible under LiveDataWs card |
| "Shards: Unknown" in ClobWsPool | Load `/health` | "Shards: Unknown" subtitle in ClobWsPool card |
| marketsTracked shown in GammaPoller | (With live DB) Load `/health` | "N markets tracked" subtitle appears in GammaPoller card |

---

## 3. Against Requirements (PLAN.md Acceptance Checks)

### PLAN.md Must-Haves

| Requirement | Acceptance check | Status |
|-------------|-----------------|--------|
| Monorepo `pnpm-workspace.yaml` configured | `cat pnpm-workspace.yaml` shows `apps/*` and `.` | ✅ Verified (on main) |
| `apps/dashboard/` bootstrapped: Next.js 14, Tailwind, shadcn/ui, strict TS | `cd apps/dashboard && pnpm typecheck` → 0 errors | Check with Usopp |
| DB connection layer: singleton pool, shared schema | `lib/db.ts` uses `globalThis.__pgPool` guard | ✅ Code verified |
| 5 API routes with correct query logic | All 5 routes exist, unit-tested | ✅ Code + tests verified |
| 5 pages with components, SWR polling, layout | All 5 pages exist and E2E pass | ✅ 49/49 E2E pass |
| `lib/utils.ts` helpers: `formatUSDC`, `formatAddress`, `timeAgo` | Unit tests in `__tests__/utils.test.ts` | Check Usopp unit run |
| Vitest unit tests for all API routes + utils | 8 test files in `__tests__/` | Check Usopp unit run |
| 0 TypeScript errors | `cd apps/dashboard && pnpm typecheck` | Check with Usopp |
| Existing 480 root tests pass (no regressions) | `pnpm test` at repo root | Check with Usopp |

### LAW Fixes (Critical)

| ID | Fix | Acceptance check |
|----|-----|-----------------|
| LAW-MAJOR-1 | 6-tuple join via `split_part` | `__tests__/alert-hydration.test.ts` asserts `split_part(..., '|', 3)` present in SQL | Check unit run |
| LAW-MAJOR-2 | `resolved_trade_count` filter | `__tests__/api-wallets.test.ts` asserts SQL string contains `resolved_trade_count` in WHERE | Check unit run |
| LAW-MAJOR-3 | `/api/signals/volume` separate route | Route exists at `app/api/signals/volume/route.ts`; sparkline SWR fetches it separately | ✅ Code verified |
| LAW-MINOR-4 | Deterministic `topSignalType` | `__tests__/api-markets.test.ts` tie-breaking fixture test | Check unit run |
| LAW-MINOR-5 | Pinned shadcn versions, vendored | All 10 files in `components/ui/`; no `npx shadcn-ui init` in build | ✅ Code verified |

---

## 4. Known Risk Areas

### Risk 1 — `lib/db.ts` throws if `DATABASE_URL` unset at module load time
**File**: `apps/dashboard/lib/db.ts` lines 13–18
**Issue**: `createPool()` is called at module evaluation, not inside a route handler. If `DATABASE_URL` is missing (e.g., fresh clone without `.env.local`), importing any API route throws before the `try/catch` in the route can handle it.
**Current mitigation**: `.env.local` is present in repo with `DATABASE_URL=postgres://localhost:5432/polymarket_alpha`. The `pg.Pool` constructor does NOT connect eagerly — it connects on first query — so a misconfigured/offline Postgres is fine; only missing `DATABASE_URL` env var is fatal.
**Recommendation for Usopp**: Add a lazy-fallback path — instead of `throw new Error(...)`, return a "dead" pool proxy that rejects all queries gracefully, or simply default to a dummy connection string so the module always loads.

### Risk 2 — Alerts page is `"use client"` but imports `AlertRow` type from an API route module
**File**: `apps/dashboard/app/alerts/page.tsx` imports `type AlertRow from "@/app/api/alerts/route"`
**Issue**: This works only because it's a type-only import (erased at compile). If the import ever becomes a value import, the server module (importing `pool`) would be bundled into the client.
**Recommendation**: Safe as-is for types. Watch for accidental value imports.

### Risk 3 — Signal sparkline uses `dynamic` with `ssr: false` but SSR may flash
**File**: `apps/dashboard/components/signal-sparkline.tsx`
**Issue**: Recharts does not support SSR. The `dynamic(..., { ssr: false })` wrapper is correct. On initial hydration there may be a flash of no chart.
**Recommendation**: Visual check on slow network — verify no hydration error in console.

### Risk 4 — Wallets filter label says "Min trades (resolved)" but test checks "Min trades"
**File**: `apps/dashboard/components/wallets-table.tsx` line: `<span>Min trades (resolved)</span>`
**E2E test line 248**: checks `getByText(/Min trades/i)` — this passes because it's a substring match.
**Risk**: If label is ever changed to something that doesn't contain "Min trades", the test passes but the labeling intent (resolved trades) may be lost.
**Recommendation**: Test is fine. Keep the `(resolved)` qualifier in the label — it communicates the LAW-MAJOR-2 fix to users.

### Risk 5 — `/api/wallets` route does not use `ALERT_TRADE_JOIN_SQL` for the `[address]/alerts` sub-route
**File**: `apps/dashboard/app/api/wallets/[address]/alerts/route.ts`
**Issue**: This route joins `whale_alerts` to `trades` to get `proxy_wallet`. If it uses a partial join (only `tx_hash + token_id`), it's vulnerable to the same LAW-MAJOR-1 fan-out bug.
**Recommendation for Usopp**: Read this file and assert its JOIN SQL uses `ALERT_TRADE_JOIN_SQL` (the same 6-tuple constant). If it doesn't, fix it to import and use `ALERT_TRADE_JOIN_SQL`.

### Risk 6 — No TypeScript check run as part of CI
**Issue**: There is no CI pipeline. TypeScript errors could be introduced and only caught during `pnpm typecheck` manual runs.
**Recommendation**: Add `pnpm typecheck` to PR checklist or a GitHub Actions workflow.

### Risk 7 — Playwright tests skip table header check when DB is empty
**File**: `e2e/dashboard.spec.ts` test 12 (alerts table column headers)
**Issue**: The test correctly handles the empty-state case (no table headers rendered), but this means the header assertions never execute in a DB-less environment. Column header correctness is only validated when live data exists.
**Recommendation**: Add a Playwright mock-server fixture that returns a known alert payload, or add a unit test that renders `AlertsTable` with fixture data and asserts all 8 column headers.

---

## 5. Pre-PR Verification Checklist (for Usopp)

```bash
# Step 1 — Unit tests (dashboard)
cd apps/dashboard && pnpm test
# Expected: all 8 test files pass

# Step 2 — TypeScript
cd apps/dashboard && pnpm typecheck
# Expected: 0 errors

# Step 3 — Root pipeline tests (no regressions)
cd /path/to/repo && pnpm test
# Expected: 357 tests passing

# Step 4 — E2E (headed Chromium, confirms real browser)
cd apps/dashboard
npx playwright test e2e/dashboard.spec.ts --headed --browser=chromium --reporter=list
# Expected: 49 passed

# Step 5 — Check wallets/[address]/alerts route uses full-tuple join
grep -n "ALERT_TRADE_JOIN_SQL\|split_part" apps/dashboard/app/api/wallets/\[address\]/alerts/route.ts
# Expected: ALERT_TRADE_JOIN_SQL import present (Risk 5 above)
```

---

## 6. E2E Test Run Record (2026-04-04)

**Environment**: macOS, headed Chromium, `http://localhost:3001`, no live Postgres DB (localhost refused connections)
**Server**: `PORT=3001 pnpm dev` in `apps/dashboard/`
**Result**: **49/49 PASSED** — 58.2s total

All API routes gracefully returned empty arrays on DB connection failure. No JS errors triggered on any page load. Empty states rendered correctly on all 5 pages.

No fixes were required — the implementation passed all tests on first run.
