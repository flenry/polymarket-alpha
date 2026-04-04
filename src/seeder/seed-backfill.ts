/**
 * Polymarket Alpha — Backfill Seed Script
 *
 * Fetches real Polymarket data (200 top-volume markets, last 24h trades,
 * order books) and idempotently populates the local Postgres DB, then runs
 * whale detection and signal computation.
 *
 * Usage: pnpm seed
 */

import "dotenv/config";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import { getDb, closeDb } from "../db/client.js";
import { createPartitionForDate } from "../db/partition-manager.js";
import { upsertMarket, upsertMarketStats } from "../db/queries/markets.js";
import { insertTrade } from "../db/queries/trades.js";
import { insertBookSnapshot } from "../db/queries/snapshots.js";
import { upsertWalletProfile } from "../db/queries/wallets.js";
import { insertWhaleAlert, buildTradeLookupKey } from "../db/queries/whales.js";
import { insertSignal } from "../db/queries/signals.js";
import { WhaleDetector } from "../processors/whale-detector.js";
import { ZGammaMarket } from "../validation/schemas.js";
import type { GammaMarket } from "../validation/schemas.js";
import type { TradeEvent, OrderBook, MarketStats, ImbalanceSignal, PriceImpactSignal, VelocitySignal, NegRiskSignal } from "../events/types.js";
import {
  parseClobTokenIds,
  buildTradeEventFromDataApi,
  computeMarketStats,
  buildWalletAggregates,
  type DataApiTrade,
  type WalletAggregate,
} from "./seed-utils.js";

type Db = NodePgDatabase<typeof schema>;

// ─── API endpoints ────────────────────────────────────────────────────────────

const GAMMA_URL =
  "https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=200";
const CLOB_SAMPLING_URL = "https://clob.polymarket.com/sampling-markets";
const DATA_API_TRADES_URL = "https://data-api.polymarket.com/trades";
const CLOB_BOOKS_URL = "https://clob.polymarket.com/books";

// ─── Types ────────────────────────────────────────────────────────────────────

interface GammaMarketEnriched {
  tokenId: string;
  outcomeIndex: number;
  market: GammaMarket;
  negRisk: boolean;
}

interface ClobMarketData {
  negRisk: boolean;
  acceptingOrders: boolean;
  minimumOrderSize?: number;
  minimumTickSize?: number;
}

interface OrderBookRaw {
  tokenId: string;
  bids: { price: string; size: string }[];
  asks: { price: string; size: string }[];
}

interface SignalCounts {
  bookImbalance: number;
  priceImpact: number;
  sentimentVelocity: number;
  negRisk: number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const SEED_TRADE_LIMIT = parseInt(process.env.SEED_TRADE_LIMIT ?? "10000", 10);
const SEED_HOURS = parseInt(process.env.SEED_HOURS ?? "24", 10);
const BOOK_IMBALANCE_RATIO = 3.0;
const PRICE_IMPACT_ANOMALY_THRESHOLD = parseFloat(
  process.env.PRICE_IMPACT_ANOMALY_THRESHOLD ?? "2.5"
);
const VELOCITY_PRICE_THRESHOLD = parseFloat(
  process.env.VELOCITY_PRICE_THRESHOLD ?? "0.005"
);
const MIN_TRADES_FOR_VELOCITY = 10;

// ─── Pretty-print helpers ─────────────────────────────────────────────────────

function banner(): void {
  console.log("\n🌱 Polymarket Alpha Seed Backfill");
  console.log("═══════════════════════════════════════════════════");
}

function step(label: string, result: string): void {
  const padded = label.padEnd(44, " ");
  console.log(`${padded}${result}`);
}

// ─── Task 2.1: DB connection check ───────────────────────────────────────────

export async function checkDbConnection(db: Db): Promise<void> {
  try {
    await db.execute(sql`SELECT 1`);
    step("🔗 Connecting to Postgres...", "✅");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`DB connection failed: ${msg}`);
  }
}

// ─── Task 2.2: Fetch markets ──────────────────────────────────────────────────

export async function fetchMarkets(
  fetchFn: typeof fetch = fetch
): Promise<GammaMarketEnriched[]> {
  const res = await fetchFn(GAMMA_URL);
  if (!res.ok) throw new Error(`Gamma API error: ${res.status}`);

  const raw = (await res.json()) as unknown[];
  if (!Array.isArray(raw)) throw new Error("Gamma API returned non-array");

  const result: GammaMarketEnriched[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;

    // Extract clobTokenIds from raw before Zod (API may return JSON string, not array)
    const rawTokenIds = r["clobTokenIds"];
    const tokenIds = parseClobTokenIds(rawTokenIds);

    // Normalize clobTokenIds to array for Zod (so schema validation succeeds)
    const normalized = { ...r, clobTokenIds: tokenIds };
    const parsed = ZGammaMarket.safeParse(normalized);
    if (!parsed.success) continue;

    const market = parsed.data;

    if (tokenIds.length === 0) continue;

    for (let i = 0; i < tokenIds.length; i++) {
      result.push({
        tokenId: tokenIds[i],
        outcomeIndex: i,
        market,
        negRisk: market.negRisk ?? false,
      });
    }
  }

  step(
    `📡 Fetching 200 markets from Gamma...`,
    `✅ (${result.length} tokens)`
  );

  return result;
}

// ─── Task 2.3: Fetch CLOB enrichment ─────────────────────────────────────────

export async function fetchClobEnrichment(
  _tokenIds: string[],
  fetchFn: typeof fetch = fetch
): Promise<Map<string, ClobMarketData>> {
  const map = new Map<string, ClobMarketData>();

  try {
    const res = await fetchFn(CLOB_SAMPLING_URL);
    if (!res.ok) {
      console.warn(`[seed] CLOB sampling-markets returned ${res.status} — skipping enrichment`);
      return map;
    }

    const raw = (await res.json()) as unknown;
    if (!Array.isArray(raw)) {
      console.warn("[seed] CLOB sampling-markets returned non-array — skipping enrichment");
      return map;
    }

    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const tokenId = r["token_id"] ?? r["tokenId"] ?? r["asset_id"];
      if (typeof tokenId !== "string") continue;

      map.set(tokenId, {
        negRisk: Boolean(r["neg_risk"] ?? r["negRisk"] ?? false),
        acceptingOrders: Boolean(r["accepting_orders"] ?? r["acceptingOrders"] ?? false),
        minimumOrderSize:
          typeof r["minimum_order_size"] === "number"
            ? r["minimum_order_size"]
            : undefined,
        minimumTickSize:
          typeof r["minimum_tick_size"] === "number"
            ? r["minimum_tick_size"]
            : undefined,
      });
    }

    step(`📦 Fetching CLOB enrichment data...`, `✅ (${map.size} CLOB markets)`);
  } catch (err) {
    console.warn("[seed] Failed to fetch CLOB enrichment:", err);
  }

  return map;
}

// ─── Task 2.4: Fetch trades (paginated) ──────────────────────────────────────

export async function fetchTrades(
  hoursBack: number = SEED_HOURS,
  maxTotal: number = SEED_TRADE_LIMIT,
  fetchFn: typeof fetch = fetch
): Promise<DataApiTrade[]> {
  const cutoffSec = Math.floor((Date.now() - hoursBack * 60 * 60 * 1000) / 1000);
  const all: DataApiTrade[] = [];
  let page = 1;

  process.stdout.write(`⏱️  Fetching trades (last ${hoursBack}h)...`);

  while (all.length < maxTotal) {
    const url = `${DATA_API_TRADES_URL}?limit=5000&after=${cutoffSec}`;
    const res = await fetchFn(url);

    if (!res.ok) {
      console.warn(`\n[seed] Trades API returned ${res.status}`);
      break;
    }

    const raw = (await res.json()) as unknown;
    if (!Array.isArray(raw)) {
      console.warn("\n[seed] Trades API returned non-array");
      break;
    }

    if (raw.length === 0) {
      if (page === 1) {
        process.stdout.write(`\n`);
        step("⏱️  Fetching trades (last 24h)...", "✅ (0 total trades)");
        return [];
      }
      break;
    }

    // Filter to cutoff window
    const filtered = (raw as DataApiTrade[]).filter(
      (t) => typeof t.timestamp === "number" && t.timestamp >= cutoffSec
    );

    process.stdout.write(`\n   ⏳ (page ${page}: ${filtered.length})`);
    all.push(...filtered);
    page++;

    // Stop when: page returned fewer than 5000 items (last page) OR
    // OR the last item is before our cutoff
    const last = raw[raw.length - 1] as DataApiTrade;
    if (raw.length < 5000 || (typeof last.timestamp === "number" && last.timestamp < cutoffSec)) {
      break;
    }

    if (all.length >= maxTotal) {
      console.warn(
        `\n[seed] SEED_TRADE_LIMIT=${maxTotal} reached — may not cover full ${hoursBack}h window`
      );
      break;
    }
  }

  const total = Math.min(all.length, maxTotal);
  const result = all.slice(0, total);
  process.stdout.write(`\n`);
  step("⏱️  Fetching trades...", `✅ (${result.length} total trades across ${hoursBack}h)`);
  return result;
}

// ─── Task 2.5: Fetch order books ──────────────────────────────────────────────

export async function fetchOrderBooks(
  tokenIds: string[],
  fetchFn: typeof fetch = fetch
): Promise<Map<string, OrderBookRaw>> {
  const map = new Map<string, OrderBookRaw>();
  const BATCH = 200;

  try {
    for (let i = 0; i < tokenIds.length; i += BATCH) {
      const batch = tokenIds.slice(i, i + BATCH);
      const res = await fetchFn(CLOB_BOOKS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token_ids: batch }),
      });

      if (!res.ok) {
        console.warn(`[seed] CLOB books POST returned ${res.status} for batch ${i / BATCH + 1}`);
        continue;
      }

      const raw = (await res.json()) as unknown;
      if (!Array.isArray(raw)) continue;

      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const r = item as Record<string, unknown>;
        const tokenId = r["asset_id"] ?? r["token_id"] ?? r["tokenId"];
        if (typeof tokenId !== "string") continue;

        const bids = Array.isArray(r["bids"])
          ? (r["bids"] as Array<{ price: string; size: string }>)
          : [];
        const asks = Array.isArray(r["asks"])
          ? (r["asks"] as Array<{ price: string; size: string }>)
          : [];

        map.set(tokenId, { tokenId, bids, asks });
      }
    }

    step(`📚 Fetching order books...`, `✅ (${map.size} books)`);
  } catch (err) {
    console.warn("[seed] Failed to fetch order books:", err);
  }

  return map;
}

// ─── Task 2.6: Insert markets ─────────────────────────────────────────────────

export async function insertMarkets(
  db: Db,
  markets: GammaMarketEnriched[],
  clobMap: Map<string, ClobMarketData>,
  _now: Date
): Promise<{ inserted: number }> {
  let inserted = 0;

  for (const { tokenId, outcomeIndex, market, negRisk: gammaIsNegRisk } of markets) {
    const clob = clobMap.get(tokenId);
    const isNegRisk = clob?.negRisk ?? gammaIsNegRisk;
    const acceptingOrders = clob?.acceptingOrders ?? market.acceptingOrders ?? false;
    const watchlisted = Boolean(acceptingOrders) && !isNegRisk;

    await upsertMarket(db, {
      ...market,
      tokenId,
      outcomeIndex,
      negRisk: isNegRisk,
      watchlisted,
      acceptingOrders: Boolean(acceptingOrders),
      minimumOrderSize: clob?.minimumOrderSize ?? market.minimumOrderSize ?? null,
      minimumTickSize: clob?.minimumTickSize ?? market.minimumTickSize ?? null,
    });

    await upsertMarketStats(db, {
      tokenId,
      conditionId: market.conditionId,
      volume24hr: market.volume24hr ?? null,
      bestBid: market.bestBid ?? null,
      bestAsk: market.bestAsk ?? null,
      lastTradePrice: market.lastTradePrice ?? null,
      oneDayPriceChange: market.oneDayPriceChange ?? null,
      liquidityUsdc: market.liquidity ?? null,
    });

    inserted++;
  }

  step(`📝 Inserting markets...`, `✅ (${inserted} inserted)`);
  return { inserted };
}

// ─── Task 2.7: Insert trades ──────────────────────────────────────────────────

export async function insertTrades(
  db: Db,
  rawTrades: DataApiTrade[],
  knownTokenIds: Set<string>,
  marketLookup: Map<string, { conditionId: string; outcome: string; slug: string | null; eventSlug: string | null; question: string }>
): Promise<{ inserted: number; skipped: number; trades: TradeEvent[] }> {
  // Collect unique dates for partition creation
  const dateSeen = new Set<string>();
  const filtered: DataApiTrade[] = [];

  for (const raw of rawTrades) {
    if (!knownTokenIds.has(raw.asset)) continue;
    const dateStr = new Date(raw.timestamp * 1000).toISOString().slice(0, 10);
    dateSeen.add(dateStr);
    filtered.push(raw);
  }

  // Create partitions for each unique date
  for (const dateStr of dateSeen) {
    await createPartitionForDate(db, "trades", new Date(dateStr));
    await createPartitionForDate(db, "order_book_snapshots", new Date(dateStr));
  }

  let inserted = 0;
  const skippedUnknown = rawTrades.length - filtered.length;
  let skippedDupe = 0;
  const insertedTrades: TradeEvent[] = [];

  for (const raw of filtered) {
    const marketInfo = marketLookup.get(raw.asset) ?? {
      conditionId: raw.conditionId,
      outcome: raw.outcome ?? "",
      slug: raw.slug ?? null,
      eventSlug: raw.eventSlug ?? null,
      question: raw.title ?? "",
    };

    const trade = buildTradeEventFromDataApi(raw, marketInfo);
    const result = await insertTrade(db, trade);

    if (result.inserted) {
      inserted++;
      insertedTrades.push(trade);
    } else {
      skippedDupe++;
    }
  }

  const skipped = skippedUnknown + skippedDupe;
  step(
    `📦 Inserting trades...`,
    `✅ (${inserted} inserted, ${skippedUnknown} unknown token, ${skippedDupe} dupes)`
  );
  return { inserted, skipped, trades: insertedTrades };
}

// ─── Task 2.8: Bootstrap price history ───────────────────────────────────────

export async function bootstrapPriceHistory(db: Db, trades: TradeEvent[]): Promise<number> {
  let count = 0;

  for (const trade of trades) {
    try {
      await db.execute(sql`
        INSERT INTO price_history (token_id, condition_id, price, side, event_type, recorded_at)
        VALUES (
          ${trade.tokenId},
          ${trade.conditionId},
          ${trade.priceUsdc.toString()},
          ${trade.side},
          ${"last_trade"},
          ${trade.tradedAt.toISOString()}
        )
      `);
      count++;
    } catch {
      // Silently skip — e.g. constraint violation
    }
  }

  step(`📊 Bootstrap price history...`, `✅ (${count} entries)`);
  return count;
}

// ─── Task 2.9: Recompute market stats ────────────────────────────────────────

export async function recomputeMarketStats(
  db: Db,
  tradesByToken: Map<string, TradeEvent[]>,
  volume24hrMap: Map<string, { conditionId: string; volume24hr: number | null }>
): Promise<{ calibrated: number; uncalibrated: number }> {
  let calibrated = 0;
  let uncalibrated = 0;

  const allTokenIds = new Set([...tradesByToken.keys(), ...volume24hrMap.keys()]);

  for (const tokenId of allTokenIds) {
    const trades = tradesByToken.get(tokenId) ?? [];
    const meta = volume24hrMap.get(tokenId);
    const conditionId = meta?.conditionId ?? trades[0]?.conditionId ?? "";

    const stats = computeMarketStats(tokenId, conditionId, trades);

    // Prefer computed volume, fall back to Gamma volume for tokens with 0 trades
    const volume24hr = trades.length > 0 ? stats.volume24hr : (meta?.volume24hr ?? 0);

    await upsertMarketStats(db, {
      tokenId,
      conditionId,
      volume24hr,
      avgTradeSize24h: stats.avgTradeSize24h,
      stddevTradeSize24h: stats.stddevTradeSize24h,
      tradeCount24h: stats.tradeCount24h,
    });

    if (stats.calibrated) calibrated++;
    else uncalibrated++;
  }

  step(
    `📈 Recomputing market stats...`,
    `✅ (${calibrated} calibrated, ${uncalibrated} too few trades)`
  );
  return { calibrated, uncalibrated };
}

// ─── Task 2.10: Run whale detection ──────────────────────────────────────────

export async function runWhaleDetection(
  db: Db,
  trades: TradeEvent[],
  statsMap: Map<string, MarketStats>,
  booksMap: Map<string, OrderBookRaw>
): Promise<{ alertCount: number; whaleLookup: Set<string> }> {
  const detector = new WhaleDetector();
  let alertCount = 0;
  const whaleLookup = new Set<string>();

  for (const trade of trades) {
    const stats = statsMap.get(trade.tokenId);
    if (!stats) continue;

    const raw = booksMap.get(trade.tokenId);
    const book: OrderBook | null = raw
      ? rawToOrderBook(raw, trade.tokenId, trade.conditionId)
      : null;

    const alert = detector.evaluate(trade, stats, book);
    if (!alert) continue;

    alertCount++;
    const key = buildTradeLookupKey(alert);
    whaleLookup.add(key);

    console.log(
      `  🐋 Whale: ${trade.tokenId.slice(0, 12)}… | $${trade.valueUsdc.toFixed(0)} | ${trade.side}`
    );

    await insertWhaleAlert(db, alert);
  }

  step(`🐋 Running whale detection...`, `✅ (${alertCount} whale alerts detected)`);
  return { alertCount, whaleLookup };
}

// ─── Task 2.11: Run signal detection ─────────────────────────────────────────

export async function runSignalDetection(
  db: Db,
  trades: TradeEvent[],
  statsMap: Map<string, MarketStats>,
  booksMap: Map<string, OrderBookRaw>,
  tokenConditionMap: Map<string, string> = new Map()
): Promise<SignalCounts> {
  const counts: SignalCounts = {
    bookImbalance: 0,
    priceImpact: 0,
    sentimentVelocity: 0,
    negRisk: 0,
  };

  const now = new Date();

  // BOOK_IMBALANCE — per book entry
  for (const [tokenId, raw] of booksMap) {
    const bidDepth = raw.bids.reduce(
      (s, l) => s + parseFloat(l.price) * parseFloat(l.size),
      0
    );
    const askDepth = raw.asks.reduce(
      (s, l) => s + parseFloat(l.price) * parseFloat(l.size),
      0
    );

    const ratio = askDepth > 0 ? bidDepth / askDepth : bidDepth > 0 ? Infinity : 1;
    const mid =
      raw.bids.length > 0 && raw.asks.length > 0
        ? (parseFloat(raw.bids[0].price) + parseFloat(raw.asks[0].price)) / 2
        : 0;
    const spread =
      raw.bids.length > 0 && raw.asks.length > 0
        ? parseFloat(raw.asks[0].price) - parseFloat(raw.bids[0].price)
        : null;

    // Look up conditionId from statsMap (tokenId → conditionId stored separately)
    const tokenStats = statsMap.get(tokenId);
    const conditionId = tokenConditionMap.get(tokenId) ?? "";

    if (ratio > BOOK_IMBALANCE_RATIO || ratio < 1 / BOOK_IMBALANCE_RATIO) {
      const direction = ratio > BOOK_IMBALANCE_RATIO ? "BULLISH" : "BEARISH";
      const confidence = Math.min(
        1,
        ratio > BOOK_IMBALANCE_RATIO ? ratio / (BOOK_IMBALANCE_RATIO * 2) : (1 / BOOK_IMBALANCE_RATIO) / (ratio || 1e-9) / 2
      );

      const signal: ImbalanceSignal = {
        signalType: "ORDER_BOOK_IMBALANCE",
        tokenId,
        conditionId,
        direction,
        confidence: Math.min(1, Math.max(0, confidence)),
        strength: ratio,
        priceAtSignal: mid,
        createdAt: now,
        payload: {
          bidDepthUsdc: bidDepth,
          askDepthUsdc: askDepth,
          imbalanceRatio: ratio,
          snapshotTrigger: "seed_backfill",
        },
        bidDepthUsdc: bidDepth,
        askDepthUsdc: askDepth,
        imbalanceRatio: ratio,
      };

      await insertSignal(db, signal, null);
      counts.bookImbalance++;
    }

    // Also store the book snapshot
    await insertBookSnapshot(db, {
      tokenId,
      conditionId,
      bids: raw.bids,
      asks: raw.asks,
      bidDepthUsdc: bidDepth,
      askDepthUsdc: askDepth,
      imbalanceRatio: ratio,
      mid,
      spread,
      snapshotTrigger: "seed_backfill",
      capturedAt: now,
    });
  }

  // PRICE_IMPACT_ANOMALY — per trade with stats + book
  for (const trade of trades) {
    const stats = statsMap.get(trade.tokenId);
    if (!stats || !stats.calibrated) continue;

    const raw = booksMap.get(trade.tokenId);
    if (!raw) continue;

    const condId = tokenConditionMap.get(trade.tokenId) ?? trade.conditionId;
    const book = rawToOrderBook(raw, trade.tokenId, condId);
    const levels = trade.side === "BUY" ? book.asks : book.bids;
    const totalDepth = levels.reduce((s, l) => s + l.price * l.size, 0);

    if (totalDepth === 0) continue;

    const bookDepthConsumedPct = (trade.valueUsdc / totalDepth) * 100;
    const sigmaEquivalent =
      stats.stddevTradeSize24h > 0
        ? (trade.valueUsdc - stats.avgTradeSize24h) / stats.stddevTradeSize24h
        : 0;

    if (bookDepthConsumedPct > 10 && sigmaEquivalent >= PRICE_IMPACT_ANOMALY_THRESHOLD) {
      const direction = trade.side === "BUY" ? "BULLISH" : "BEARISH";

      const signal: PriceImpactSignal = {
        signalType: "PRICE_IMPACT_ANOMALY",
        tokenId: trade.tokenId,
        conditionId: condId,
        direction,
        confidence: Math.min(1, sigmaEquivalent / 6),
        strength: sigmaEquivalent,
        priceAtSignal: trade.priceUsdc,
        createdAt: now,
        payload: {
          bookDepthConsumedPct,
          sigmaEquivalent,
          tradeValueUsdc: trade.valueUsdc,
          transactionHash: trade.transactionHash,
        },
        priceChangePct: bookDepthConsumedPct,
        windowSeconds: 0,
        triggeringTradeValueUsdc: trade.valueUsdc,
      };

      await insertSignal(db, signal, null);
      counts.priceImpact++;
    }
  }

  // SENTIMENT_VELOCITY — per token with >= MIN_TRADES_FOR_VELOCITY trades
  const tradesByToken = new Map<string, TradeEvent[]>();
  for (const trade of trades) {
    const arr = tradesByToken.get(trade.tokenId) ?? [];
    arr.push(trade);
    tradesByToken.set(trade.tokenId, arr);
  }

  for (const [tokenId, tokenTrades] of tradesByToken) {
    if (tokenTrades.length < MIN_TRADES_FOR_VELOCITY) continue;

    const sorted = [...tokenTrades].sort(
      (a, b) => a.tradedAt.getTime() - b.tradedAt.getTime()
    );
    const firstPrice = sorted[0].priceUsdc;
    const lastPrice = sorted[sorted.length - 1].priceUsdc;

    if (firstPrice === 0) continue;

    const velocity = (lastPrice - firstPrice) / firstPrice;

    if (Math.abs(velocity) >= VELOCITY_PRICE_THRESHOLD) {
      const conditionId = tokenConditionMap.get(tokenId) ?? sorted[0].conditionId;
      const direction = velocity > 0 ? "BULLISH" : "BEARISH";

      const signal: VelocitySignal = {
        signalType: "SENTIMENT_VELOCITY",
        tokenId,
        conditionId,
        direction,
        confidence: Math.min(1, Math.abs(velocity) / (VELOCITY_PRICE_THRESHOLD * 10)),
        strength: Math.abs(velocity) * 100,
        priceAtSignal: lastPrice,
        createdAt: now,
        payload: {
          velocityPct: velocity * 100,
          firstPrice,
          lastPrice,
          tradeCount: tokenTrades.length,
          windowHours: SEED_HOURS,
        },
        tradeCountVelocity: tokenTrades.length,
      };

      await insertSignal(db, signal, null);
      counts.sentimentVelocity++;
    }
  }

  // NEG_RISK_OUTLIER — neg-risk tokens with non-trivial book imbalance
  for (const [tokenId, raw] of booksMap) {
    const conditionId = tokenConditionMap.get(tokenId) ?? "";
    if (!conditionId) continue;

    // Seeder-level neg-risk signal detection is best-effort, using book shape only.
    const bidDepth = raw.bids.reduce(
      (s, l) => s + parseFloat(l.price) * parseFloat(l.size),
      0
    );
    const askDepth = raw.asks.reduce(
      (s, l) => s + parseFloat(l.price) * parseFloat(l.size),
      0
    );
    const sumAsk = raw.asks.reduce((s, l) => s + parseFloat(l.price), 0);

    // Arbitrage signal: sum of ask prices < 0.95 (below valid neg-risk range)
    if (sumAsk > 0 && sumAsk < 0.95 && raw.asks.length >= 2) {
      const mid =
        raw.bids.length > 0 && raw.asks.length > 0
          ? (parseFloat(raw.bids[0].price) + parseFloat(raw.asks[0].price)) / 2
          : 0;

      const negSignal: NegRiskSignal = {
        signalType: "NEG_RISK_OUTLIER",
        tokenId,
        conditionId,
        direction: "BEARISH",
        confidence: Math.min(1, (0.95 - sumAsk) / 0.1),
        strength: 0.95 - sumAsk,
        priceAtSignal: mid,
        createdAt: now,
        payload: {
          sumAsk,
          bidDepth,
          askDepth,
          negRiskGroupSize: raw.asks.length,
        },
        negRiskGroupSize: raw.asks.length,
        negRiskSumBid: bidDepth,
        negRiskSumAsk: sumAsk,
        conditionIdGroup: conditionId,
      };

      await insertSignal(db, negSignal, null);
      counts.negRisk++;
    }
  }

  step(
    `📶 Computing signals...`,
    `✅ (BOOK_IMBALANCE: ${counts.bookImbalance}, PRICE_IMPACT: ${counts.priceImpact}, SENTIMENT_VELOCITY: ${counts.sentimentVelocity}, NEG_RISK: ${counts.negRisk})`
  );

  return counts;
}

// ─── Task 2.12: Build and insert wallet profiles ──────────────────────────────

export async function buildAndInsertWalletProfiles(
  db: Db,
  trades: TradeEvent[],
  whaleLookup: Set<string>
): Promise<number> {
  const aggMap = buildWalletAggregates(trades, whaleLookup);

  for (const agg of aggMap.values()) {
    await upsertWalletProfile(db, {
      proxyWallet: agg.proxyWallet,
      totalVolumeUsdc: agg.totalVolumeUsdc,
      tradeCount: agg.tradeCount,
      whaleTradeCount: agg.whaleTradeCount,
      firstSeenAt: agg.firstSeenAt,
      lastSeenAt: agg.lastSeenAt,
    });
  }

  step(`👤 Building wallet profiles...`, `✅ (${aggMap.size} wallets)`);
  return aggMap.size;
}

// ─── Helper: convert raw order book to typed OrderBook ────────────────────────

function rawToOrderBook(raw: OrderBookRaw, tokenId: string, conditionId: string): OrderBook {
  return {
    tokenId,
    conditionId,
    bids: raw.bids.map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) })),
    asks: raw.asks.map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) })),
    timestamp: Date.now(),
    hash: "",
    capturedAt: new Date(),
  };
}

// ─── Task 2.13: main() orchestration ─────────────────────────────────────────

async function main(): Promise<void> {
  banner();

  const db = getDb();

  try {
    // 1. DB connection
    await checkDbConnection(db);

    // 2. Fetch markets
    const enrichedMarkets = await fetchMarkets();

    // 3. Fetch CLOB enrichment
    const tokenIds = enrichedMarkets.map((m) => m.tokenId);
    const clobMap = await fetchClobEnrichment(tokenIds);

    // 4. Insert markets
    const now = new Date();
    await insertMarkets(db, enrichedMarkets, clobMap, now);

    // 5. Build market lookup map for trade enrichment
    const marketLookup = new Map<
      string,
      { conditionId: string; outcome: string; slug: string | null; eventSlug: string | null; question: string }
    >();
    for (const { tokenId, outcomeIndex, market } of enrichedMarkets) {
      let outcome = "";
      if (market.outcomes) {
        try {
          const arr = JSON.parse(market.outcomes) as unknown[];
          const val = arr[outcomeIndex];
          if (typeof val === "string") outcome = val;
        } catch {
          // ignore
        }
      }
      marketLookup.set(tokenId, {
        conditionId: market.conditionId,
        outcome,
        slug: market.slug ?? null,
        eventSlug: market.eventSlug ?? null,
        question: market.question ?? "",
      });
    }

    const knownTokenIds = new Set(tokenIds);

    // 6. Fetch trades
    const rawTrades = await fetchTrades();

    // 7. Insert trades
    const { trades: insertedTrades } = await insertTrades(
      db,
      rawTrades,
      knownTokenIds,
      marketLookup
    );

    // 8. Bootstrap price history
    await bootstrapPriceHistory(db, insertedTrades);

    // 9. Compute market stats from inserted trades
    const tradesByToken = new Map<string, TradeEvent[]>();
    for (const trade of insertedTrades) {
      const arr = tradesByToken.get(trade.tokenId) ?? [];
      arr.push(trade);
      tradesByToken.set(trade.tokenId, arr);
    }

    const volume24hrMap = new Map<string, { conditionId: string; volume24hr: number | null }>();
    for (const { tokenId, market } of enrichedMarkets) {
      volume24hrMap.set(tokenId, {
        conditionId: market.conditionId,
        volume24hr: market.volume24hr ?? null,
      });
    }

    await recomputeMarketStats(db, tradesByToken, volume24hrMap);

    // Build statsMap for detection steps
    const statsMap = new Map<string, MarketStats>();
    for (const [tokenId, tokenTrades] of tradesByToken) {
      const meta = marketLookup.get(tokenId);
      const conditionId = meta?.conditionId ?? tokenTrades[0]?.conditionId ?? "";
      statsMap.set(tokenId, computeMarketStats(tokenId, conditionId, tokenTrades));
    }

    // 10. Fetch order books for all market tokens
    const booksMap = await fetchOrderBooks(tokenIds);

    // 11. Whale detection
    const { whaleLookup } = await runWhaleDetection(db, insertedTrades, statsMap, booksMap);

    // 12. Signal detection
    await runSignalDetection(db, insertedTrades, statsMap, booksMap);

    // 13. Wallet profiles
    await buildAndInsertWalletProfiles(db, insertedTrades, whaleLookup);

    console.log("═══════════════════════════════════════════════════");
    console.log("🎉 Seed complete! Dashboard should now show real data.");
    console.log("   Run `pnpm start` to begin live streaming.");
  } catch (err) {
    console.error("\n❌ Seed failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await closeDb();
  }
}

// Only run when executed directly (not imported by tests)
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("seed-backfill.js") ||
    process.argv[1].endsWith("seed-backfill.ts"));

if (isMain) {
  main();
}
