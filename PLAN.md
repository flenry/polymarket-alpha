# Plan: Polymarket Alpha Dashboard (Phase 6 / UI)

## Goal
A production-ready read-only Next.js 14 dashboard at `apps/dashboard/` that surfaces live whale alerts, signals, market heat map, wallet leaderboard, and pipeline health by reading the existing Postgres DB — with Vitest unit tests for all API routes and utilities, pushed as `feat/dashboard` and opened as a PR to main.

---

## Must-Haves (goal-backward)
- [ ] Monorepo workspace configured (`pnpm-workspace.yaml`, root `package.json` scripts)
- [ ] `apps/dashboard/` bootstrapped with Next.js 14 App Router, Tailwind, shadcn/ui, strict TypeScript
- [ ] DB connection layer in `lib/db.ts` (singleton pool, imports shared Drizzle schema)
- [ ] 5 API routes returning correct data with correct query logic
- [ ] 5 pages with correct components, SWR polling, and layout
- [ ] `lib/utils.ts` helpers: `formatUSDC`, `formatAddress`, `timeAgo`
- [ ] Vitest unit tests for all API routes + utils (mock Drizzle)
- [ ] 0 TypeScript errors in dashboard (`tsc --noEmit`)
- [ ] Existing 480 root tests continue to pass (no regressions)
- [ ] CLAUDE.md and README.md updated for Phase 6

---

## Out of Scope
- Authentication / multi-user access
- Dark mode
- Playwright / E2E tests
- Any changes to `src/` pipeline files
- Any changes to `drizzle/` migration files
- Real-time WebSocket in dashboard (polling via SWR is sufficient)
- Mobile optimization beyond basic responsive layout

---

## Key Technical Decisions (from Board Brief)

### whale_alerts JOIN strategy
`whale_alerts` has no direct `side` or `proxy_wallet` columns. These must be recovered by joining `trades` on:
```sql
LEFT JOIN trades t ON t.transaction_hash = split_part(wa.trade_lookup_key,'|',1)
  AND t.token_id = wa.token_id
  AND t.traded_at >= NOW() - INTERVAL '90 days'
```
This is the only way to show `Side` and `Wallet` in the alerts table.

### Dashboard tsconfig
Use `moduleResolution: bundler` (Next.js 14 standard) in `apps/dashboard/tsconfig.json`. The dashboard imports the schema as a relative `.ts` path — Next.js resolves these without `.js` extensions. The root pipeline's `NodeNext` resolution is unaffected.

### pg singleton in Next.js
Use `globalThis.__pgPool` guard to prevent connection leaks during hot reload in dev:
```ts
const globalForDb = globalThis as typeof globalThis & { __pgPool?: pg.Pool };
```

### Recharts SSR
`signal-sparkline.tsx` must use `dynamic(() => import('./signal-sparkline-inner'), { ssr: false })` pattern.

### shadcn/ui components needed
Table, Card, Badge, Button, Select, Tabs, Skeleton, Sheet (wallet side panel), Progress (confidence bar)

---

## Tasks

### Chunk 1: Monorepo Setup
- [ ] **Task 1.1**: Create `pnpm-workspace.yaml` at repo root
  - Files: `pnpm-workspace.yaml` (new)
  - Content:
    ```yaml
    packages:
      - 'apps/*'
      - '.'
    ```
  - Outcome: `pnpm install` from root resolves both `polymarket-alpha` and `dashboard` packages

- [ ] **Task 1.2**: Add dashboard scripts to root `package.json`
  - Files: `package.json` (modify scripts only)
  - Add:
    ```json
    "dashboard:dev": "pnpm --filter dashboard dev",
    "dashboard:build": "pnpm --filter dashboard build"
    ```
  - Outcome: `pnpm dashboard:dev` launches dashboard from repo root

- [ ] **Task 1.3**: Add `NEXT_PUBLIC_DASHBOARD_POLL_INTERVAL_MS` to root `.env.example`
  - Files: `.env.example` (append)
  - Add comment block:
    ```
    # Dashboard
    NEXT_PUBLIC_DASHBOARD_POLL_INTERVAL_MS=5000
    ```
  - Outcome: env example documents the new var

---

### Chunk 2: Dashboard Scaffold
- [ ] **Task 2.1**: Create `apps/dashboard/package.json`
  - Files: `apps/dashboard/package.json` (new)
  - Content: Next.js 14, React 18, Tailwind, shadcn/ui deps, SWR, Recharts, Drizzle, pg, Vitest
  - Key deps:
    ```json
    {
      "name": "dashboard",
      "version": "0.1.0",
      "private": true,
      "scripts": {
        "dev": "next dev",
        "build": "next build",
        "test": "vitest run",
        "typecheck": "tsc --noEmit"
      },
      "dependencies": {
        "next": "14.2.3",
        "react": "^18",
        "react-dom": "^18",
        "swr": "^2.2.5",
        "recharts": "^2.12.7",
        "drizzle-orm": "^0.40.0",
        "pg": "^8.13.3",
        "@radix-ui/react-slot": "...",
        "class-variance-authority": "...",
        "clsx": "...",
        "tailwind-merge": "...",
        "lucide-react": "...",
        "cmdk": "..."
      },
      "devDependencies": {
        "typescript": "^5",
        "@types/node": "^22",
        "@types/react": "^18",
        "@types/react-dom": "^18",
        "@types/pg": "^8",
        "tailwindcss": "^3",
        "postcss": "^8",
        "autoprefixer": "^10",
        "vitest": "^3.1.1",
        "@vitejs/plugin-react": "^4"
      }
    }
    ```
  - Outcome: `pnpm install` from `apps/dashboard/` installs all deps

- [ ] **Task 2.2**: Create `apps/dashboard/tsconfig.json`
  - Files: `apps/dashboard/tsconfig.json` (new)
  - Key settings: `"moduleResolution": "bundler"`, `"strict": true`, extends Next.js defaults
  - Paths: `"@/*": ["./*"]` for clean imports
  - Include: `["**/*.ts", "**/*.tsx", "../../src/db/schema.ts"]`
  - Outcome: TypeScript resolves shared schema import and all internal paths

- [ ] **Task 2.3**: Create `apps/dashboard/next.config.ts`
  - Files: `apps/dashboard/next.config.ts` (new)
  - Minimal config: enable `transpilePackages: []`, experimental serverActions default
  - Outcome: Next.js 14 builds without errors

- [ ] **Task 2.4**: Create `apps/dashboard/tailwind.config.ts`
  - Files: `apps/dashboard/tailwind.config.ts` (new)
  - Content patterns: `["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"]`
  - Extend: `fontFamily: { sans: ['Inter', 'sans-serif'] }`, default slate/blue palette
  - Outcome: Tailwind processes all component files

- [ ] **Task 2.5**: Create `apps/dashboard/.env.local.example`
  - Files: `apps/dashboard/.env.local.example` (new)
  - Content:
    ```
    DATABASE_URL=postgres://localhost:5432/polymarket_alpha
    NEXT_PUBLIC_DASHBOARD_POLL_INTERVAL_MS=5000
    ```
  - Outcome: New devs know exactly what env vars to set

- [ ] **Task 2.6**: Create `apps/dashboard/lib/db.ts` — DB connection
  - Files: `apps/dashboard/lib/db.ts` (new)
  - Logic:
    - `globalThis.__pgPool` singleton guard (Next.js hot-reload safety)
    - `pg.Pool` from `DATABASE_URL` env var
    - `drizzle(pool, { schema })` where schema imported from `../../src/db/schema.ts`
    - Export `db` and `getDb()`
  - Outcome: All API routes import `db` from `@/lib/db` with zero duplicate pools

- [ ] **Task 2.7**: Create `apps/dashboard/lib/utils.ts` — shared helpers
  - Files: `apps/dashboard/lib/utils.ts` (new)
  - Functions:
    - `formatUSDC(value: number): string` → `$127,400` format (Intl.NumberFormat, 0 decimals for >$1k, 2 for <$1k)
    - `formatAddress(address: string): string` → `0xABCD…1234` (first 6 + last 4)
    - `timeAgo(date: Date | string): string` → "2 min ago", "3h ago", "1d ago"
    - `cn(...inputs: ClassValue[]): string` → tailwind-merge + clsx (shadcn standard)
  - Edge cases: null/undefined inputs return `"—"`; `formatAddress` short-circuits if address ≤ 12 chars
  - Test guidance: all 3 helpers need unit tests with edge cases (see Chunk 8)
  - Outcome: Consistent formatting across all components

- [ ] **Task 2.8**: Create root layout `apps/dashboard/app/layout.tsx`
  - Files: `apps/dashboard/app/layout.tsx` (new), `apps/dashboard/app/globals.css` (new)
  - Layout: Inter font, slate-50 background, flex row with `<Sidebar />` + `<main>` content area
  - Outcome: All pages share consistent nav and font

- [ ] **Task 2.9**: Create `apps/dashboard/components/sidebar.tsx`
  - Files: `apps/dashboard/components/sidebar.tsx` (new)
  - Nav items: Alerts, Signals, Markets, Wallets, Health (with lucide-react icons)
  - Active state: `slate-100` background, `blue-600` text
  - Outcome: Navigation works across all 5 pages

- [ ] **Task 2.10**: Create `apps/dashboard/app/page.tsx` — root redirect
  - Files: `apps/dashboard/app/page.tsx` (new)
  - Content: `redirect('/alerts')` using `next/navigation`
  - Outcome: Visiting `/` sends user to alerts page

- [ ] **Task 2.11**: Create `apps/dashboard/components/stat-card.tsx`
  - Files: `apps/dashboard/components/stat-card.tsx` (new)
  - Props: `title`, `value`, `subtitle?`, `className?`
  - Style: white card, 1px slate-200 border, subtle shadow
  - Outcome: Reusable KPI card for all pages

---

### Chunk 3: Alerts Page
- [ ] **Task 3.1**: Create `apps/dashboard/app/api/alerts/route.ts`
  - Files: `apps/dashboard/app/api/alerts/route.ts` (new)
  - Query params: `limit` (default 100), `offset` (default 0), `hours` (default 24)
  - SQL: SELECT from `whale_alerts wa` LEFT JOIN `trades t` ON `t.transaction_hash = split_part(wa.trade_lookup_key,'|',1) AND t.token_id = wa.token_id AND t.traded_at >= NOW() - INTERVAL '90 days'` LEFT JOIN `markets m` ON `m.token_id = wa.token_id` WHERE `wa.alerted_at >= NOW() - $hours * INTERVAL '1 hour'` ORDER BY `wa.alerted_at DESC`
  - Returns: `{ alerts: AlertRow[], total: number }` where `AlertRow` includes `side` and `proxyWallet` from trades join
  - Input validation: parse and clamp `limit` (max 500), `offset` (≥0), `hours` (1–168)
  - Error handling: 500 with `{ error: string }` on DB failure
  - Outcome: Paginated alert list with all columns the UI needs
  - Test guidance: mock `db.execute()`, test default params, test hours filter, test empty result, test malformed query params (should return 400)

- [ ] **Task 3.2**: Create `apps/dashboard/components/alerts-table.tsx`
  - Files: `apps/dashboard/components/alerts-table.tsx` (new)
  - SWR hook: polls `/api/alerts` every 5s
  - Columns: Time | Market | Side | Value (USDC) | Wallet | σ above mean | % daily vol | Enriched?
  - Side: green "BUY" / red "SELL" badge
  - Value: `formatUSDC()`, green for BUY, red for SELL
  - Wallet: `formatAddress()`, link to `/wallets?wallet={address}`
  - Gate badge: `SIGMA` (blue) / `PCT_VOL` (amber) / `BOTH` (green) — derived from `sigmasAboveMean >= 3` and `pctOfDailyVolume >= 0.02`
  - Enriched: ✅ if `enrichedAt` set, ⏳ if null
  - Loading: shadcn Skeleton rows
  - Empty state: "No whale alerts yet — pipeline may still be warming up"
  - Outcome: Live, auto-refreshing alerts table

- [ ] **Task 3.3**: Create `apps/dashboard/app/alerts/page.tsx`
  - Files: `apps/dashboard/app/alerts/page.tsx` (new)
  - KPI cards (4 stat cards): Total alerts 24h | Largest alert | Avg size | Most active market
  - KPI data: derived from initial SWR fetch of `/api/alerts`
  - Renders `<AlertsTable />`
  - Outcome: Complete /alerts page

---

### Chunk 4: Signals Page
- [ ] **Task 4.1**: Create `apps/dashboard/app/api/signals/route.ts`
  - Files: `apps/dashboard/app/api/signals/route.ts` (new)
  - Query params: `types` (comma-sep SignalType list), `minConfidence` (0–1), `hours` (default 24), `tokenId`
  - SQL: SELECT from `signals s` LEFT JOIN `markets m` ON `s.token_id = m.token_id` WHERE conditions applied, ORDER BY `s.created_at DESC` LIMIT 200
  - Validate `types` against `SIGNAL_TYPES` constant (import from shared or redefine as const array)
  - Returns: `{ signals: SignalRow[] }` — include `payload` as-is (jsonb)
  - Outcome: Filtered signal list with market context
  - Test guidance: test default params, test `types` filter (invalid type → 400), test `minConfidence` clamping, test `tokenId` filter

- [ ] **Task 4.2**: Create `apps/dashboard/components/signal-sparkline.tsx`
  - Files: `apps/dashboard/components/signal-sparkline.tsx` (new)
  - Recharts `BarChart` — signals per hour, last 24 hours, colored by signal type
  - Dynamic import with `ssr: false`
  - Accepts: `data: { hour: string, count: number, type: string }[]`
  - Outcome: Visual signal volume trend at top of /signals page

- [ ] **Task 4.3**: Create `apps/dashboard/components/signals-table.tsx`
  - Files: `apps/dashboard/components/signals-table.tsx` (new)
  - SWR hook: polls `/api/signals` every 5s with current filter state
  - Filter bar: Signal Type (multi-select using shadcn Select + Tabs), Min Confidence (shadcn Slider 0–100), Last N hours (Select: 1h/6h/24h/7d)
  - Columns: Time | Market | Signal Type | Direction | Confidence | Strength | Composite Score
  - Signal type badges with correct colors (purple/blue/orange/teal/indigo/violet)
  - Direction: ▲ BULL (green) / ▼ BEAR (red) / — NEUTRAL
  - Confidence: shadcn Progress bar 0–100%
  - Composite score: read `payload.compositeScore` — show ⭐ + value if present
  - Loading skeleton
  - Outcome: Full-featured signal browser

- [ ] **Task 4.4**: Create `apps/dashboard/app/signals/page.tsx`
  - Files: `apps/dashboard/app/signals/page.tsx` (new)
  - Signal sparkline at top + `<SignalsTable />`
  - Outcome: Complete /signals page

---

### Chunk 5: Markets Page
- [ ] **Task 5.1**: Create `apps/dashboard/app/api/markets/route.ts`
  - Files: `apps/dashboard/app/api/markets/route.ts` (new)
  - Query params: `hours` (default 24)
  - SQL: aggregate query on `signals` grouped by `token_id`, count total signals and whale-type signals, join `markets` for title/slug, ORDER BY signal count DESC LIMIT 20
  - Returns: `{ markets: MarketRow[] }` with `tokenId`, `question`, `slug`, `signalCount`, `whaleCount`, `topSignalType`, `volume24h`
  - Top signal type: subquery or `mode()` aggregate on `signal_type` within group
  - `volume24h` from `market_stats.volume_24hr` (LEFT JOIN)
  - Outcome: Heat map data for top 20 markets
  - Test guidance: test hours filter, test empty (0 signals → empty array), test join with no matching market row

- [ ] **Task 5.2**: Create `apps/dashboard/components/markets-heatmap.tsx`
  - Files: `apps/dashboard/components/markets-heatmap.tsx` (new)
  - SWR hook: polls `/api/markets` every 30s
  - Card grid (CSS grid, 4 cols): each card shows `question`, signal count badge, whale count, top signal type badge, 24h volume
  - Card background: `opacity` scales with signal density (lowest density = `bg-blue-50`, highest = `bg-blue-500 text-white`)
  - Click card: navigates to `/signals?tokenId={tokenId}` (Next.js router push)
  - Loading: Skeleton cards
  - Empty state: "No signal activity in the last {hours} hours"
  - Outcome: Visual market heat map with click-through

- [ ] **Task 5.3**: Create `apps/dashboard/app/markets/page.tsx`
  - Files: `apps/dashboard/app/markets/page.tsx` (new)
  - Renders `<MarketsHeatmap />`
  - Outcome: Complete /markets page

---

### Chunk 6: Wallets Page
- [ ] **Task 6.1**: Create `apps/dashboard/app/api/wallets/route.ts`
  - Files: `apps/dashboard/app/api/wallets/route.ts` (new)
  - Query params: `minTrades` (default 3), `minVolume` (default 0), `limit` (default 50)
  - SQL: SELECT from `wallet_profiles` WHERE `trade_count >= $minTrades AND total_volume_usdc >= $minVolume` ORDER BY `win_ratio DESC NULLS LAST` LIMIT $limit
  - Returns: `{ wallets: WalletRow[] }` with all wallet_profiles columns
  - Outcome: Ranked wallet list
  - Test guidance: test default params, test minTrades filter, test minVolume filter, test empty result

- [ ] **Task 6.2**: Create `apps/dashboard/app/api/wallets/[address]/alerts/route.ts`
  - Files: `apps/dashboard/app/api/wallets/[address]/alerts/route.ts` (new)
  - Returns last 20 whale alerts for a given `proxy_wallet` address — JOIN `whale_alerts wa` with `trades t` to get side, JOIN `markets m` for title
  - Used by wallet side panel
  - Test guidance: test valid address, test unknown address (empty array, not 404)

- [ ] **Task 6.3**: Create `apps/dashboard/components/wallets-table.tsx`
  - Files: `apps/dashboard/components/wallets-table.tsx` (new)
  - SWR hook: polls `/api/wallets` every 30s
  - Columns: Rank | Wallet | Total Vol | Trades | Win Rate | Whale Trades | Last Seen
  - Win rate: `71.8%` colored green >60%, amber 40–60%, red <40%
  - Wallet: `formatAddress()`, click opens Sheet side panel
  - Filter inputs: min volume ($), min trades (number inputs, debounced)
  - Side panel (shadcn Sheet): shows wallet's alert history via SWR fetch of `/api/wallets/{address}/alerts`
  - Outcome: Full wallet leaderboard with side panel drill-down

- [ ] **Task 6.4**: Create `apps/dashboard/app/wallets/page.tsx`
  - Files: `apps/dashboard/app/wallets/page.tsx` (new)
  - Renders `<WalletsTable />`
  - Supports `?wallet=0x...` query param to pre-open side panel
  - Outcome: Complete /wallets page

---

### Chunk 7: Health Page
- [ ] **Task 7.1**: Create `apps/dashboard/app/api/health/route.ts`
  - Files: `apps/dashboard/app/api/health/route.ts` (new)
  - No query params
  - SQL queries (all separate):
    1. `SELECT MAX(traded_at) FROM trades` → `lastTradeAt`
    2. `SELECT MAX(captured_at) FROM order_book_snapshots` → `lastSnapshotAt`
    3. `SELECT MAX(refreshed_at) FROM market_stats` → `lastMarketRefreshAt`
    4. `SELECT COUNT(*) FROM trades WHERE traded_at >= NOW() - INTERVAL '5 minutes'` → `tradesLast5Min`
    5. `SELECT COUNT(*) FROM markets WHERE active = true AND watchlisted = true` → `marketsTracked`
    6. `SELECT COUNT(*) FROM markets WHERE neg_risk = true AND active = true` → `negRiskMarketsTracked`
  - Returns JSON per spec (shardsConnected: null)
  - Outcome: Health snapshot for UI status cards
  - Test guidance: mock all 6 DB queries, test null MAX (no data → null timestamps), test response shape

- [ ] **Task 7.2**: Create `apps/dashboard/components/health-panel.tsx`
  - Files: `apps/dashboard/components/health-panel.tsx` (new)
  - SWR hook: polls `/api/health` every 10s
  - 4 status cards:
    - **LiveDataWs**: derive status from `lastTradeAt` — green if <30s, amber 30–120s, red >120s
    - **ClobWsPool**: derive from `lastSnapshotAt` — same thresholds; shard count shown as "Unknown"
    - **GammaPoller**: derive from `lastMarketRefreshAt`, show `marketsTracked` count
    - **DB**: derive from `lastTradeAt`, show `tradesLast5Min` trades/5min
  - Status indicator: colored dot (green/amber/red) + `timeAgo()` timestamp
  - Outcome: Visual pipeline health dashboard

- [ ] **Task 7.3**: Create `apps/dashboard/app/health/page.tsx`
  - Files: `apps/dashboard/app/health/page.tsx` (new)
  - Renders `<HealthPanel />`
  - Outcome: Complete /health page

---

### Chunk 8: Tests
- [ ] **Task 8.1**: Create `apps/dashboard/__tests__/utils.test.ts`
  - Files: `apps/dashboard/__tests__/utils.test.ts` (new)
  - Test `formatUSDC`: `127400 → "$127,400"`, `500.50 → "$500.50"`, `0 → "$0"`, `null/undefined → "—"`
  - Test `formatAddress`: `"0xABCDEF1234567890abcdef1234" → "0xABCD…7890"` (first 6 + last 4), short address passthrough
  - Test `timeAgo`: now → "just now", 2min ago, 3h ago, 2d ago
  - Outcome: 100% coverage on `lib/utils.ts`

- [ ] **Task 8.2**: Create `apps/dashboard/__tests__/api-alerts.test.ts`
  - Files: `apps/dashboard/__tests__/api-alerts.test.ts` (new)
  - Mock Drizzle `db.execute()` to return fixture data
  - Test: default params return 100-limit query, hours filter applied, empty result → `{ alerts: [], total: 0 }`, invalid hours → 400
  - Outcome: Route handler tested in isolation

- [ ] **Task 8.3**: Create `apps/dashboard/__tests__/api-signals.test.ts`
  - Files: `apps/dashboard/__tests__/api-signals.test.ts` (new)
  - Mock Drizzle query chain
  - Test: types filter (valid/invalid), minConfidence clamp, tokenId filter, default 200 limit
  - Outcome: Route handler tested in isolation

- [ ] **Task 8.4**: Create `apps/dashboard/__tests__/api-markets.test.ts`
  - Files: `apps/dashboard/__tests__/api-markets.test.ts` (new)
  - Test: aggregation query called with correct cutoff, empty markets → `{ markets: [] }`, hours param passed through
  - Outcome: Route handler tested in isolation

- [ ] **Task 8.5**: Create `apps/dashboard/__tests__/api-wallets.test.ts`
  - Files: `apps/dashboard/__tests__/api-wallets.test.ts` (new)
  - Test: default sort (win_ratio DESC), minTrades filter, minVolume filter, wallet-specific alerts route (valid/unknown)
  - Outcome: Route handler tested in isolation

- [ ] **Task 8.6**: Create `apps/dashboard/__tests__/api-health.test.ts`
  - Files: `apps/dashboard/__tests__/api-health.test.ts` (new)
  - Test: all 6 DB queries called, response shape matches spec JSON, null MAX timestamps → null in response, shardsConnected always null
  - Outcome: Route handler tested in isolation

- [ ] **Task 8.7**: Create `apps/dashboard/vitest.config.ts`
  - Files: `apps/dashboard/vitest.config.ts` (new)
  - Include: `["__tests__/**/*.test.ts"]`
  - Environment: `node`
  - Outcome: `pnpm test` in dashboard runs only dashboard tests

---

### Chunk 9: Documentation
- [ ] **Task 9.1**: Update `CLAUDE.md`
  - Files: `CLAUDE.md` (modify)
  - Add Phase 6 row to project state table: dashboard, test counts, branch
  - Add `apps/dashboard/` to project structure section
  - Outcome: CLAUDE.md reflects current state

- [ ] **Task 9.2**: Update `README.md`
  - Files: `README.md` (modify)
  - Add dashboard section: how to run (`pnpm dashboard:dev`), pages overview, env vars
  - Outcome: README is accurate for new contributors

- [ ] **Task 9.3**: Update `PROGRESS.md`
  - Files: `PROGRESS.md` (append)
  - Add Phase 6 entry per standard format
  - Outcome: Crew has continuity context

---

## Execution Order

```
1.1 → 1.2 → 1.3                    # Monorepo setup (no deps)
2.1 → 2.2 → 2.3 → 2.4             # Dashboard package files (sequential)
2.5 → 2.6 → 2.7                    # Env + lib files (2.6 depends on 2.2)
2.8 → 2.9 → 2.10 → 2.11           # Layout + nav (depends on 2.2, 2.7)
3.1 → 3.2 → 3.3                    # Alerts (3.2 depends on 2.7, 3.1)
4.1 → 4.2 → 4.3 → 4.4             # Signals (4.2 depends on 2.1 for recharts)
5.1 → 5.2 → 5.3                    # Markets
6.1 → 6.2 → 6.3 → 6.4             # Wallets (6.3 depends on 6.1 + 6.2)
7.1 → 7.2 → 7.3                    # Health
8.1–8.7 (parallel, deps on API routes and utils)
9.1 → 9.2 → 9.3                    # Docs last
```

---

## Commit Sequence (for Brook)

After each chunk is working + type-checked:
1. After Tasks 1.x: `git add pnpm-workspace.yaml package.json .env.example && git commit -m "feat: monorepo setup (pnpm-workspace.yaml, root scripts)"`
2. After Tasks 2.x: `git commit -m "feat: dashboard scaffold (Next.js 14, Tailwind, shadcn, layout+nav)"`
3. After Tasks 3.x: `git commit -m "feat: alerts page + API route"`
4. After Tasks 4.x: `git commit -m "feat: signals page + API route"`
5. After Tasks 5.x: `git commit -m "feat: markets page + API route"`
6. After Tasks 6.x: `git commit -m "feat: wallets page + API route"`
7. After Tasks 7.x: `git commit -m "feat: health page + API route"`
8. After Tasks 8.x: `git commit -m "feat: vitest tests for API routes + utils"`
9. After Tasks 9.x: `git commit -m "chore: update docs for dashboard"`
10. Final: `git push origin feat/dashboard && gh pr create --base main --title "feat: Phase 6 — Next.js dashboard" --body "..."`

---

## Verification Checklist (before PR)

- [ ] `cd apps/dashboard && pnpm typecheck` — 0 errors
- [ ] `cd apps/dashboard && pnpm test` — all tests pass
- [ ] `pnpm test` at repo root — still 480 tests passing, no regressions
- [ ] `pnpm dashboard:dev` starts Next.js dev server without errors
- [ ] All 5 pages render in browser (no JS console errors)
- [ ] SWR polling visible in Network tab (5s/10s/30s intervals)

---

## TODO
- [ ] Task 1.1: Create `pnpm-workspace.yaml`
- [ ] Task 1.2: Add dashboard scripts to root `package.json`
- [ ] Task 1.3: Add `NEXT_PUBLIC_DASHBOARD_POLL_INTERVAL_MS` to `.env.example`
- [ ] Task 2.1: Create `apps/dashboard/package.json`
- [ ] Task 2.2: Create `apps/dashboard/tsconfig.json`
- [ ] Task 2.3: Create `apps/dashboard/next.config.ts`
- [ ] Task 2.4: Create `apps/dashboard/tailwind.config.ts`
- [ ] Task 2.5: Create `apps/dashboard/.env.local.example`
- [ ] Task 2.6: Create `apps/dashboard/lib/db.ts`
- [ ] Task 2.7: Create `apps/dashboard/lib/utils.ts`
- [ ] Task 2.8: Create root layout `apps/dashboard/app/layout.tsx`
- [ ] Task 2.9: Create `apps/dashboard/components/sidebar.tsx`
- [ ] Task 2.10: Create `apps/dashboard/app/page.tsx`
- [ ] Task 2.11: Create `apps/dashboard/components/stat-card.tsx`
- [ ] Task 3.1: Create `apps/dashboard/app/api/alerts/route.ts`
- [ ] Task 3.2: Create `apps/dashboard/components/alerts-table.tsx`
- [ ] Task 3.3: Create `apps/dashboard/app/alerts/page.tsx`
- [ ] Task 4.1: Create `apps/dashboard/app/api/signals/route.ts`
- [ ] Task 4.2: Create `apps/dashboard/components/signal-sparkline.tsx`
- [ ] Task 4.3: Create `apps/dashboard/components/signals-table.tsx`
- [ ] Task 4.4: Create `apps/dashboard/app/signals/page.tsx`
- [ ] Task 5.1: Create `apps/dashboard/app/api/markets/route.ts`
- [ ] Task 5.2: Create `apps/dashboard/components/markets-heatmap.tsx`
- [ ] Task 5.3: Create `apps/dashboard/app/markets/page.tsx`
- [ ] Task 6.1: Create `apps/dashboard/app/api/wallets/route.ts`
- [ ] Task 6.2: Create `apps/dashboard/app/api/wallets/[address]/alerts/route.ts`
- [ ] Task 6.3: Create `apps/dashboard/components/wallets-table.tsx`
- [ ] Task 6.4: Create `apps/dashboard/app/wallets/page.tsx`
- [ ] Task 7.1: Create `apps/dashboard/app/api/health/route.ts`
- [ ] Task 7.2: Create `apps/dashboard/components/health-panel.tsx`
- [ ] Task 7.3: Create `apps/dashboard/app/health/page.tsx`
- [ ] Task 8.1: Create `apps/dashboard/__tests__/utils.test.ts`
- [ ] Task 8.2: Create `apps/dashboard/__tests__/api-alerts.test.ts`
- [ ] Task 8.3: Create `apps/dashboard/__tests__/api-signals.test.ts`
- [ ] Task 8.4: Create `apps/dashboard/__tests__/api-markets.test.ts`
- [ ] Task 8.5: Create `apps/dashboard/__tests__/api-wallets.test.ts`
- [ ] Task 8.6: Create `apps/dashboard/__tests__/api-health.test.ts`
- [ ] Task 8.7: Create `apps/dashboard/vitest.config.ts`
- [ ] Task 9.1: Update `CLAUDE.md`
- [ ] Task 9.2: Update `README.md`
- [ ] Task 9.3: Update `PROGRESS.md`
