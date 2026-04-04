/**
 * sync-markets.ts — pulls live markets from Polymarket Gamma API
 *
 * Strategy: Use market ID + outcome as tokenId (stable, unique).
 * The CLOB token IDs (long hashes) need per-market API calls — those can be
 * enriched later by the trades fetcher that queries the CLOB API directly.
 *
 * Phase 1: All active, non-negRisk markets with CLOB support
 * Note: `restricted` flag controls WHO can TRADE, not who can READ the data.
 * We sync everything — we're observing for alpha, not placing trades.
 */

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../db/schema.js";
import { markets, marketStats } from "../db/schema.js";
import { eq, sql, inArray } from "drizzle-orm";

// ─── Gamma API response shape (confirmed via API inspection) ───

interface GammaMarket {
  id: number;
  question: string;
  conditionId: string;
  slug: string;
  description: string;
  groupItemTitle: string;
  icon: string;
  image: string;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  restricted: boolean;
  negRisk: boolean;
  negRiskOther: boolean;
  enableOrderBook: boolean;
  competitive: number;
  groupItemThreshold: number;

  outcomes: string[];       // "Yes", "No"
  outcomePrices: string[];  // "0.535", "0.465"
  clobTokenIds: string[];   // ALL tokens across the event group (NOT per-market)

  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  lastTradePrice: number | null;

  volume: number | null;
  volumeNum: number | null;
  volumeClob: number | null;
  volume24hr: number | null;
  volume1wk: number | null;
  volume1mo: number | null;
  volume1yr: number | null;

  liquidity: number | null;
  liquidityClob: number | null;

  oneHourPriceChange: number | null;
  oneDayPriceChange: number | null;
  oneWeekPriceChange: number | null;
  oneMonthPriceChange: number | null;

  orderPriceMinTickSize: string;
  orderMinSize: string;

  endDate: string;
  endDateIso: string;
  createdAt: string;
  updatedAt: string;

  events?: Array<{
    id: string;
    ticker: string;
    slug: string;
    category?: string;
    title?: string;
  }>;
}

// ─── Fetch markets with pagination ───

async function fetchMarkets(
  offset: number = 0,
  limit: number = 500,
  sortBy: string = "volume"
): Promise<GammaMarket[]> {
  const url = new URL("https://gamma-api.polymarket.com/markets");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("negRisk", "false");
  url.searchParams.set("sort", sortBy);
  url.searchParams.set("ascending", "false");

  console.log(`📡 Fetching ${limit} markets (offset=${offset})...`);
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(
      `Gamma API ${res.status}: ${await res.text().catch(() => "no body")}`
    );
  }

  return (await res.json()) as GammaMarket[];
}

// ─── Derive stable token ID from market + outcome ───

function deriveTokenId(marketId: number, outcome: string): string {
  return `${marketId}-${outcome.toLowerCase()}`;
}

// Check if this is a meaningful market for alpha (not micro-cap noise)
function shouldSync(m: GammaMarket): boolean {
  if (m.negRisk || m.negRiskOther) return false;
  if (!m.acceptingOrders) return false;
  if (!m.enableOrderBook) return false; // need CLOB data
  return true;
}

// ─── Main ───

async function main() {
  const started = Date.now();

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });
  const db = drizzle(pool, { schema });

  console.log("═══════════════════════════════════════════════");
  console.log("  📡 Polymarket Market Sync — LIVE DATA");
  console.log("═══════════════════════════════════════════════\n");

  // ── Fetch (top 1000 by volume, 2 pages) ──
  const allRaw: GammaMarket[] = [];
  for (let page = 0; page < 2; page++) {
    const batch = await fetchMarkets(page * 500, 500);
    allRaw.push(...batch);
    if (batch.length < 500) break;
  }
  console.log(`\nTotal fetched: ${allRaw.length}\n`);

  // ── Filter ──
  const filtered = allRaw.filter(shouldSync);
  console.log(`Usable markets: ${filtered.length}\n`);

  // ── Compute which markets to keep ──
  // Derive token IDs for this sync run
  // NOTE: outcomes and outcomePrices are JSON-encoded strings, must parse first
  const syncedTokenIds = new Set<string>();
  for (const m of filtered) {
    let parsedOutcomes: string[];
    try {
      parsedOutcomes = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes;
    } catch { continue; }
    if (parsedOutcomes.length >= 2) {
      syncedTokenIds.add(deriveTokenId(m.id, parsedOutcomes[0]));
      syncedTokenIds.add(deriveTokenId(m.id, parsedOutcomes[1]));
    }
  }

  // ── Fetch existing markets to determine inserts vs updates vs removals ──
  const existingMarkets = await db
    .select({ tokenId: markets.tokenId })
    .from(markets)
    .execute();

  const existingTokenIds = new Set(existingMarkets.map((r) => r.tokenId));
  const toInsert = Array.from(syncedTokenIds).filter(
    (id) => !existingTokenIds.has(id)
  );
  const toUpdate = Array.from(syncedTokenIds).filter((id) =>
    existingTokenIds.has(id)
  );
  const toRemove = existingMarkets.filter(
    (r) => !syncedTokenIds.has(r.tokenId)
  );

  console.log(
    `  New: ${toInsert.length} | Update: ${toUpdate.length} | Remove: ${toRemove.length}\n`
  );

  // ── Upsert new + updated ──
  let inserted = 0;
  let updated = 0;
  let errors = 0;

  for (const m of filtered) {
    if (!m.outcomes || m.outcomes.length < 1 || !m.outcomePrices) continue;

    const eventSlug = m.events?.[0]?.slug ?? m.slug;

    // Parse JSON-encoded string fields — Gamma returns these as strings, NOT arrays
    let outcomes: string[];
    let prices: string[];
    try {
      outcomes = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes;
      prices = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
    } catch {
      continue;
    }
    if (!outcomes || !prices || outcomes.length < 1) continue;

    for (let i = 0; i < outcomes.length; i++) {
      const tokenId = deriveTokenId(m.id, outcomes[i]);
      const price = parseFloat(prices[i] ?? "0");
      if (isNaN(price)) continue;

      try {
        await db
          .insert(markets)
          .values({
            tokenId,
            conditionId: m.conditionId,
            gammaMarketId: String(m.id),
            question: m.question,
            slug: m.slug,
            eventSlug,
            // Category — try multiple fields from Gamma API
            category: m.groupItemTitle || 
                      m.events?.[0]?.category ||
                      m.events?.[0]?.title || null,
            outcome: outcomes[i],
            outcomeIndex: i,
            minimumOrderSize: m.orderMinSize || "0.01",
            minimumTickSize: m.orderPriceMinTickSize || "0.01",
            negRisk: false,
            watchlisted: m.competitive >= 0.95,
            acceptingOrders: m.acceptingOrders,
            active: m.active,
            closed: m.closed,
            endDate: m.endDate ? new Date(m.endDate) : null,
            iconUrl: m.icon || null,
          })
          .onConflictDoUpdate({
            target: markets.tokenId,
            set: {
              question: sql`EXCLUDED.question`,
              slug: sql`EXCLUDED.slug`,
              eventSlug: sql`EXCLUDED.event_slug`,
              category: sql`EXCLUDED.category`,
              acceptingOrders: sql`EXCLUDED.accepting_orders`,
              active: sql`EXCLUDED.active`,
              closed: sql`EXCLUDED.closed`,
              updatedAt: sql`NOW()`,
              iconUrl: sql`EXCLUDED.icon_url`,
              watchlisted: sql`EXCLUDED.watchlisted`,
              endDate: sql`EXCLUDED.end_date`,
            },
          })
          .execute();

        // Stats
        await db
          .insert(marketStats)
          .values({
            tokenId,
            conditionId: m.conditionId,
            bestBid: m.bestBid != null ? String(m.bestBid) : null,
            bestAsk: m.bestAsk != null ? String(m.bestAsk) : null,
            mid: price.toFixed(6),
            spread: m.spread != null ? String(m.spread) : null,
            lastTradePrice:
              m.lastTradePrice != null ? String(m.lastTradePrice) : price.toFixed(6),
            volume24hr: m.volume24hr != null ? String(m.volume24hr) : "0",
            volume1wk: m.volume1wk != null ? String(m.volume1wk) : "0",
            volume1mo: m.volume1mo != null ? String(m.volume1mo) : "0",
            volumeTotal: m.volume != null ? String(m.volume) : "0",
            liquidityUsdc: m.liquidity != null ? String(m.liquidity) : "0",
            openInterest: "0",
            avgTradeSize24h: null,
            stddevTradeSize24h: null,
            calibrated: false,
            bootstrapTradeCount: 0,
            tradeCount24h: 0,
            oneHourPriceChange:
              m.oneHourPriceChange != null
                ? String(m.oneHourPriceChange)
                : null,
            oneDayPriceChange:
              m.oneDayPriceChange != null ? String(m.oneDayPriceChange) : null,
            oneWeekPriceChange:
              m.oneWeekPriceChange != null ? String(m.oneWeekPriceChange) : null,
            competitive:
              m.competitive != null ? String(m.competitive) : "0",
            refreshedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: marketStats.tokenId,
            set: {
              bestBid: sql`EXCLUDED.best_bid`,
              bestAsk: sql`EXCLUDED.best_ask`,
              mid: sql`EXCLUDED.mid`,
              spread: sql`EXCLUDED.spread`,
              lastTradePrice: sql`EXCLUDED.last_trade_price`,
              volume24hr: sql`EXCLUDED.volume_24hr`,
              volume1wk: sql`EXCLUDED.volume_1wk`,
              volume1mo: sql`EXCLUDED.volume_1mo`,
              volumeTotal: sql`EXCLUDED.volume_total`,
              liquidityUsdc: sql`EXCLUDED.liquidity_usdc`,
              oneHourPriceChange: sql`EXCLUDED.one_hour_price_change`,
              oneDayPriceChange: sql`EXCLUDED.one_day_price_change`,
              oneWeekPriceChange: sql`EXCLUDED.one_week_price_change`,
              competitive: sql`EXCLUDED.competitive`,
              refreshedAt: sql`NOW()`,
            },
          })
          .execute();

        inserted++;
      } catch (e: any) {
        errors++;
        if (errors <= 3) {
          console.warn(
            `⚠️  ${tokenId}: ${e.message?.slice(0, 120) || String(e)}`
          );
        }
      }
    }
  }

  // ── Cleanup: remove stale markets ──
  // Stats first (FK → markets), then markets
  let removed = 0;
  for (const row of toRemove) {
    await db
      .delete(marketStats)
      .where(eq(marketStats.tokenId, row.tokenId))
      .execute();
    await db.delete(markets).where(eq(markets.tokenId, row.tokenId)).execute();
    removed++;
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  // ── Summary ──
  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`  ✅ Sync complete — ${elapsed}s`);
  console.log(`     Raw fetched:    ${allRaw.length}`);
  console.log(`     Usable:         ${filtered.length}`);
  console.log(`     Rows upserted:  ${inserted}`);
  console.log(`     Removed (gone): ${removed}`);
  console.log(`     Errors:         ${errors}`);
  console.log("═══════════════════════════════════════════════");

  // ── Top 5 by total volume ──
  const top = await db
    .select({
      question: markets.question,
      outcome: markets.outcome,
      category: markets.category,
      mid: marketStats.mid,
      spread: marketStats.spread,
      volume24hr: marketStats.volume24hr,
      liquidity: marketStats.liquidityUsdc,
      oneDay: marketStats.oneDayPriceChange,
    })
    .from(marketStats)
    .innerJoin(markets, eq(markets.tokenId, marketStats.tokenId))
    .orderBy(sql`CAST(${marketStats.volumeTotal} AS numeric) DESC`)
    .limit(5)
    .execute();

  console.log("\n🏆 Top 5 by total volume:");
  for (const t of top) {
    const pct = t.mid ? (parseFloat(t.mid) * 100).toFixed(1) + "¢" : "—";
    const vol = t.volume24hr
      ? `$${parseFloat(t.volume24hr).toLocaleString()}`
      : "—";
    const liq = t.liquidity
      ? `$${parseFloat(t.liquidity).toLocaleString()}`
      : "—";
    const oneD = t.oneDay ? `${(parseFloat(t.oneDay) * 100).toFixed(1)}%` : "—";
    console.log(
      `  ${pct} | ${t.question} [${t.outcome}] | ${t.category || "?"} | 24h vol ${vol} | liq ${liq} | 24hΔ ${oneD}`
    );
  }
  console.log();

  await pool.end();
}

main().catch((e) => {
  console.error("❌ Sync failed:", e.message);
  process.exit(1);
});
