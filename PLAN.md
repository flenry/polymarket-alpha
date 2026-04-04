# Plan: Polymarket Alpha Dashboard (Phase 6 / UI)
# Board-reviewed revision — 2026-04-04

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

## Board-Reviewed Technical Decisions

### LAW-MAJOR-1 — whale_alerts JOIN strategy (CORRECTED)

**Problem**: `transaction_hash` is non-unique in `trades` (partial fills share the same hash).
A join on `transaction_hash + token_id` alone can fan out to multiple rows and return
wrong `side`/`proxy_wallet` values.

**Fix**: The `trade_lookup_key` column encodes the full dedup tuple:
`"txHash|tokenId|proxyWallet|tradedAt|priceUsdc|sizeTokens"`. Use all six parts for the join.

**Implementation**: Raw SQL helper function `getAlertHydrationQuery()` in
`apps/dashboard/lib/alert-hydration.ts` — uses `split_part` to extract each field
and joins on all six columns with proper casts:

```sql
LEFT JOIN trades t ON
  t.transaction_hash = split_part(wa.trade_lookup_key, '|', 1)
  AND t.token_id     = split_part(wa.trade_lookup_key, '|', 2)
  AND t.proxy_wallet = split_part(wa.trade_lookup_key, '|', 3)
  AND t.traded_at    = split_part(wa.trade_lookup_key, '|', 4)::timestamptz
  AND t.price_usdc   = split_part(wa.trade_lookup_key, '|', 5)::numeric
  AND t.size_tokens  = split_part(wa.trade_lookup_key, '|', 6)::numeric
  AND t.traded_at   >= NOW() - INTERVAL '90 days'
```

This guarantees at most one matching trade row per alert (exactly the dedup key).
The `AND t.traded_at >= NOW() - INTERVAL '90 days'` bound on the partitioned column
remains for partition pruning.

### LAW-MAJOR-2 — wallets API filter (CORRECTED)

**Problem**: Filtering on `trade_count >= $minTrades` ranks wallets whose win rate is
statistically immature (zero resolved positions counts the same as a veteran).

**Fix**: Filter on `resolved_trade_count >= $minTrades` (default 3). Keep `trade_count`
as a separate display column. Order by `win_ratio DESC NULLS LAST`.

```sql
WHERE resolved_trade_count >= $minTrades
  AND total_volume_usdc >= $minVolume
ORDER BY win_ratio DESC NULLS LAST
```

`wallet_profiles.resolved_trade_count` and `wallet_profiles.win_ratio` exist in
schema (lines 344–346 of `src/db/schema.ts`). This is exactly what they are for.

### LAW-MAJOR-3 — signals sparkline data source (SPECIFIED)

**Problem**: `/api/signals` is a flat list capped at 200 rows. Deriving a 24h per-hour
sparkline from that list is incorrect (it samples, not aggregates).

**Fix**: Add a dedicated route `/api/signals/volume` that returns a proper bucketed
time-series aggregate:

```
GET /api/signals/volume?hours=24
Response: { buckets: { hour: string, type: string, count: number }[] }
```

SQL:
```sql
SELECT
  date_trunc('hour', created_at) AS hour,
  signal_type AS type,
  COUNT(*)::integer AS count
FROM signals
WHERE created_at >= NOW() - $hours * INTERVAL '1 hour'
GROUP BY hour, signal_type
ORDER BY hour ASC
```

`signal-sparkline.tsx` receives `data: { hour: string, type: string, count: number }[]`
from this route via a separate SWR fetch — not derived from the table data.

### LAW-MINOR-4 — topSignalType determinism (SPECIFIED)

**Problem**: "Subquery or `mode()` aggregate" has undefined tie behavior, making the
heat map badge nondeterministic and test fixtures flaky.

**Fix**: Deterministic rule encoded into the SQL plan:

> **Top signal type = highest COUNT in window; ties break by highest MAX(confidence),
> then lexical order on signal_type.**

SQL:
```sql
SELECT DISTINCT ON (s.token_id)
  s.token_id,
  s.signal_type AS top_signal_type
FROM signals s
WHERE s.created_at >= NOW() - $hours * INTERVAL '1 hour'
  AND s.token_id IN (<the top-20 token IDs from the outer query>)
GROUP BY s.token_id, s.signal_type
ORDER BY s.token_id, COUNT(*) DESC, MAX(s.confidence) DESC NULLS LAST, s.signal_type ASC
```

This must be tested with fixture data that has a tie — assert the correct winner.

### LAW-MINOR-5 — shadcn/ui component strategy (SPECIFIED)

**Problem**: Package versions were placeholders and the component sourcing strategy
was unresolved (init vs. vendor).

**Fix**: Use exact pinned versions. Vendor generated shadcn/ui component files into
`apps/dashboard/components/ui/`. Do NOT run `shadcn-ui init` at build time — instead,
write the component files directly (Brook generates them; Zoro does not need to run
`npx shadcn-ui@latest init`). This keeps the build deterministic in any workspace.

**Pinned versions** (exact, not `^`):

```json
{
  "dependencies": {
    "next": "14.2.3",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "swr": "2.2.5",
    "recharts": "2.12.7",
    "drizzle-orm": "0.40.0",
    "pg": "8.13.3",
    "@radix-ui/react-dialog": "1.1.4",
    "@radix-ui/react-select": "2.1.4",
    "@radix-ui/react-progress": "1.1.1",
    "@radix-ui/react-slot": "1.1.2",
    "@radix-ui/react-tabs": "1.1.3",
    "@radix-ui/react-separator": "1.1.1",
    "class-variance-authority": "0.7.1",
    "clsx": "2.1.1",
    "tailwind-merge": "2.6.0",
    "lucide-react": "0.475.0"
  },
  "devDependencies": {
    "typescript": "5.7.3",
    "@types/node": "22.13.10",
    "@types/react": "18.3.18",
    "@types/react-dom": "18.3.5",
    "@types/pg": "8.11.11",
    "tailwindcss": "3.4.17",
    "postcss": "8.5.3",
    "autoprefixer": "10.4.20",
    "vitest": "3.1.1",
    "@vitejs/plugin-react": "4.3.4"
  }
}
```

**shadcn components to vendor into `components/ui/`**:
- `button.tsx` — Button
- `card.tsx` — Card, CardHeader, CardContent, CardTitle
- `badge.tsx` — Badge
- `table.tsx` — Table, TableHeader, TableBody, TableRow, TableHead, TableCell
- `select.tsx` — Select, SelectTrigger, SelectContent, SelectItem
- `tabs.tsx` — Tabs, TabsList, TabsTrigger, TabsContent
- `skeleton.tsx` — Skeleton
- `sheet.tsx` — Sheet, SheetContent, SheetHeader, SheetTitle (wallet side panel)
- `progress.tsx` — Progress (confidence bar)
- `slider.tsx` — Slider (min confidence filter)

### Dashboard tsconfig
Use `moduleResolution: bundler` (Next.js 14 standard). Root `tsconfig.json` uses
`NodeNext` — these are independent; the dashboard is its own compilation unit.
Relative import `../../src/db/schema.ts` resolves natively under `bundler`.

### pg singleton in Next.js
Use `globalThis.__pgPool` guard in `lib/db.ts` to prevent connection leaks during
hot reload in dev.

### Recharts SSR
`signal-sparkline.tsx` must use `dynamic(() => import('./signal-sparkline-inner'), { ssr: false })`.

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
  - Test: `cat pnpm-workspace.yaml` shows correct content
  - Outcome: `pnpm install` from root resolves both packages

- [ ] **Task 1.2**: Add dashboard scripts to root `package.json`
  - Files: `package.json` (modify scripts only)
  - Add:
    ```json
    "dashboard:dev": "pnpm --filter dashboard dev",
    "dashboard:build": "pnpm --filter dashboard build"
    ```
  - Test: `pnpm dashboard:dev --help` does not error on script resolution
  - Outcome: `pnpm dashboard:dev` launches dashboard from repo root

- [ ] **Task 1.3**: Add `NEXT_PUBLIC_DASHBOARD_POLL_INTERVAL_MS` to root `.env.example`
  - Files: `.env.example` (append)
  - Outcome: env example documents the new var

---

### Chunk 2: Dashboard Scaffold

- [ ] **Task 2.1**: Create `apps/dashboard/package.json`
  - Files: `apps/dashboard/package.json` (new)
  - Use exact pinned versions from LAW-MINOR-5 above
  - Scripts: `dev`, `build`, `test`, `typecheck`
  - Outcome: `pnpm install` in `apps/dashboard/` installs all deps

- [ ] **Task 2.2**: Create `apps/dashboard/tsconfig.json`
  - Files: `apps/dashboard/tsconfig.json` (new)
  - Key settings: `"moduleResolution": "bundler"`, `"strict": true`
  - Extends Next.js 14 defaults (`next/typescript`)
  - Paths: `"@/*": ["./*"]`
  - Include: `["**/*.ts", "**/*.tsx", "../../src/db/schema.ts"]`
  - Outcome: TypeScript resolves shared schema and all internal paths

- [ ] **Task 2.3**: Create `apps/dashboard/next.config.ts`
  - Files: `apps/dashboard/next.config.ts` (new)
  - Minimal Next.js 14 config; no custom webpack needed
  - Outcome: Next.js 14 builds without errors

- [ ] **Task 2.4**: Create `apps/dashboard/tailwind.config.ts`
  - Files: `apps/dashboard/tailwind.config.ts` (new)
  - Content patterns: `["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"]`
  - Extend: `fontFamily: { sans: ['var(--font-inter)', 'sans-serif'] }`
  - Outcome: Tailwind processes all component files

- [ ] **Task 2.5**: Create `apps/dashboard/.env.local.example`
  - Content:
    ```
    DATABASE_URL=postgres://localhost:5432/polymarket_alpha
    NEXT_PUBLIC_DASHBOARD_POLL_INTERVAL_MS=5000
    ```
  - Outcome: New devs know exactly what env vars to set

- [ ] **Task 2.6**: Create `apps/dashboard/lib/db.ts` — DB connection
  - `globalThis.__pgPool` singleton guard
  - `pg.Pool` from `DATABASE_URL`
  - `drizzle(pool, { schema })` — schema imported from `../../src/db/schema.ts`
  - Export `db` and `pool`
  - Outcome: All API routes share one pool

- [ ] **Task 2.7**: Create `apps/dashboard/lib/alert-hydration.ts`
  - Exports `ALERT_TRADE_JOIN_SQL` — the full-tuple join SQL string (see LAW-MAJOR-1)
  - This is the ONLY place the join is defined; API routes import and use it
  - Outcome: Join logic is DRY and testable in isolation

- [ ] **Task 2.8**: Create `apps/dashboard/lib/utils.ts` — shared helpers
  - `formatUSDC(value: number | null | undefined): string`
    → `"$127,400"` (≥$1k: 0 decimals), `"$500.50"` (<$1k: 2 decimals), `"—"` for null
  - `formatAddress(address: string | null | undefined): string`
    → `"0xABCD…1234"` (first 6 + last 4); passthrough if ≤12 chars; `"—"` for null
  - `timeAgo(date: Date | string | null | undefined): string`
    → "just now", "2 min ago", "3h ago", "1d ago"; `"—"` for null
  - `cn(...inputs: ClassValue[]): string` — tailwind-merge + clsx
  - Edge cases: all three display helpers return `"—"` for null/undefined
  - Outcome: Consistent formatting across all components

- [ ] **Task 2.9**: Vendor shadcn/ui components into `apps/dashboard/components/ui/`
  - Files: `button.tsx`, `card.tsx`, `badge.tsx`, `table.tsx`, `select.tsx`, `tabs.tsx`,
    `skeleton.tsx`, `sheet.tsx`, `progress.tsx`, `slider.tsx`
  - Write each file directly (do not run `npx shadcn-ui init`)
  - Outcome: All 10 shadcn primitives available as deterministic source files

- [ ] **Task 2.10**: Create root layout `apps/dashboard/app/layout.tsx`
  - Inter font via `next/font/google`
  - `slate-50` background, flex row: `<Sidebar />` (fixed width) + `<main>` content area
  - Also: `apps/dashboard/app/globals.css` (Tailwind directives)
  - Outcome: All pages share consistent nav and font

- [ ] **Task 2.11**: Create `apps/dashboard/components/sidebar.tsx`
  - Nav items: Alerts, Signals, Markets, Wallets, Health (lucide-react icons)
  - Active state: `slate-100` background, `blue-600` text
  - Outcome: Navigation works across all 5 pages

- [ ] **Task 2.12**: Create `apps/dashboard/app/page.tsx` — root redirect
  - `redirect('/alerts')` via `next/navigation`
  - Outcome: Visiting `/` → `/alerts`

- [ ] **Task 2.13**: Create `apps/dashboard/components/stat-card.tsx`
  - Props: `title`, `value`, `subtitle?`, `className?`
  - White card, 1px `slate-200` border, subtle shadow
  - Outcome: Reusable KPI card

---

### Chunk 3: Alerts Page

- [ ] **Task 3.1**: Create `apps/dashboard/app/api/alerts/route.ts`
  - Query params: `limit` (default 100, max 500), `offset` (≥0), `hours` (1–168, default 24)
  - SQL: Uses `ALERT_TRADE_JOIN_SQL` from `lib/alert-hydration.ts` (full-tuple join per LAW-MAJOR-1)
    ```sql
    SELECT
      wa.*,
      t.side,
      t.proxy_wallet,
      m.question,
      m.slug
    FROM whale_alerts wa
    <ALERT_TRADE_JOIN_SQL>
    LEFT JOIN markets m ON m.token_id = wa.token_id
    WHERE wa.alerted_at >= NOW() - $hours * INTERVAL '1 hour'
    ORDER BY wa.alerted_at DESC
    LIMIT $limit OFFSET $offset
    ```
  - Also runs a `COUNT(*)` query with same WHERE for `total`
  - Returns: `{ alerts: AlertRow[], total: number }`
  - `AlertRow` type: all `whale_alerts` columns + `side: string | null`, `proxyWallet: string | null`, `question: string`, `slug: string | null`
  - Input validation: invalid `hours` or `limit` → 400
  - Error handling: 500 with `{ error: string }` on DB failure
  - Test guidance: mock `db.execute()`. Tests: default params, hours filter, full-tuple join SQL used (not partial), empty result `{ alerts: [], total: 0 }`, malformed hours → 400

- [ ] **Task 3.2**: Create `apps/dashboard/components/alerts-table.tsx`
  - SWR polls `/api/alerts` every 5s
  - Columns: Time | Market | Side | Value (USDC) | Wallet | σ above mean | % daily vol | Enriched?
  - Side badge: green "BUY" / red "SELL"
  - Value: `formatUSDC()`, green for BUY, red for SELL
  - Wallet: `formatAddress()`, links to `/wallets?wallet={address}`
  - Gate badge: derive from `sigmasAboveMean` and `pctOfDailyVolume` — `SIGMA` (blue, σ≥3), `PCT_VOL` (amber, pct≥0.02), `BOTH` (green, both met)
  - Enriched: ✅ if `enrichedAt` set, ⏳ if null
  - Loading: Skeleton rows
  - Empty state: "No whale alerts yet — pipeline may still be warming up"
  - Outcome: Live auto-refreshing alerts table

- [ ] **Task 3.3**: Create `apps/dashboard/app/alerts/page.tsx`
  - 4 stat cards (derived from SWR data): Total alerts 24h | Largest alert | Avg size | Most active market
  - Renders `<AlertsTable />`
  - Outcome: Complete /alerts page

---

### Chunk 4: Signals Page

- [ ] **Task 4.1**: Create `apps/dashboard/app/api/signals/route.ts`
  - Query params: `types` (comma-sep), `minConfidence` (0–1), `hours` (default 24), `tokenId`
  - SQL: SELECT from `signals s` LEFT JOIN `markets m` on `s.token_id = m.token_id`
    WHERE clause applies all filters; ORDER BY `s.created_at DESC` LIMIT 200
  - Validate `types` against `SIGNAL_TYPES = ['WHALE_TRADE','BOOK_IMBALANCE','PRICE_IMPACT_ANOMALY','SENTIMENT_VELOCITY','NEG_RISK_ARB','NEG_RISK_OUTLIER']`; unknown type → 400
  - Returns: `{ signals: SignalRow[] }` — include `payload` as-is
  - Test guidance: default params, valid/invalid types filter, minConfidence clamp, tokenId filter, default 200 limit

- [ ] **Task 4.2**: Create `apps/dashboard/app/api/signals/volume/route.ts`
  - *(New route — per LAW-MAJOR-3)*
  - Query params: `hours` (default 24, max 168)
  - SQL:
    ```sql
    SELECT
      date_trunc('hour', created_at) AS hour,
      signal_type AS type,
      COUNT(*)::integer AS count
    FROM signals
    WHERE created_at >= NOW() - $hours * INTERVAL '1 hour'
    GROUP BY hour, signal_type
    ORDER BY hour ASC
    ```
  - Returns: `{ buckets: { hour: string, type: string, count: number }[] }`
  - Test guidance: correct grouping, empty window → `{ buckets: [] }`, hours clamping

- [ ] **Task 4.3**: Create `apps/dashboard/components/signal-sparkline-inner.tsx`
  - Recharts `BarChart` — stacked bars, one series per signal type, colored per spec
  - Accepts `data: { hour: string, type: string, count: number }[]`
  - Pivots data client-side into `{ hour, WHALE_TRADE, BOOK_IMBALANCE, ... }[]` for stacked bar chart
  - Signal type colors: `WHALE_TRADE` purple, `BOOK_IMBALANCE` blue, `PRICE_IMPACT_ANOMALY` orange, `SENTIMENT_VELOCITY` teal, `NEG_RISK_ARB` indigo, `NEG_RISK_OUTLIER` violet
  - Outcome: Client-side Recharts chart (no SSR)

- [ ] **Task 4.4**: Create `apps/dashboard/components/signal-sparkline.tsx`
  - Wrapper: `dynamic(() => import('./signal-sparkline-inner'), { ssr: false })`
  - SWR fetch from `/api/signals/volume?hours=24` (separate from table data)
  - Outcome: Correctly loaded sparkline at top of /signals page

- [ ] **Task 4.5**: Create `apps/dashboard/components/signals-table.tsx`
  - SWR polls `/api/signals` every 5s with current filter state
  - Filter bar: Signal Type (multi-select), Min Confidence (Slider 0–100), Last N hours (Select)
  - Columns: Time | Market | Signal Type | Direction | Confidence | Strength | Composite Score
  - Signal type badges: per-color spec
  - Direction: ▲ BULL (green) / ▼ BEAR (red) / — NEUTRAL
  - Confidence: Progress bar 0–100%
  - Composite score: read `payload.compositeScore` — show ⭐ + value if present
  - Loading skeleton
  - Outcome: Full-featured signal browser

- [ ] **Task 4.6**: Create `apps/dashboard/app/signals/page.tsx`
  - `<SignalSparkline />` at top + `<SignalsTable />`
  - Outcome: Complete /signals page

---

### Chunk 5: Markets Page

- [ ] **Task 5.1**: Create `apps/dashboard/app/api/markets/route.ts`
  - Query params: `hours` (default 24, max 168)
  - SQL in two parts:
    1. Outer: top-20 markets by signal count in window, JOIN `markets` + `market_stats`
    2. `topSignalType` via `DISTINCT ON` with deterministic tie-breaking (LAW-MINOR-4):
       ```sql
       SELECT DISTINCT ON (s.token_id)
         s.token_id,
         s.signal_type AS top_signal_type
       FROM signals s
       WHERE s.created_at >= NOW() - $hours * INTERVAL '1 hour'
         AND s.token_id = ANY($top20TokenIds)
       GROUP BY s.token_id, s.signal_type
       ORDER BY s.token_id,
                COUNT(*) DESC,
                MAX(s.confidence) DESC NULLS LAST,
                s.signal_type ASC
       ```
  - Returns: `{ markets: MarketRow[] }` — fields: `tokenId`, `question`, `slug`, `signalCount`, `whaleCount`, `topSignalType`, `volume24h`
  - Test guidance: hours filter, empty (0 signals → `{ markets: [] }`), JOIN with no matching market row (null question → omit), **tie-breaking test** — fixture with equal counts, assert lexically-later type loses

- [ ] **Task 5.2**: Create `apps/dashboard/components/markets-heatmap.tsx`
  - SWR polls `/api/markets` every 30s
  - CSS grid (4 cols responsive): each card shows `question`, signal count badge, whale count, `topSignalType` badge, 24h volume
  - Card background: `opacity` scales with signal density relative to max in result set:
    - lowest → `bg-blue-50`
    - mid → `bg-blue-200`
    - highest → `bg-blue-500 text-white`
  - Click: `router.push('/signals?tokenId={tokenId}')`
  - Loading: Skeleton cards
  - Empty state: "No signal activity in the last {hours} hours"
  - Outcome: Visual market heat map with click-through

- [ ] **Task 5.3**: Create `apps/dashboard/app/markets/page.tsx`
  - Renders `<MarketsHeatmap />`
  - Outcome: Complete /markets page

---

### Chunk 6: Wallets Page

- [ ] **Task 6.1**: Create `apps/dashboard/app/api/wallets/route.ts`
  - Query params: `minTrades` (default 3), `minVolume` (default 0), `limit` (default 50, max 200)
  - SQL (LAW-MAJOR-2 fix — `resolved_trade_count`, not `trade_count`):
    ```sql
    SELECT *
    FROM wallet_profiles
    WHERE resolved_trade_count >= $minTrades
      AND total_volume_usdc >= $minVolume
    ORDER BY win_ratio DESC NULLS LAST
    LIMIT $limit
    ```
  - Returns: `{ wallets: WalletRow[] }` with all `wallet_profiles` columns
  - Test guidance: default sort on `win_ratio`, `resolved_trade_count` filter (not `trade_count`), `minVolume` filter, empty result

- [ ] **Task 6.2**: Create `apps/dashboard/app/api/wallets/[address]/alerts/route.ts`
  - Dynamic route: `address` path param
  - Returns last 20 whale alerts for a wallet:
    ```sql
    SELECT wa.*, t.side, m.question, m.slug
    FROM whale_alerts wa
    <ALERT_TRADE_JOIN_SQL>
    LEFT JOIN markets m ON m.token_id = wa.token_id
    WHERE t.proxy_wallet = $address
    ORDER BY wa.alerted_at DESC
    LIMIT 20
    ```
  - Returns: `{ alerts: AlertRow[] }` — empty array (not 404) for unknown address
  - Test guidance: valid address with data, unknown address → `{ alerts: [] }`

- [ ] **Task 6.3**: Create `apps/dashboard/components/wallets-table.tsx`
  - SWR polls `/api/wallets` every 30s
  - Columns: Rank | Wallet | Total Vol | Trades | Win Rate | Whale Trades | Last Seen
    - Note: **Trades** shows `trade_count` (total), but filter uses `resolved_trade_count`
  - Win rate colored: green >60%, amber 40–60%, red <40%
  - Wallet: `formatAddress()`, click opens Sheet side panel
  - Filter inputs: min volume ($), min trades (debounced, 300ms)
  - Side panel (Sheet): SWR fetch of `/api/wallets/{address}/alerts`; shows last 20 alerts table
  - Outcome: Full wallet leaderboard with side panel drill-down

- [ ] **Task 6.4**: Create `apps/dashboard/app/wallets/page.tsx`
  - Renders `<WalletsTable />`
  - Reads `?wallet=0x...` query param to pre-open side panel on mount
  - Outcome: Complete /wallets page

---

### Chunk 7: Health Page

- [ ] **Task 7.1**: Create `apps/dashboard/app/api/health/route.ts`
  - No query params
  - 6 SQL queries (separate, non-transactional):
    1. `SELECT MAX(traded_at) FROM trades` → `lastTradeAt`
    2. `SELECT MAX(captured_at) FROM order_book_snapshots` → `lastSnapshotAt`
    3. `SELECT MAX(refreshed_at) FROM market_stats` → `lastMarketRefreshAt`
    4. `SELECT COUNT(*) FROM trades WHERE traded_at >= NOW() - INTERVAL '5 minutes'` → `tradesLast5Min`
    5. `SELECT COUNT(*) FROM markets WHERE active = true AND watchlisted = true` → `marketsTracked`
    6. `SELECT COUNT(*) FROM markets WHERE neg_risk = true AND active = true` → `negRiskMarketsTracked`
  - Returns per spec (shardsConnected always null)
  - Test guidance: mock all 6 queries, null MAX (no data → null timestamps), full response shape

- [ ] **Task 7.2**: Create `apps/dashboard/components/health-panel.tsx`
  - SWR polls `/api/health` every 10s
  - 4 status cards:
    - **LiveDataWs**: status from `lastTradeAt` — green <30s, amber 30–120s, red >120s
    - **ClobWsPool**: status from `lastSnapshotAt` — same thresholds; shards shown as "Unknown"
    - **GammaPoller**: status from `lastMarketRefreshAt`; shows `marketsTracked` count
    - **DB**: status from `lastTradeAt`; shows `tradesLast5Min` rate
  - Status: colored dot (green/amber/red) + `timeAgo()` timestamp
  - Outcome: Visual pipeline health dashboard

- [ ] **Task 7.3**: Create `apps/dashboard/app/health/page.tsx`
  - Renders `<HealthPanel />`
  - Outcome: Complete /health page

---

### Chunk 8: Tests

- [ ] **Task 8.1**: Create `apps/dashboard/vitest.config.ts`
  - Include: `["__tests__/**/*.test.ts"]`
  - Environment: `node`
  - Outcome: `pnpm test` in dashboard runs only dashboard tests

- [ ] **Task 8.2**: Create `apps/dashboard/__tests__/utils.test.ts`
  - `formatUSDC`: `127400 → "$127,400"`, `500.50 → "$500.50"`, `0 → "$0.00"`, `null → "—"`, `undefined → "—"`
  - `formatAddress`: `"0xABCDEF1234567890abcdef1234" → "0xABCD…f1234"` (first 6, last 4 without 0x prefix, or adjust to spec), short address (≤12 chars) → unchanged, `null → "—"`
  - `timeAgo`: now → "just now", 90s ago → "1 min ago", 2.5h ago → "2h ago", 2d ago → "2d ago", `null → "—"`
  - Outcome: 100% coverage on `lib/utils.ts`

- [ ] **Task 8.3**: Create `apps/dashboard/__tests__/alert-hydration.test.ts`
  - Parse `ALERT_TRADE_JOIN_SQL`: assert it contains all 6 split_part fields
  - Assert `split_part(wa.trade_lookup_key, '|', 3)` (proxy_wallet) is present — not the 2-field join
  - Outcome: Regression guard on LAW-MAJOR-1 fix — any future edit that drops join fields fails here

- [ ] **Task 8.4**: Create `apps/dashboard/__tests__/api-alerts.test.ts`
  - Mock `db.execute()` to return fixture AlertRow data
  - Tests: default params (limit=100, hours=24), hours filter applied to WHERE, empty result → `{ alerts: [], total: 0 }`, invalid hours → 400, limit > 500 → clamped
  - Critical test: SQL string passed to `db.execute()` contains `split_part(..., '|', 3)` (full join)
  - Outcome: Route handler tested in isolation

- [ ] **Task 8.5**: Create `apps/dashboard/__tests__/api-signals.test.ts`
  - Mock Drizzle query chain
  - Tests: types filter (valid/invalid type → 400), minConfidence clamped, tokenId filter, default 200 limit
  - Outcome: Route handler tested in isolation

- [ ] **Task 8.6**: Create `apps/dashboard/__tests__/api-signals-volume.test.ts`
  - Mock `db.execute()` for bucketed query
  - Tests: correct `date_trunc('hour', ...)` grouping, empty window → `{ buckets: [] }`, hours param passed through, hours > 168 → clamped
  - Outcome: Volume route tested in isolation

- [ ] **Task 8.7**: Create `apps/dashboard/__tests__/api-markets.test.ts`
  - Tests: hours filter, empty signals → `{ markets: [] }`, JOIN with no matching market row, **tie-breaking** — fixture with two types at equal count, assert lower lexical order wins
  - Outcome: Route handler tested; tie-breaking behavior locked

- [ ] **Task 8.8**: Create `apps/dashboard/__tests__/api-wallets.test.ts`
  - Tests: default sort by `win_ratio DESC`, filter uses `resolved_trade_count` (not `trade_count`) — assert SQL string, `minVolume` filter, wallet-specific alerts route (valid address / unknown address → `[]`)
  - Critical test: `resolved_trade_count` must appear in WHERE clause (not `trade_count`)
  - Outcome: LAW-MAJOR-2 fix locked in; route handler tested

- [ ] **Task 8.9**: Create `apps/dashboard/__tests__/api-health.test.ts`
  - Tests: all 6 DB queries fired, response shape matches spec, null MAX → null in response, shardsConnected always null
  - Outcome: Route handler tested in isolation

---

### Chunk 9: Documentation

- [ ] **Task 9.1**: Update `CLAUDE.md`
  - Add Phase 6 row: dashboard, test counts, branch `feat/dashboard`
  - Add `apps/dashboard/` to project structure
  - Outcome: CLAUDE.md reflects current state

- [ ] **Task 9.2**: Update `README.md`
  - Add dashboard section: `pnpm dashboard:dev`, pages overview, env vars, screenshot placeholder
  - Outcome: README accurate for new contributors

- [ ] **Task 9.3**: Update `PROGRESS.md`
  - Append Phase 6 entry per standard format
  - Outcome: Crew has continuity context

---

## Execution Order

```
1.1 → 1.2 → 1.3                          # Monorepo setup (independent)
2.1 → 2.2 → 2.3 → 2.4                    # Package + config files (sequential)
2.5 → 2.6 → 2.7 → 2.8                    # Env + lib (2.6/2.7/2.8 depend on 2.2)
2.9                                        # Vendor shadcn/ui components (independent of lib)
2.10 → 2.11 → 2.12 → 2.13                # Layout + nav (depends on 2.2, 2.8, 2.9)
3.1 → 3.2 → 3.3                          # Alerts (3.1 depends on 2.7; 3.2 depends on 2.8, 3.1)
4.1 → 4.2 → 4.3 → 4.4 → 4.5 → 4.6      # Signals (4.1/4.2 independent of each other)
5.1 → 5.2 → 5.3                          # Markets
6.1 → 6.2 → 6.3 → 6.4                   # Wallets (6.3 depends on 6.1+6.2)
7.1 → 7.2 → 7.3                          # Health
8.1 → 8.2 → 8.3 → 8.4 → 8.5 → 8.6 → 8.7 → 8.8 → 8.9  # Tests (deps on API routes + utils)
9.1 → 9.2 → 9.3                          # Docs last
```

---

## Commit Sequence

After each chunk is type-checked and working:

1. `git add pnpm-workspace.yaml package.json .env.example && git commit -m "feat: monorepo setup (pnpm-workspace.yaml, root scripts)"`
2. `git commit -m "feat: dashboard scaffold (Next.js 14, Tailwind, shadcn, layout+nav)"`
3. `git commit -m "feat: alerts page + API route"`
4. `git commit -m "feat: signals page + API route + volume sparkline endpoint"`
5. `git commit -m "feat: markets page + API route"`
6. `git commit -m "feat: wallets page + API route"`
7. `git commit -m "feat: health page + API route"`
8. `git commit -m "feat: vitest tests for API routes + utils"`
9. `git commit -m "chore: update docs for dashboard"`
10. `git push origin feat/dashboard && gh pr create --base main --title "feat: Phase 6 — Next.js dashboard" --body "..."`

---

## Verification Checklist (before PR)

- [ ] `cd apps/dashboard && pnpm typecheck` — 0 errors
- [ ] `cd apps/dashboard && pnpm test` — all tests pass
- [ ] `pnpm test` at repo root — still 480 tests passing (no regressions)
- [ ] `pnpm dashboard:dev` starts Next.js dev server without errors
- [ ] All 5 pages render in browser (no JS console errors)
- [ ] SWR polling visible in Network tab (5s/10s/30s intervals)
- [ ] `/api/alerts` SQL uses full 6-part join (not 2-part)
- [ ] `/api/wallets` SQL filters on `resolved_trade_count` (not `trade_count`)
- [ ] `/api/signals/volume` returns bucketed time-series (separate from flat list)
- [ ] `/api/markets` `topSignalType` tie-breaking test passes

---

## Risk Register (Law findings addressed)

| ID | Law Finding | Severity | Resolution | Task |
|----|-------------|----------|------------|------|
| LAW-MAJOR-1 | whale_alerts → trades join non-unique on tx_hash | MAJOR | Full 6-tuple join via `split_part` on all lookup key fields; DRY via `alert-hydration.ts` | 2.7, 3.1, 6.2 |
| LAW-MAJOR-2 | wallets filter on `trade_count` instead of `resolved_trade_count` | MAJOR | Filter changed to `resolved_trade_count >= $minTrades`; test asserts column name | 6.1, 8.8 |
| LAW-MAJOR-3 | signals sparkline derived from truncated flat list | MAJOR | New `/api/signals/volume` route with proper `date_trunc` GROUP BY; sparkline SWR uses this route | 4.2, 4.4, 8.6 |
| LAW-MINOR-4 | topSignalType nondeterministic on ties | MINOR | Deterministic rule: COUNT DESC → MAX(confidence) DESC → signal_type ASC; locked in test | 5.1, 8.7 |
| LAW-MINOR-5 | shadcn deps placeholder, component sourcing unresolved | MINOR | Exact pinned versions; vendor component files directly (no `npx shadcn-ui init`) | 2.1, 2.9 |

---

## TODO

- [ ] Task 1.1: Create `pnpm-workspace.yaml`
- [ ] Task 1.2: Add dashboard scripts to root `package.json`
- [ ] Task 1.3: Add `NEXT_PUBLIC_DASHBOARD_POLL_INTERVAL_MS` to `.env.example`
- [ ] Task 2.1: Create `apps/dashboard/package.json` (pinned versions)
- [ ] Task 2.2: Create `apps/dashboard/tsconfig.json`
- [ ] Task 2.3: Create `apps/dashboard/next.config.ts`
- [ ] Task 2.4: Create `apps/dashboard/tailwind.config.ts`
- [ ] Task 2.5: Create `apps/dashboard/.env.local.example`
- [ ] Task 2.6: Create `apps/dashboard/lib/db.ts`
- [ ] Task 2.7: Create `apps/dashboard/lib/alert-hydration.ts` ← NEW (LAW-MAJOR-1)
- [ ] Task 2.8: Create `apps/dashboard/lib/utils.ts`
- [ ] Task 2.9: Vendor shadcn/ui components into `components/ui/` (LAW-MINOR-5)
- [ ] Task 2.10: Create root layout `apps/dashboard/app/layout.tsx`
- [ ] Task 2.11: Create `apps/dashboard/components/sidebar.tsx`
- [ ] Task 2.12: Create `apps/dashboard/app/page.tsx`
- [ ] Task 2.13: Create `apps/dashboard/components/stat-card.tsx`
- [ ] Task 3.1: Create `apps/dashboard/app/api/alerts/route.ts`
- [ ] Task 3.2: Create `apps/dashboard/components/alerts-table.tsx`
- [ ] Task 3.3: Create `apps/dashboard/app/alerts/page.tsx`
- [ ] Task 4.1: Create `apps/dashboard/app/api/signals/route.ts`
- [ ] Task 4.2: Create `apps/dashboard/app/api/signals/volume/route.ts` ← NEW (LAW-MAJOR-3)
- [ ] Task 4.3: Create `apps/dashboard/components/signal-sparkline-inner.tsx`
- [ ] Task 4.4: Create `apps/dashboard/components/signal-sparkline.tsx`
- [ ] Task 4.5: Create `apps/dashboard/components/signals-table.tsx`
- [ ] Task 4.6: Create `apps/dashboard/app/signals/page.tsx`
- [ ] Task 5.1: Create `apps/dashboard/app/api/markets/route.ts` (deterministic topSignalType)
- [ ] Task 5.2: Create `apps/dashboard/components/markets-heatmap.tsx`
- [ ] Task 5.3: Create `apps/dashboard/app/markets/page.tsx`
- [ ] Task 6.1: Create `apps/dashboard/app/api/wallets/route.ts` (resolved_trade_count)
- [ ] Task 6.2: Create `apps/dashboard/app/api/wallets/[address]/alerts/route.ts`
- [ ] Task 6.3: Create `apps/dashboard/components/wallets-table.tsx`
- [ ] Task 6.4: Create `apps/dashboard/app/wallets/page.tsx`
- [ ] Task 7.1: Create `apps/dashboard/app/api/health/route.ts`
- [ ] Task 7.2: Create `apps/dashboard/components/health-panel.tsx`
- [ ] Task 7.3: Create `apps/dashboard/app/health/page.tsx`
- [ ] Task 8.1: Create `apps/dashboard/vitest.config.ts`
- [ ] Task 8.2: Create `apps/dashboard/__tests__/utils.test.ts`
- [ ] Task 8.3: Create `apps/dashboard/__tests__/alert-hydration.test.ts` ← NEW (LAW-MAJOR-1 regression guard)
- [ ] Task 8.4: Create `apps/dashboard/__tests__/api-alerts.test.ts`
- [ ] Task 8.5: Create `apps/dashboard/__tests__/api-signals.test.ts`
- [ ] Task 8.6: Create `apps/dashboard/__tests__/api-signals-volume.test.ts` ← NEW (LAW-MAJOR-3)
- [ ] Task 8.7: Create `apps/dashboard/__tests__/api-markets.test.ts`
- [ ] Task 8.8: Create `apps/dashboard/__tests__/api-wallets.test.ts` (resolved_trade_count assertion)
- [ ] Task 8.9: Create `apps/dashboard/__tests__/api-health.test.ts`
- [ ] Task 9.1: Update `CLAUDE.md`
- [ ] Task 9.2: Update `README.md`
- [ ] Task 9.3: Update `PROGRESS.md`
