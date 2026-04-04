# Plan: Dashboard Tabs + Auto-Sync Fix

## Goal
Verify and fix `serve-dashboard.ts` so that: (1) tabs render and work in-browser, (2) background market sync fires every 5 minutes, (3) whale alerts and recent trades include enriched market question + full wallet address, and (4) all 542 tests continue to pass.

## Root Cause
The source file `src/scripts/serve-dashboard.ts` was already correctly updated by the prior branch commit (`0eaa3be`), but the running server process (PID 34575, started at 10:48PM) was the **old pre-tabs version** still in memory. The fix was to kill the stale process and restart with the updated source.

## What Changed / Verified

### 1. Tabs — ✅ Already in source
- 4 tab buttons: Markets | Whale Alerts | Trades | Wallets
- CSS: `.tab-content { display: none }` / `.tab-content.active { display: block }`
- JS click handlers toggle `.active` on both buttons and content divs
- Markets tab is active by default

### 2. Background sync — ✅ Already in source
- `runSync()` fires on startup
- `setInterval(runSync, 5 * 60 * 1000)` repeats every 5 minutes
- `/api/sync-status` returns `{ lastSyncAt, syncInProgress, syncErrorCount }`
- Client polls sync status every 5s; status bar shows green dot + "last sync X ago"

### 3. Enriched data — ✅ Already in source
- `/api/summary` → enrichedAlerts includes `marketQuestion`, `marketOutcome`, `marketCategory`, `wallet` (full address from tradeLookupKey)
- `/api/recent-trades` → joins `markets` table for `marketQuestion`, `marketOutcome`; `proxyWallet` is full address, never truncated

### 4. Actual fix applied
- Killed stale server process (PID 34575)
- Restarted with `npx tsx src/scripts/serve-dashboard.ts`
- Verified all API endpoints return correct enriched data
- Confirmed 542 tests pass

## Out of Scope
- Changing the seeded fake token IDs to match Gamma market IDs (trades show empty marketQuestion because seed uses `no-token-1` fake IDs — this is a data issue, not a code issue)
- Next.js dashboard changes
- E2E test updates

## Definition of Done — All ✅
- [x] `curl http://localhost:3456/` returns HTML with 4 `data-tab=` buttons
- [x] `curl http://localhost:3456/api/sync-status` returns `{ lastSyncAt: <ISO>, syncInProgress: false, syncErrorCount: 0 }`
- [x] `/api/summary` alerts include `marketQuestion`, `marketOutcome`, `wallet` fields
- [x] `/api/recent-trades` trades include `marketQuestion`, `marketOutcome`, `proxyWallet` (full address)
- [x] 542 tests passing (46 test files)
- [x] Dark theme, monospace fonts, badge styling preserved
