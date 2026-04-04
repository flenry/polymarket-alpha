# Board Brief — Polymarket Alpha Dashboard (Phase 6 / UI)

**Date**: 2026-04-04  
**Branch**: `feat/dashboard`  
**Author**: Robin (Research Lead)

---

## Context

The pipeline (Phases 1–5) is complete and production-ready: 480 tests, 97%+ coverage, all modules wired. It ingests trades, detects whales, computes 6 signal types, enriches wallets, and outputs alerts to stdout + webhooks.

**What's missing**: a human-readable interface. Phase 6 adds a read-only Next.js 14 dashboard in `apps/dashboard/` that connects directly to the shared Postgres DB and surfaces live data for the pipeline operator.

This is an **EXISTING project**. Brook should work on `feat/dashboard` (already created).

---

## Project Type: EXISTING — Feature Branch `feat/dashboard`

---

## Problem Statement

The operator currently has no visibility into what the pipeline is doing beyond raw log output and Slack/Discord webhook messages. There's no way to:
- See whale alert history with context (side, value, enrichment status)
- Browse the signal stream filtered by type or confidence
- Understand which markets are most active
- Track which wallets are winning
- Confirm the pipeline itself is healthy

The dashboard addresses all of this with zero infrastructure additions — it reads the existing Postgres DB.

---

## Goals

1. **Live whale alert feed** at `/alerts` — auto-refresh 5s, USDC value, side, enrichment status
2. **Signal stream** at `/signals` — filterable by type, confidence, time window; composite score visible
3. **Market heat map** at `/markets` — top 20 by signal density (card grid, click-to-filter)
4. **Wallet leaderboard** at `/wallets` — ranked by win rate, side panel for alert history
5. **Pipeline health** at `/health` — DB-derived recency signals, green/amber/red status cards

---

## Proposed Approach

### Structure
- Monorepo workspace: `pnpm-workspace.yaml` at repo root (`packages: ['apps/*', '.']`)
- `apps/dashboard/` — standalone Next.js 14 app with its own `package.json`
- Schema shared via relative import: `../../src/db/schema.ts` (no duplication)
- DB connection reuses `pg` (already a root dep) via a thin `apps/dashboard/lib/db.ts`

### Stack (specified)
- Next.js 14 App Router, TypeScript strict
- Tailwind CSS + shadcn/ui (Table, Card, Badge, Button, Select, Tabs, Skeleton)
- Drizzle ORM — shared schema import (no separate migration)
- SWR — client-side polling (5s for alerts/signals, 10s health, 30s markets)
- Recharts — signal sparklines and mini-charts
- Vitest — unit tests for API routes and `lib/utils.ts`
- Font: Inter via `next/font`

### DB Connection
The dashboard API routes (Next.js Route Handlers) run in Node.js. They import Drizzle directly — same `pg` + Drizzle ORM pattern as the pipeline. The `apps/dashboard/lib/db.ts` creates a singleton `pg.Pool` from `DATABASE_URL`.

### Key Schema Facts (from audit)
- `whale_alerts`: `alerted_at`, `usdc_value`, `token_id`, `condition_id`, `sigmas_above_mean`, `pct_of_daily_volume`, `enriched_at`, no direct market title (must JOIN `markets` on `token_id`)
- `signals`: `signal_type`, `confidence`, `strength`, `direction`, `created_at`, `payload` (jsonb — composite score lives here as `compositeScore`), no market title (JOIN `markets`)
- `markets`: `question` (= market title), `slug`, `token_id`
- `market_stats`: `refreshed_at`, `volume_24hr`, `trade_count_24h`
- `trades`: partitioned by `traded_at` — must use `tradedAt` in WHERE clauses for partition pruning
- `wallet_profiles`: `proxy_wallet`, `win_ratio`, `total_volume_usdc`, `trade_count`, `whale_trade_count`, `last_seen_at`
- `whale_alerts` has NO direct `side` or `proxy_wallet` column — these live in `trades`. The link is via `trade_lookup_key` (app-layer join, not FK). **This is a critical gap**: the alerts page spec wants `Side` and `Wallet` columns, but `whale_alerts` doesn't store them directly.

### Critical Risk: whale_alerts missing side/wallet
The spec shows an alerts table with `Side` and `Wallet` columns. `whale_alerts` stores a `trade_lookup_key` (pipe-delimited: `txHash|tokenId|proxyWallet|tradedAt|priceUsdc|sizeTokens`) but no direct `side` or `proxy_wallet` field. Options:
1. **Parse `trade_lookup_key`** — `proxyWallet` is at index [2], but `side` is NOT in the key. Side is lost.
2. **JOIN `trades`** — works only if the trade was inserted (it always is for whale alerts). Use `LEFT JOIN trades ON trades.transaction_hash = split_part(wa.trade_lookup_key,'|',1) AND trades.token_id = wa.token_id`. This is valid but requires careful handling of the partitioned `trades` table (no partition-key WHERE on `whale_alerts`).
3. **Add derived columns to whale_alerts query** — join and accept that side/wallet come from trades.

**Recommendation for Vegapunk/Law**: Option 2 (JOIN on trades) is cleanest. The join is on `transaction_hash + token_id`, which has an index. Side and proxy_wallet are readable. This should be the approach for the `/api/alerts` route. Flag for confirmation.

### Monorepo Workspace Structure
```
pnpm-workspace.yaml          ← NEW (at repo root)
apps/
  dashboard/
    app/
      layout.tsx
      page.tsx                ← redirect to /alerts
      alerts/page.tsx
      signals/page.tsx
      markets/page.tsx
      wallets/page.tsx
      health/page.tsx
      api/
        alerts/route.ts
        signals/route.ts
        markets/route.ts
        wallets/route.ts
        health/route.ts
    components/
      sidebar.tsx
      alerts-table.tsx
      signals-table.tsx
      markets-heatmap.tsx
      wallets-table.tsx
      health-panel.tsx
      signal-sparkline.tsx
      stat-card.tsx
    lib/
      db.ts
      utils.ts
    __tests__/
      api-alerts.test.ts
      api-signals.test.ts
      api-markets.test.ts
      api-wallets.test.ts
      api-health.test.ts
      utils.test.ts
    package.json
    tailwind.config.ts
    tsconfig.json
    next.config.ts
    .env.local.example
```

---

## Key Unknowns / Risks

| # | Risk | Severity | Recommendation |
|---|------|----------|----------------|
| 1 | `whale_alerts` missing `side` + `proxy_wallet` | HIGH | JOIN `trades` on `transaction_hash + token_id`; flag to Law |
| 2 | Drizzle schema import from `../../src/db/schema.ts` — TypeScript path resolution | MEDIUM | `tsconfig.json` paths or relative imports; Next.js must resolve `.ts` (not `.js`) imports |
| 3 | `pg` singleton in Next.js App Router — multiple hot-reloads leak connections in dev | LOW | Guard with `global.__pgPool` in `lib/db.ts` (standard Next.js pattern) |
| 4 | Partitioned `trades` table in JOIN — no partition pruning on `whale_alerts` side | LOW | Accept full-scan on `trades`; add `AND t.traded_at >= NOW() - INTERVAL '90 days'` bound |
| 5 | Recharts SSR — Recharts is a client-only library | MEDIUM | Wrap sparkline in `dynamic(() => ..., { ssr: false })` |
| 6 | shadcn/ui setup — requires `npx shadcn-ui@latest init` in `apps/dashboard/` | LOW | Document in task; Zoro must run init before components |
| 7 | No auth specified — single operator assumption | INFO | No mitigation needed; explicitly out of scope |
| 8 | `pnpm-workspace.yaml` must be at repo root — adds `apps/*` to workspace | LOW | Existing pipeline is already the root package; no conflict |

---

## Questions for Vegapunk (Architecture)

1. **Drizzle schema import path**: Should `apps/dashboard/lib/db.ts` import schema via a relative `../../src/db/schema.ts` path, or should we add a TypeScript path alias in `apps/dashboard/tsconfig.json`? Next.js 14 with `moduleResolution: bundler` handles relative `.ts` imports natively — but the existing root `tsconfig.json` uses `NodeNext` which requires `.js` extensions. The dashboard's own tsconfig should use `moduleResolution: bundler` (standard for Next.js) — does this create any conflicts?

2. **whale_alerts JOIN strategy**: Confirm that `LEFT JOIN trades ON t.transaction_hash = split_part(wa.trade_lookup_key,'|',1) AND t.token_id = wa.token_id AND t.traded_at >= NOW() - INTERVAL '90 days'` is the right approach for recovering `side` and `proxy_wallet` from the partitioned table. Should we add a compound index on `trades(transaction_hash, token_id)`?

3. **shadcn/ui component list**: The spec lists Table, Card, Badge, Button, Select, Tabs. Should we also include Skeleton (for SWR loading states) and Sheet (for the wallet side panel)?

---

## Questions for Law (Strategy / Trade-offs)

1. **Side panel for wallet history** (spec: `/wallets` — "Click wallet → side panel showing their whale alert history"): This requires a second API call per wallet click. Should this be a Sheet component (shadcn) with its own SWR fetch, or a modal? And should it link to `/alerts?wallet=0x...` instead for simplicity?

2. **Composite score in signal payload**: The spec says "Composite score shown in payload if present (gold star ⭐ icon + score)". The `payload` jsonb field is updated by `updateSignalPayloads` with `compositeScore`. Should we surface the raw float (e.g., `0.847`) or render as a percentage? What happens when multiple signals for the same token fire — do they ALL get the composite score patched in?

3. **`shardsConnected` in health endpoint**: The spec explicitly notes this is `null` (can't query live WS from DB). Should we show "Unknown" or simply omit the ClobWsPool shard count card entirely? The `health-panel.tsx` could show "N shards configured" from env vs "Unknown connected" — is that acceptable?

4. **Test scope for dashboard**: Vitest unit tests for API routes are specified. Should these test the raw SQL queries (mock pg client) or the Next.js Route Handler response (mock Drizzle)? The existing pipeline uses mocked DB clients — following the same pattern is cleanest.

---

## Commit Strategy (from spec)

Branch: `feat/dashboard`
1. `feat: monorepo setup (pnpm-workspace.yaml, root scripts)`
2. `feat: dashboard scaffold (Next.js 14, Tailwind, shadcn, layout+nav)`
3. `feat: alerts page + API route`
4. `feat: signals page + API route`
5. `feat: markets page + API route`
6. `feat: wallets page + API route`
7. `feat: health page + API route`
8. `feat: vitest tests for API routes + utils`
9. `chore: update docs for dashboard`

---

## What Zoro Should NOT Touch

- Any existing `src/` pipeline files
- `drizzle/` migration files
- Existing 480 passing tests in root

---

## Summary for Crew

**This is a UI-only phase.** No pipeline logic changes. The dashboard is a new Next.js app in a new `apps/` directory. It reads the existing DB schema, reuses `pg` from root deps via the workspace, and has its own test suite. The only substantive technical decision is how to recover `side` + `wallet` from `whale_alerts` (JOIN strategy) — everything else is straightforward scaffolding and UI implementation.
