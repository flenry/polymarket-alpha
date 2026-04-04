import "dotenv/config";
import http from "http";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../db/schema.js";
import { markets, trades, marketStats, whaleAlerts, walletProfiles, orderBookSnapshots } from "../db/schema.js";
import { desc, sql, eq, inArray } from "drizzle-orm";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });

const PORT = 3456;

// ─── Background sync state ───────────────────────────────────────────────────

let lastSyncAt: Date | null = null;
let syncInProgress = false;
let syncErrorCount = 0;

// ─── Gamma API types (inlined from sync-markets.ts) ─────────────────────────

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
  outcomes: string[];
  outcomePrices: string[];
  clobTokenIds: string[];
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
  events?: Array<{ id: string; ticker: string; slug: string; category?: string; title?: string }>;
}

async function fetchGammaMarkets(offset: number, limit: number): Promise<GammaMarket[]> {
  const url = new URL("https://gamma-api.polymarket.com/markets");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("negRisk", "false");
  url.searchParams.set("sort", "volume");
  url.searchParams.set("ascending", "false");
  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Gamma API ${res.status}: ${await res.text().catch(() => "no body")}`);
  return (await res.json()) as GammaMarket[];
}

function deriveTokenId(marketId: number, outcome: string): string {
  return `${marketId}-${outcome.toLowerCase()}`;
}

function shouldSync(m: GammaMarket): boolean {
  if (m.negRisk || m.negRiskOther) return false;
  if (!m.acceptingOrders) return false;
  if (!m.enableOrderBook) return false;
  return true;
}

async function runSync(): Promise<void> {
  if (syncInProgress) return;
  syncInProgress = true;
  console.log("🔄 Background market sync starting…");

  try {
    // Fetch top 1000 markets (2 pages of 500)
    const allRaw: GammaMarket[] = [];
    for (let page = 0; page < 2; page++) {
      const batch = await fetchGammaMarkets(page * 500, 500);
      allRaw.push(...batch);
      if (batch.length < 500) break;
    }

    const filtered = allRaw.filter(shouldSync);

    // Compute token IDs for this sync run
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

    // Existing markets
    const existingMarkets = await db.select({ tokenId: markets.tokenId }).from(markets).execute();
    const existingTokenIds = new Set(existingMarkets.map(r => r.tokenId));
    const toRemove = existingMarkets.filter(r => !syncedTokenIds.has(r.tokenId));

    let upserted = 0;
    let errors = 0;

    for (const m of filtered) {
      if (!m.outcomes || !m.outcomePrices) continue;
      const eventSlug = m.events?.[0]?.slug ?? m.slug;

      let outcomes: string[];
      let prices: string[];
      try {
        outcomes = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes;
        prices = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
      } catch { continue; }
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
              category: m.groupItemTitle || m.events?.[0]?.category || m.events?.[0]?.title || null,
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

          await db
            .insert(marketStats)
            .values({
              tokenId,
              conditionId: m.conditionId,
              bestBid: m.bestBid != null ? String(m.bestBid) : null,
              bestAsk: m.bestAsk != null ? String(m.bestAsk) : null,
              mid: price.toFixed(6),
              spread: m.spread != null ? String(m.spread) : null,
              lastTradePrice: m.lastTradePrice != null ? String(m.lastTradePrice) : price.toFixed(6),
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
              oneHourPriceChange: m.oneHourPriceChange != null ? String(m.oneHourPriceChange) : null,
              oneDayPriceChange: m.oneDayPriceChange != null ? String(m.oneDayPriceChange) : null,
              oneWeekPriceChange: m.oneWeekPriceChange != null ? String(m.oneWeekPriceChange) : null,
              competitive: m.competitive != null ? String(m.competitive) : "0",
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

          upserted++;
        } catch (e: unknown) {
          errors++;
          if (errors <= 3) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`⚠️  sync ${tokenId}: ${msg.slice(0, 120)}`);
          }
        }
      }
    }

    // Cleanup stale markets
    for (const row of toRemove) {
      await db.delete(marketStats).where(eq(marketStats.tokenId, row.tokenId)).execute();
      await db.delete(markets).where(eq(markets.tokenId, row.tokenId)).execute();
    }

    lastSyncAt = new Date();
    syncErrorCount = 0;
    console.log(`✅ Sync complete — ${upserted} upserted, ${toRemove.length} removed, ${errors} errors`);
  } catch (e: unknown) {
    syncErrorCount++;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`❌ Sync failed (#${syncErrorCount}): ${msg}`);
  } finally {
    syncInProgress = false;
  }
}

// ─── HTTP request handler ────────────────────────────────────────────────────

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url!, `http://localhost:${PORT}`);

  // ── /api/sync-status ──
  if (url.pathname === "/api/sync-status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      lastSyncAt: lastSyncAt?.toISOString() ?? null,
      syncInProgress,
      syncErrorCount,
    }));
    return;
  }

  // ── /api/summary ──
  if (url.pathname === "/api/summary") {
    const [mkts, trdCnt, stats, alerts, wallets, snaps] = await Promise.all([
      db.select().from(markets).limit(50),
      db.select({ count: sql<number>`count(*)` }).from(trades),
      db.select().from(marketStats).limit(50),
      db.select({
        usdcValue: whaleAlerts.usdcValue,
        sigmasAboveMean: whaleAlerts.sigmasAboveMean,
        pctOfDailyVolume: whaleAlerts.pctOfDailyVolume,
        alertedAt: whaleAlerts.alertedAt,
        tokenId: whaleAlerts.tokenId,
        tradeLookupKey: whaleAlerts.tradeLookupKey,
      })
        .from(whaleAlerts)
        .orderBy(desc(whaleAlerts.usdcValue))
        .limit(20),
      db.select().from(walletProfiles).orderBy(desc(walletProfiles.totalVolumeUsdc)).limit(20),
      db.select({
        tokenId: orderBookSnapshots.tokenId,
        mid: orderBookSnapshots.mid,
        imbalanceRatio: orderBookSnapshots.imbalanceRatio,
        capturedAt: orderBookSnapshots.capturedAt,
      })
        .from(orderBookSnapshots)
        .orderBy(desc(orderBookSnapshots.capturedAt))
        .limit(50),
    ]);

    const marketMap = new Map(mkts.map(m => [m.tokenId, { question: m.question, outcome: m.outcome, category: m.category, slug: m.slug }]));
    const enrichedAlerts = alerts.map(a => {
      const market = marketMap.get(a.tokenId);
      const parts = (a.tradeLookupKey || "").split("|");
      return {
        ...a,
        marketQuestion: market?.question || "Unknown",
        marketOutcome: market?.outcome || "",
        marketCategory: market?.category || "",
        wallet: parts[2] || a.tradeLookupKey || "",
      };
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ markets: mkts, trades: trdCnt[0].count, stats, alerts: enrichedAlerts, wallets, bookSnapshots: snaps }));
    return;
  }

  // ── /api/recent-trades ──
  if (url.pathname === "/api/recent-trades") {
    const tradeRows = await db
      .select({
        tokenId: trades.tokenId,
        side: trades.side,
        priceUsdc: trades.priceUsdc,
        sizeTokens: trades.sizeTokens,
        valueUsdc: trades.valueUsdc,
        proxyWallet: trades.proxyWallet,
        tradedAt: trades.tradedAt,
        traderName: trades.traderName,
        traderPseudonym: trades.traderPseudonym,
      })
      .from(trades)
      .orderBy(desc(trades.tradedAt))
      .limit(50);

    const marketIds = [...new Set(tradeRows.map(t => t.tokenId))];
    const mktRows = marketIds.length > 0
      ? await db.select().from(markets).where(inArray(markets.tokenId, marketIds)).limit(50)
      : [];
    const marketMap = new Map(mktRows.map(m => [m.tokenId, { question: m.question, outcome: m.outcome, category: m.category }]));

    const enrichedTrades = tradeRows.map(t => ({
      ...t,
      marketQuestion: marketMap.get(t.tokenId)?.question || "",
      marketOutcome: marketMap.get(t.tokenId)?.outcome || "",
    }));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(enrichedTrades));
    return;
  }

  // ── HTML dashboard ──
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getDashboardHTML());
    return;
  }

  res.writeHead(404);
  res.end("Not found");
}

// ─── Dashboard HTML ──────────────────────────────────────────────────────────

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Polymarket Alpha — Dashboard</title>
<style>
  :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #c9d1d9; --muted: #8b949e;
    --green: #3fb950; --red: #f85149; --blue: #58a6ff; --yellow: #d29922; --accent: #bc8cff; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace; }
  .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
  h1 { font-size: 1.6em; margin-bottom: 4px; }
  h2 { font-size: 1.15em; color: var(--blue); border-bottom: 1px solid var(--border); padding-bottom: 6px; margin: 0 0 12px; }
  .subtitle { color: var(--muted); margin-bottom: 20px; }

  /* Summary cards */
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card .label { font-size: 0.8em; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .card .value { font-size: 1.8em; font-weight: 700; margin-top: 4px; color: #fff; }
  .card .sub { font-size: 0.75em; color: var(--muted); margin-top: 2px; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  th { text-align: left; padding: 8px 10px; color: var(--muted); border-bottom: 1px solid var(--border); font-weight: 500; font-size: 0.85em; text-transform: uppercase; }
  td { padding: 8px 10px; border-bottom: 1px solid var(--border); }
  tr:hover { background: rgba(88,166,255,0.04); }
  .num { font-variant-numeric: tabular-nums; text-align: right; }
  .buy { color: var(--green); }
  .sell { color: var(--red); }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.8em; font-weight: 600; }
  .badge-yes { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge-no { background: rgba(248,81,73,0.15); color: var(--red); }
  .badge-cat { background: rgba(88,166,255,0.1); color: var(--blue); }
  .wallet { font-family: monospace; font-size: 0.9em; }
  .alert-row { border-left: 3px solid var(--yellow); }
  .sigma { color: var(--yellow); font-weight: 700; }

  /* Status bar */
  .status-bar { display: flex; align-items: center; gap: 16px; color: var(--muted); font-size: 0.8em; margin-bottom: 20px; flex-wrap: wrap; }
  .status-bar .refresh-info { }
  .sync-status { display: flex; align-items: center; gap: 5px; }
  .sync-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .sync-dot.green { background: var(--green); }
  .sync-dot.yellow { background: var(--yellow); animation: pulse 1s infinite; }
  .sync-dot.red { background: var(--red); }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

  /* Tabs */
  .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); margin-bottom: 20px; }
  .tab-btn { background: none; border: none; color: var(--muted); padding: 10px 20px; cursor: pointer; font-size: 0.9em; font-family: inherit; border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color 0.15s, border-color 0.15s; }
  .tab-btn:hover { color: var(--text); }
  .tab-btn.active { color: var(--blue); border-bottom-color: var(--blue); }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
</style>
</head>
<body>
<div class="container">
  <h1>⚡ Polymarket Alpha</h1>
  <p class="subtitle">Real-time Polymarket data — gamma API sync + live signals</p>

  <div class="status-bar">
    <span class="refresh-info">Auto-refreshes every 10s · <span id="conn-status" style="color:var(--green)">● loading</span></span>
    <span class="sync-status" id="sync-status"><span class="sync-dot yellow" id="sync-dot"></span><span id="sync-text">Waiting for sync…</span></span>
  </div>

  <div class="cards" id="cards"></div>

  <div class="tabs">
    <button class="tab-btn active" data-tab="markets">📊 Markets</button>
    <button class="tab-btn" data-tab="alerts">🐋 Whale Alerts</button>
    <button class="tab-btn" data-tab="trades">💹 Trades</button>
    <button class="tab-btn" data-tab="wallets">👛 Wallets</button>
  </div>

  <div id="tab-markets" class="tab-content active">
    <h2>📊 Markets</h2>
    <table><thead><tr>
      <th>Question</th><th>Side</th><th>Category</th><th class="num">Mid</th><th class="num">Spread</th><th class="num">24h Vol</th><th>⭐</th>
    </tr></thead><tbody id="markets-body"></tbody></table>
  </div>

  <div id="tab-alerts" class="tab-content">
    <h2>🐋 Whale Alerts</h2>
    <table><thead><tr>
      <th class="num">Value</th><th class="num">σ Above</th><th>Side</th><th>Market</th><th>Wallet</th><th class="num">When</th>
    </tr></thead><tbody id="alerts-body"></tbody></table>
  </div>

  <div id="tab-trades" class="tab-content">
    <h2>💹 Recent Trades</h2>
    <table><thead><tr>
      <th class="num">Time</th><th class="num">Side</th><th>Market</th><th class="num">Price</th><th class="num">Size</th><th class="num">Value</th><th>Wallet</th>
    </tr></thead><tbody id="trades-body"></tbody></table>
  </div>

  <div id="tab-wallets" class="tab-content">
    <h2>👛 Wallet Profiles</h2>
    <table><thead><tr>
      <th>Name</th><th>Wallet</th><th class="num">Total Volume</th><th class="num">Trades</th><th class="num">Whale</th><th class="num">Win%</th>
    </tr></thead><tbody id="wallets-body"></tbody></table>
  </div>
</div>

<script>
// ── Tab navigation ──
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.getAttribute('data-tab');
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + tab).classList.add('active');
  });
});

// ── Sync status ──
async function updateSyncStatus() {
  try {
    const s = await fetch('/api/sync-status').then(r => r.json());
    const dot = document.getElementById('sync-dot');
    const text = document.getElementById('sync-text');
    if (s.syncInProgress) {
      dot.className = 'sync-dot yellow';
      text.textContent = 'Syncing…';
    } else if (s.syncErrorCount > 0 && !s.lastSyncAt) {
      dot.className = 'sync-dot red';
      text.textContent = 'Sync error · retried ' + s.syncErrorCount;
      text.style.color = 'var(--red)';
    } else if (s.lastSyncAt) {
      dot.className = 'sync-dot green';
      const ago = timeAgo(s.lastSyncAt);
      const suffix = s.syncErrorCount > 0 ? ' · errors ' + s.syncErrorCount : '';
      text.textContent = 'Live · last sync ' + ago + suffix;
      text.style.color = '';
    } else {
      dot.className = 'sync-dot yellow';
      text.textContent = 'Awaiting first sync…';
    }
  } catch(_) {}
}

// ── Data load ──
async function load() {
  try {
    const [summary, recentTrades] = await Promise.all([
      fetch('/api/summary').then(r => r.json()),
      fetch('/api/recent-trades').then(r => r.json())
    ]);

    // Cards
    const s = summary.stats || [];
    const totalVol = s.reduce((a,x) => a + parseFloat(x.volume24hr || 0), 0);
    const totalLiq = s.reduce((a,x) => a + parseFloat(x.liquidityUsdc || 0), 0);
    document.getElementById('cards').innerHTML = [
      {label: 'Markets', value: summary.markets.length, sub: 'active markets'},
      {label: 'Total Trades', value: summary.trades, sub: 'seeded'},
      {label: '24h Volume', value: formatUsd(String(totalVol)), sub: 'across all markets'},
      {label: 'Liquidity', value: formatUsd(String(totalLiq)), sub: 'total available'},
      {label: 'Whale Alerts', value: summary.alerts.length, sub: 'above threshold'},
      {label: 'Tracked Wallets', value: summary.wallets.length, sub: summary.wallets.length + ' profiles'},
    ].map(c => '<div class="card"><div class="label">'+c.label+'</div><div class="value">'+c.value+'</div><div class="sub">'+c.sub+'</div></div>').join('');

    // Stats map
    const statMap = {};
    (summary.stats||[]).forEach(s => statMap[s.tokenId] = s);

    // Markets table
    document.getElementById('markets-body').innerHTML = summary.markets.map(m => {
      const st = statMap[m.tokenId] || {};
      return '<tr>' +
        '<td>'+m.question+'</td>' +
        '<td><span class="badge badge-'+m.outcome.toLowerCase()+'">'+m.outcome+'</span></td>' +
        '<td><span class="badge badge-cat">'+(m.category||'—')+'</span></td>' +
        '<td class="num">'+(st.mid ? (parseFloat(st.mid)*100).toFixed(1)+'¢' : '—')+'</td>' +
        '<td class="num">'+(st.spread ? parseFloat(st.spread).toFixed(3) : '—')+'</td>' +
        '<td class="num">'+formatUsd(st.volume24hr)+'</td>' +
        '<td>'+(m.watchlisted ? '⭐' : '')+'</td>' +
      '</tr>';
    }).join('');

    // Whale alerts table — full question + full wallet address
    document.getElementById('alerts-body').innerHTML = summary.alerts.map(a => {
      const short = a.marketQuestion.length > 80 ? a.marketQuestion.slice(0,77)+'…' : a.marketQuestion;
      return '<tr class="alert-row">' +
        '<td class="num" style="font-weight:700">'+formatUsd(a.usdcValue)+'</td>' +
        '<td class="num sigma">'+parseFloat(a.sigmasAboveMean || 0).toFixed(1)+'σ</td>' +
        '<td><span class="badge badge-'+(a.marketOutcome||'').toLowerCase()+'">'+(a.marketOutcome||'?')+'</span></td>' +
        '<td class="market-question">'+short+'</td>' +
        '<td class="wallet">'+a.wallet+'</td>' +
        '<td>'+timeAgo(a.alertedAt)+'</td>' +
      '</tr>';
    }).join('') || '<tr><td colspan="6" style="color:var(--muted);text-align:center">No whale alerts yet</td></tr>';

    // Recent trades table — full detail, full wallet address
    document.getElementById('trades-body').innerHTML = recentTrades.slice(0, 30).map(t => {
      const cls = t.side === 'BUY' ? 'buy' : 'sell';
      const arrow = t.side === 'BUY' ? '▲' : '▼';
      const shortQ = (t.marketQuestion||'').length > 60 ? (t.marketQuestion||'').slice(0,57)+'…' : (t.marketQuestion||'');
      return '<tr>' +
        '<td>'+timeAgo(t.tradedAt)+'</td>' +
        '<td class="'+cls+'" style="font-weight:700">'+arrow+' '+t.side+'</td>' +
        '<td><span class="badge badge-'+((t.marketOutcome||'').toLowerCase())+'">'+(t.marketOutcome||'?')+'</span><br>' +
        '<span class="market-question" style="font-size:0.95em; color: var(--muted);">'+shortQ+'</span></td>' +
        '<td class="num">'+(parseFloat(t.priceUsdc)*100).toFixed(2)+'¢</td>' +
        '<td class="num">'+parseFloat(t.sizeTokens).toFixed(0)+'</td>' +
        '<td class="num" style="font-weight:700">'+formatUsd(t.valueUsdc)+'</td>' +
        '<td class="wallet">'+t.proxyWallet+'</td>' +
      '</tr>';
    }).join('');

    // Wallets table — full wallet address
    document.getElementById('wallets-body').innerHTML = summary.wallets.map(w => {
      const pw = w.proxyWallet || '';
      return '<tr>' +
        '<td>'+(w.displayName||'Unknown')+'</td>' +
        '<td class="wallet">'+pw+'</td>' +
        '<td class="num">'+formatUsd(w.totalVolumeUsdc)+'</td>' +
        '<td class="num">'+(w.tradeCount||0)+'</td>' +
        '<td class="num" style="color:var(--yellow)">'+(w.whaleTradeCount||0)+'</td>' +
        '<td class="num">'+(w.winRatio ? (parseFloat(w.winRatio)*100).toFixed(1)+'%' : '—')+'</td>' +
      '</tr>';
    }).join('');

    document.getElementById('conn-status').innerHTML = '● connected';
    document.getElementById('conn-status').style.color = 'var(--green)';
  } catch(e) {
    document.getElementById('conn-status').innerHTML = '● error: '+e.message;
    document.getElementById('conn-status').style.color = 'var(--red)';
  }
}

function formatUsd(v) {
  if (!v) return '—';
  const n = parseFloat(v);
  if (isNaN(n)) return '—';
  if (n >= 1000000) return '$'+(n/1000000).toFixed(1)+'M';
  if (n >= 1000) return '$'+(n/1000).toFixed(0)+'K';
  return '$'+n.toFixed(0);
}

function timeAgo(d) {
  if (!d) return '—';
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return s+'s ago';
  if (s < 3600) return Math.floor(s/60)+'m ago';
  return Math.floor(s/3600)+'h ago';
}

load();
updateSyncStatus();
setInterval(load, 10000);
setInterval(updateSyncStatus, 5000);
</script>
</body>
</html>`;
}

// ─── Start server + background sync ─────────────────────────────────────────

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`🚀 Polymarket Alpha Dashboard running at http://localhost:${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`🔌 API:     http://localhost:${PORT}/api/summary`);
  console.log(`🔄 Background sync: every 5 minutes`);

  // Initial sync on startup
  runSync().catch(e => console.error("Initial sync error:", e));

  // Repeat every 5 minutes
  setInterval(() => {
    runSync().catch(e => console.error("Periodic sync error:", e));
  }, 5 * 60 * 1000);

  // Try to open in browser on Mac
  import("child_process").then(({ exec }) => {
    exec(`open http://localhost:${PORT}`);
  });
});

pool.on("error", (err) => {
  console.error("⚠️  Database pool error:", err.message);
});
