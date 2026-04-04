import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../db/schema.js";
import { markets, marketStats, orderBookSnapshots, priceHistory, whaleAlerts, signals, walletProfiles, trades } from "../db/schema.js";
import { sql } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Seed data for polymarket-alpha — realistic markets, trades, OB snapshots
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_MARKETS = [
  {
    tokenId: "yes-token-1",
    conditionId: "cond-0x1111",
    gammaMarketId: "gamma-001",
    question: "Will Bitcoin exceed $200,000 in 2026?",
    slug: "bitcoin-200k-2026",
    eventSlug: "bitcoin-price-2026",
    category: "Crypto",
    outcome: "Yes",
    outcomeIndex: 0,
    minimumOrderSize: "0.01",
    minimumTickSize: "0.01",
    negRisk: false,
    watchlisted: true,
    acceptingOrders: true,
    active: true,
    closed: false,
    endDate: new Date("2026-12-31T23:59:59Z"),
  },
  {
    tokenId: "no-token-1",
    conditionId: "cond-0x1111",
    gammaMarketId: "gamma-001",
    question: "Will Bitcoin exceed $200,000 in 2026?",
    slug: "bitcoin-200k-2026",
    eventSlug: "bitcoin-price-2026",
    category: "Crypto",
    outcome: "No",
    outcomeIndex: 1,
    minimumOrderSize: "0.01",
    minimumTickSize: "0.01",
    negRisk: false,
    watchlisted: true,
    acceptingOrders: true,
    active: true,
    closed: false,
    endDate: new Date("2026-12-31T23:59:59Z"),
  },
  {
    tokenId: "yes-token-2",
    conditionId: "cond-0x2222",
    gammaMarketId: "gamma-002",
    question: "Will the US Fed cut rates in May 2026?",
    slug: "fed-rates-may-2026",
    eventSlug: "fed-rate-decisions",
    category: "Politics",
    outcome: "Yes",
    outcomeIndex: 0,
    minimumOrderSize: "0.01",
    minimumTickSize: "0.01",
    negRisk: false,
    watchlisted: true,
    acceptingOrders: true,
    active: true,
    closed: false,
    endDate: new Date("2026-06-01T00:00:00Z"),
  },
  {
    tokenId: "no-token-2",
    conditionId: "cond-0x2222",
    gammaMarketId: "gamma-002",
    question: "Will the US Fed cut rates in May 2026?",
    slug: "fed-rates-may-2026",
    eventSlug: "fed-rate-decisions",
    category: "Politics",
    outcome: "No",
    outcomeIndex: 1,
    minimumOrderSize: "0.01",
    minimumTickSize: "0.01",
    negRisk: false,
    watchlisted: false,
    acceptingOrders: true,
    active: true,
    closed: false,
    endDate: new Date("2026-06-01T00:00:00Z"),
  },
  {
    tokenId: "yes-token-3",
    conditionId: "cond-0x3333",
    gammaMarketId: "gamma-003",
    question: "Will Ethereum flip Bitcoin by market cap before 2027?",
    slug: "eth-flip-btc-2026",
    eventSlug: "eth-btc-market-cap",
    category: "Crypto",
    outcome: "Yes",
    outcomeIndex: 0,
    minimumOrderSize: "0.01",
    minimumTickSize: "0.01",
    negRisk: false,
    watchlisted: true,
    acceptingOrders: true,
    active: true,
    closed: false,
    endDate: new Date("2026-12-31T23:59:59Z"),
  },
  {
    tokenId: "no-token-3",
    conditionId: "cond-0x3333",
    gammaMarketId: "gamma-003",
    question: "Will Ethereum flip Bitcoin by market cap before 2027?",
    slug: "eth-flip-btc-2026",
    eventSlug: "eth-btc-market-cap",
    category: "Crypto",
    outcome: "No",
    outcomeIndex: 1,
    minimumOrderSize: "0.01",
    minimumTickSize: "0.01",
    negRisk: false,
    watchlisted: true,
    acceptingOrders: true,
    active: true,
    closed: false,
    endDate: new Date("2026-12-31T23:59:59Z"),
  },
  {
    tokenId: "yes-token-4",
    conditionId: "cond-0x4444",
    gammaMarketId: "gamma-004",
    question: "Will an AI agent launch a token on-chain before July 2026?",
    slug: "ai-agent-token-2026",
    eventSlug: "ai-tokens-2026",
    category: "AI & Technology",
    outcome: "Yes",
    outcomeIndex: 0,
    minimumOrderSize: "0.01",
    minimumTickSize: "0.01",
    negRisk: false,
    watchlisted: true,
    acceptingOrders: true,
    active: true,
    closed: false,
    endDate: new Date("2026-07-01T00:00:00Z"),
  },
  {
    tokenId: "no-token-4",
    conditionId: "cond-0x4444",
    gammaMarketId: "gamma-004",
    question: "Will an AI agent launch a token on-chain before July 2026?",
    slug: "ai-agent-token-2026",
    eventSlug: "ai-tokens-2026",
    category: "AI & Technology",
    outcome: "No",
    outcomeIndex: 1,
    minimumOrderSize: "0.01",
    minimumTickSize: "0.01",
    negRisk: false,
    watchlisted: false,
    acceptingOrders: true,
    active: true,
    closed: false,
    endDate: new Date("2026-07-01T00:00:00Z"),
  },
];

const KNOWN_WHALE_WALLETS = [
  "0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
  "0xDEADBEEF1234567890abcdefDEADBEEF12345678",
  "0x7777888899990000aaabbbcccdddeeefff000111",
  "0x420d667422f5e0b719415147b4724e8f2965c7a5",
  "0x1234567890abcdef1234567890abcdef12345678",
];

// Generate trades over the past 24 hours
function generateTrades() {
  const tradesList: any[] = [];
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;

  for (const m of SAMPLE_MARKETS) {
    const basePrice = m.outcome === "Yes" ? 0.35 + Math.random() * 0.3 : 0.7 - Math.random() * 0.3;
    let price = basePrice;

    // 20-50 trades per market in last 24h
    const numTrades = 20 + Math.floor(Math.random() * 30);

    for (let i = 0; i < numTrades; i++) {
      const hoursAgo = Math.random() * 24;
      const tradedAt = new Date(now - hoursAgo * 3600 * 1000);
      const size = 50 + Math.random() * 950;
      const side = Math.random() > 0.48 ? "BUY" : "SELL";
      const priceDelta = (Math.random() - 0.5) * 0.02;
      price = Math.max(0.01, Math.min(0.99, price + priceDelta));
      const valueUsdc = parseFloat((size * price).toFixed(2));

      const wallet = KNOWN_WHALE_WALLETS[Math.floor(Math.random() * KNOWN_WHALE_WALLETS.length)];
      const txHash = `0x${Math.random().toString(16).slice(2, 66).padEnd(64, "0")}`;

      tradesList.push({
        tokenId: m.tokenId,
        conditionId: m.conditionId,
        outcome: m.outcome,
        side,
        sizeTokens: size.toFixed(6),
        priceUsdc: price.toFixed(6),
        valueUsdc: String(valueUsdc),
        proxyWallet: wallet,
        transactionHash: txHash,
        tradedAt,
        marketSlug: m.slug!,
        eventSlug: m.eventSlug!,
        marketTitle: m.question,
        traderPseudonym: null,
        source: "seed",
      });
    }

    // Add 5-10 massive whale trades to one market
    if (m.tokenId === "yes-token-1" || m.tokenId === "yes-token-2") {
      for (let i = 0; i < 8; i++) {
        const hoursAgo = Math.random() * 24;
        const tradedAt = new Date(now - hoursAgo * 3600 * 1000);
        const size = 5000 + Math.random() * 25000; // whale sized
        const side = Math.random() > 0.5 ? "BUY" : "SELL";
        price = Math.max(0.01, Math.min(0.99, price + (Math.random() - 0.5) * 0.05));
        const whaleWallet = KNOWN_WHALE_WALLETS[Math.floor(Math.random() * 3)];
        const txHash = `0x${Math.random().toString(16).slice(2, 66).padEnd(64, "0")}`;
        const valueUsdc = parseFloat((size * price).toFixed(2));

        tradesList.push({
          tokenId: m.tokenId,
          conditionId: m.conditionId,
          outcome: m.outcome,
          side,
          sizeTokens: size.toFixed(6),
          priceUsdc: price.toFixed(6),
          valueUsdc: String(valueUsdc),
          proxyWallet: whaleWallet,
          transactionHash: txHash,
          tradedAt,
          marketSlug: m.slug!,
          eventSlug: m.eventSlug!,
          marketTitle: m.question,
          traderPseudonym: null,
          source: "seed",
        });
      }
    }
  }

  return tradesList;
}

function generateOrderBookSnapshots() {
  const snapshots: any[] = [];
  const now = new Date();

  for (const m of SAMPLE_MARKETS) {
    // Snapshot every 5 minutes for last 2 hours
    for (let i = 0; i < 24; i++) {
      const capturedAt = new Date(now.getTime() - i * 5 * 60 * 1000);
      const mid = 0.3 + Math.random() * 0.4;
      const spread = 0.01 + Math.random() * 0.03;
      const bidDepth = (5000 + Math.random() * 30000).toFixed(2);
      const askDepth = (4000 + Math.random() * 25000).toFixed(2);
      const imbalance = parseFloat((parseFloat(bidDepth) / (parseFloat(bidDepth) + parseFloat(askDepth))).toFixed(4));

      const bids = [];
      const asks = [];
      for (let level = 0; level < 5; level++) {
        bids.push({
          price: (mid - spread / 2 - level * 0.01).toFixed(4),
          size: (500 + Math.random() * 5000).toFixed(2),
        });
        asks.push({
          price: (mid + spread / 2 + level * 0.01).toFixed(4),
          size: (400 + Math.random() * 4000).toFixed(2),
        });
      }

      snapshots.push({
        tokenId: m.tokenId,
        conditionId: m.conditionId,
        bids,
        asks,
        bidDepthUsdc: bidDepth,
        askDepthUsdc: askDepth,
        imbalanceRatio: String(imbalance),
        mid: mid.toFixed(6),
        spread: spread.toFixed(6),
        bookHash: `sha1_${Math.random().toString(36).slice(2, 12)}`,
        snapshotTrigger: "rest_timer",
        capturedAt,
      });
    }
  }

  return snapshots;
}

function generatePriceHistory(tradesList: any[]) {
  return tradesList.slice(0, 100).map((trade, i) => ({
    tokenId: trade.tokenId,
    conditionId: trade.conditionId,
    price: trade.priceUsdc,
    side: trade.side,
    eventType: "last_trade",
    recordedAt: trade.tradedAt,
  }));
}

async function main() {
  console.log("🌱 Seeding polymarket-alpha database...\n");

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });
  const db = drizzle(pool, { schema });

  // ── 1. Clean existing data (seed tables only) ──
  console.log("🧹 Cleaning existing seeded data...");
  await db.delete(signals).execute();
  await db.delete(whaleAlerts).execute();
  await db.delete(walletProfiles).execute();
  await db.delete(priceHistory).execute();
  await db.delete(trades).execute();
  await db.delete(orderBookSnapshots).execute();
  await db.delete(marketStats).execute();
  await db.delete(markets).execute();
  console.log("✅ Clean slate.\n");

  // ── 2. Insert markets ──
  console.log("📊 Inserting markets...");
  await db.insert(markets).values(SAMPLE_MARKETS.map(m => ({ ...m })).reduce((batch, m, i) => [...batch, m], [] as any[])).execute();
  console.log(`✅ ${SAMPLE_MARKETS.length} markets inserted (4 conditions, Yes/No pairs)\n`);

  // ── 3. Insert market stats ──
  console.log("📈 Inserting market stats...");
  const stats = SAMPLE_MARKETS.map((m) => ({
    tokenId: m.tokenId,
    conditionId: m.conditionId,
    bestBid: (0.3 + Math.random() * 0.05).toFixed(6),
    bestAsk: (0.45 + Math.random() * 0.05).toFixed(6),
    mid: (0.4 + Math.random() * 0.1).toFixed(6),
    spread: (0.02 + Math.random() * 0.04).toFixed(6),
    lastTradePrice: (0.35 + Math.random() * 0.25).toFixed(6),
    volume24hr: String(15000 + Math.floor(Math.random() * 80000)),
    volume1wk: String(50000 + Math.floor(Math.random() * 300000)),
    volume1mo: String(200000 + Math.floor(Math.random() * 800000)),
    volumeTotal: String(500000 + Math.floor(Math.random() * 2000000)),
    liquidityUsdc: String(20000 + Math.floor(Math.random() * 100000)),
    openInterest: String(100000 + Math.floor(Math.random() * 500000)),
    avgTradeSize24h: String(150 + Math.floor(Math.random() * 500)),
    stddevTradeSize24h: String(200 + Math.floor(Math.random() * 1000)),
    calibrated: true,
    bootstrapTradeCount: 100 + Math.floor(Math.random() * 200),
    tradeCount24h: 50 + Math.floor(Math.random() * 100),
    oneDayPriceChange: (Math.random() * 0.2 - 0.1).toFixed(6),
    oneHourPriceChange: (Math.random() * 0.05 - 0.025).toFixed(6),
    oneWeekPriceChange: (Math.random() * 0.3 - 0.15).toFixed(6),
    competitive: (60 + Math.random() * 35).toFixed(4),
    refreshedAt: new Date(),
  }));
  await db.insert(marketStats).values(stats).execute();
  console.log(`✅ ${stats.length} market stat rows inserted\n`);

  // ── 4. Insert trades ──
  console.log("💹 Generating and inserting trades...");
  const allTrades = generateTrades();
  console.log(`   Generating ${allTrades.length} trades...`);

  // Insert in batches using raw SQL — trades table is partitioned and id is
  // auto-generated by the sequence; drizzle's type-safe .values() would require id.
  const tradesPerBatch = 50;
  for (let i = 0; i < allTrades.length; i += tradesPerBatch) {
    const batch = allTrades.slice(i, i + tradesPerBatch);
    for (const t of batch) {
      await db.execute(sql`
        INSERT INTO trades (
          token_id, condition_id, outcome, side, size_tokens,
          price_usdc, value_usdc, proxy_wallet, transaction_hash,
          traded_at, market_slug, event_slug, market_title, source
        ) VALUES (
          ${t.tokenId}, ${t.conditionId}, ${t.outcome}, ${t.side}, ${t.sizeTokens},
          ${t.priceUsdc}, ${t.valueUsdc}, ${t.proxyWallet}, ${t.transactionHash},
          ${t.tradedAt.toISOString()},
          ${t.marketSlug ?? null}, ${t.eventSlug ?? null}, ${t.marketTitle ?? null}, ${t.source ?? 'seed'}
        )
        ON CONFLICT (transaction_hash, token_id, proxy_wallet, traded_at, price_usdc, size_tokens)
        DO NOTHING
      `);
    }
  }
  console.log(`✅ ${allTrades.length} trades inserted\n`);

  // ── 5. Insert order book snapshots ──
  console.log("📋 Inserting order book snapshots...");
  const snapshots = generateOrderBookSnapshots();
  const snapPerBatch = 50;
  for (let i = 0; i < snapshots.length; i += snapPerBatch) {
    const batch = snapshots.slice(i, i + snapPerBatch);
    for (const s of batch) {
      await db.execute(sql`
        INSERT INTO order_book_snapshots (
          token_id, condition_id, bids, asks,
          bid_depth_usdc, ask_depth_usdc, imbalance_ratio,
          mid, spread, book_hash, snapshot_trigger, captured_at
        ) VALUES (
          ${s.tokenId}, ${s.conditionId},
          ${JSON.stringify(s.bids)}::jsonb, ${JSON.stringify(s.asks)}::jsonb,
          ${s.bidDepthUsdc}, ${s.askDepthUsdc}, ${s.imbalanceRatio},
          ${s.mid}, ${s.spread}, ${s.bookHash}, ${s.snapshotTrigger},
          ${s.capturedAt.toISOString()}
        )
        ON CONFLICT DO NOTHING
      `);
    }
  }
  console.log(`✅ ${snapshots.length} order book snapshots inserted\n`);

  // ── 6. Insert price history ──
  console.log("📉 Inserting price history...");
  const phData = generatePriceHistory(allTrades);
  await db.insert(priceHistory).values(phData).execute();
  console.log(`✅ ${phData.length} price history records inserted\n`);

  // ── 7. Insert wallet profiles for whale wallets ──
  console.log("🐋 Inserting wallet profiles...");
  const wallets = KNOWN_WHALE_WALLETS.map((w, i) => ({
    proxyWallet: w,
    totalVolumeUsdc: String(100000 + i * 50000 + Math.random() * 200000),
    tradeCount: 50 + i * 20 + Math.floor(Math.random() * 100),
    whaleTradeCount: 10 + i * 5 + Math.floor(Math.random() * 30),
    firstSeenAt: new Date(Date.now() - (30 + Math.random() * 60) * 24 * 3600 * 1000),
    lastSeenAt: new Date(Date.now() - Math.random() * 12 * 3600 * 1000),
    resolvedTradeCount: 20 + Math.floor(Math.random() * 50),
    winCount: 10 + Math.floor(Math.random() * 30),
    winRatio: (0.4 + Math.random() * 0.3).toFixed(4),
    displayName: `Whale #${i + 1}`,
    pseudonym: null,
    lastEnrichedAt: new Date(),
    enrichmentVersion: 1,
  }));
  await db.insert(walletProfiles).values(wallets).execute();
  console.log(`✅ ${wallets.length} wallet profiles inserted\n`);

  // ── 8. Create a couple whale alerts for the big trades ──
  console.log("⚠️  Creating whale alerts...");
  const whaleTrades = allTrades.filter((t: any) => parseFloat(t.valueUsdc) > 5000);
  const alerts = whaleTrades.slice(0, 5).map((t: any, i: number) => ({
    tradeLookupKey: `${t.transactionHash}|${t.tokenId}|${t.proxyWallet}|${t.tradedAt.toISOString()}|${t.priceUsdc}|${t.sizeTokens}`,
    tokenId: t.tokenId,
    conditionId: t.conditionId,
    usdcValue: t.valueUsdc,
    absoluteMinUsdc: 1000,
    avgTradeSize24hAtAlert: "350.000000",
    stddev24hAtAlert: "500.000000",
    volume24hAtAlert: "45000.00",
    sigmasAboveMean: String(3 + Math.random() * 5),
    pctOfDailyVolume: String(5 + Math.random() * 20),
    priceAtAlert: t.priceUsdc,
    priceImpactEstimateUsdc: String(parseFloat(t.valueUsdc) * 0.02),
    bookDepthConsumedPct: String(10 + Math.random() * 40),
    bookSnapshotAgeMs: 1000 + Math.floor(Math.random() * 5000),
    walletTotalVolumeUsdc: String(500000 + Math.random() * 500000),
    walletTradeCount: 100 + Math.floor(Math.random() * 200),
    walletFirstSeenAt: new Date(Date.now() - 60 * 24 * 3600 * 1000),
    walletWinRatio: (0.45 + Math.random() * 0.2).toFixed(4),
    enrichedAt: new Date(),
    alertedAt: t.tradedAt,
  }));
  await db.insert(whaleAlerts).values(alerts).execute();
  console.log(`✅ ${alerts.length} whale alerts created\n`);

  // ── 9. Summary ──
  const results = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(markets),
    db.select({ count: sql<number>`count(*)` }).from(trades),
    db.select({ count: sql<number>`count(*)` }).from(marketStats),
    db.select({ count: sql<number>`count(*)` }).from(orderBookSnapshots),
    db.select({ count: sql<number>`count(*)` }).from(whaleAlerts),
    db.select({ count: sql<number>`count(*)` }).from(walletProfiles),
    db.select({ count: sql<number>`count(*)` }).from(priceHistory),
  ]);

  console.log("═══════════════════════════════════════════════");
  console.log("       🌱 SEED COMPLETE — Data Summary");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Markets:          ${results[0][0].count}`);
  console.log(`  Trades:           ${results[1][0].count}`);
  console.log(`  Market Stats:     ${results[2][0].count}`);
  console.log(`  OB Snapshots:     ${results[3][0].count}`);
  console.log(`  Whale Alerts:     ${results[4][0].count}`);
  console.log(`  Wallet Profiles:  ${results[5][0].count}`);
  console.log(`  Price History:    ${results[6][0].count}`);
  console.log("═══════════════════════════════════════════════");

  await pool.end();
}

main().catch((e) => {
  console.error("❌ Seed failed:", e);
  process.exit(1);
});
