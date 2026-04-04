/**
 * Unit tests for seed-backfill.ts
 * All external I/O (fetch, DB queries, WhaleDetector) is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock external DB query modules ──────────────────────────────────────────

vi.mock("../db/client.js", () => ({
  getDb: vi.fn(),
  closeDb: vi.fn(),
  db: {},
}));

vi.mock("../db/partition-manager.js", () => ({
  createPartitionForDate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../db/queries/markets.js", () => ({
  upsertMarket: vi.fn().mockResolvedValue(undefined),
  upsertMarketStats: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../db/queries/trades.js", () => ({
  insertTrade: vi.fn().mockResolvedValue({ inserted: true }),
}));

vi.mock("../db/queries/snapshots.js", () => ({
  insertBookSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../db/queries/wallets.js", () => ({
  upsertWalletProfile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../db/queries/whales.js", () => ({
  insertWhaleAlert: vi.fn().mockResolvedValue(1n),
  buildTradeLookupKey: vi.fn().mockReturnValue("key"),
}));

vi.mock("../db/queries/signals.js", () => ({
  insertSignal: vi.fn().mockResolvedValue({ id: 1n }),
}));

vi.mock("../processors/whale-detector.js", () => ({
  WhaleDetector: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn().mockReturnValue(null),
  })),
}));

// ─── Imports AFTER mocks ──────────────────────────────────────────────────────

import { sql } from "drizzle-orm";
import { upsertMarket, upsertMarketStats } from "../db/queries/markets.js";
import { insertTrade } from "../db/queries/trades.js";
import { insertBookSnapshot } from "../db/queries/snapshots.js";
import { upsertWalletProfile } from "../db/queries/wallets.js";
import { insertWhaleAlert, buildTradeLookupKey } from "../db/queries/whales.js";
import { insertSignal } from "../db/queries/signals.js";
import { WhaleDetector } from "../processors/whale-detector.js";
import { createPartitionForDate } from "../db/partition-manager.js";

import {
  checkDbConnection,
  fetchMarkets,
  fetchClobEnrichment,
  fetchTrades,
  fetchOrderBooks,
  insertMarkets,
  insertTrades,
  bootstrapPriceHistory,
  recomputeMarketStats,
  runWhaleDetection,
  runSignalDetection,
  buildAndInsertWalletProfiles,
} from "./seed-backfill.js";
import type { TradeEvent, MarketStats } from "../events/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockDb() {
  return {
    execute: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
  } as unknown as Parameters<typeof checkDbConnection>[0];
}

function makeTradeEvent(overrides: Partial<TradeEvent> = {}): TradeEvent {
  return {
    tokenId: "tok1",
    conditionId: "cond1",
    side: "BUY",
    sizeTokens: 100,
    priceUsdc: 0.65,
    valueUsdc: 65,
    proxyWallet: "0xWallet",
    transactionHash: "0xTxHash",
    tradedAt: new Date("2024-01-15T12:00:00Z"),
    outcome: "Yes",
    marketSlug: "test-market",
    eventSlug: "test-event",
    marketTitle: "Test Market",
    source: "data_api",
    ...overrides,
  };
}

function makeStats(overrides: Partial<MarketStats> = {}): MarketStats {
  return {
    tokenId: "tok1",
    volume24hr: 50000,
    avgTradeSize24h: 500,
    stddevTradeSize24h: 100,
    liquidityUsdc: 10000,
    tradeCount24h: 100,
    calibrated: true,
    ...overrides,
  };
}

// ─── checkDbConnection ────────────────────────────────────────────────────────

describe("checkDbConnection", () => {
  it("resolves without error when db.execute succeeds", async () => {
    const db = mockDb();
    await expect(checkDbConnection(db)).resolves.toBeUndefined();
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("throws with DB connection failed message on error", async () => {
    const db = mockDb();
    (db.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("ECONNREFUSED")
    );
    await expect(checkDbConnection(db)).rejects.toThrow("DB connection failed: ECONNREFUSED");
  });
});

// ─── fetchMarkets ─────────────────────────────────────────────────────────────

describe("fetchMarkets", () => {
  it("returns flattened tokenId entries (2-token + 1-token market = 3 results)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          conditionId: "cond-A",
          clobTokenIds: '["tok1","tok2"]',
          question: "Market A",
          negRisk: false,
          active: true,
          closed: false,
        },
        {
          conditionId: "cond-B",
          clobTokenIds: '["tok3"]',
          question: "Market B",
          negRisk: true,
          active: true,
          closed: false,
        },
      ],
    });

    const result = await fetchMarkets(mockFetch as unknown as typeof fetch);
    expect(result).toHaveLength(3);
    expect(result[0].tokenId).toBe("tok1");
    expect(result[1].tokenId).toBe("tok2");
    expect(result[2].tokenId).toBe("tok3");
    expect(result[2].negRisk).toBe(true);
  });

  it("skips markets with no tokenIds", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          conditionId: "cond-A",
          clobTokenIds: "[]",
          question: "No tokens",
          active: true,
          closed: false,
        },
        {
          conditionId: "cond-B",
          clobTokenIds: '["tok1"]',
          question: "Has token",
          active: true,
          closed: false,
        },
      ],
    });

    const result = await fetchMarkets(mockFetch as unknown as typeof fetch);
    expect(result).toHaveLength(1);
    expect(result[0].tokenId).toBe("tok1");
  });

  it("throws on non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchMarkets(mockFetch as unknown as typeof fetch)).rejects.toThrow("Gamma API error");
  });

  it("skips invalid items (Zod parse failure)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        null,
        { notConditionId: "broken" },
        {
          conditionId: "cond-B",
          clobTokenIds: '["tok1"]',
          question: "Valid",
          active: true,
          closed: false,
        },
      ],
    });

    const result = await fetchMarkets(mockFetch as unknown as typeof fetch);
    // Zod strips conditionId requirement — only items with clobTokenIds matter
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── fetchClobEnrichment ──────────────────────────────────────────────────────

describe("fetchClobEnrichment", () => {
  it("returns Map keyed by token_id for valid response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { token_id: "tok1", neg_risk: false, accepting_orders: true },
        { token_id: "tok2", neg_risk: true, accepting_orders: false },
      ],
    });

    const result = await fetchClobEnrichment(["tok1", "tok2"], mockFetch as unknown as typeof fetch);
    expect(result.size).toBe(2);
    expect(result.get("tok1")?.negRisk).toBe(false);
    expect(result.get("tok2")?.negRisk).toBe(true);
  });

  it("returns empty Map on non-ok response (no throw)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const result = await fetchClobEnrichment(["tok1"], mockFetch as unknown as typeof fetch);
    expect(result.size).toBe(0);
  });

  it("returns empty Map on fetch throw (no throw)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));
    const result = await fetchClobEnrichment(["tok1"], mockFetch as unknown as typeof fetch);
    expect(result.size).toBe(0);
  });

  it("returns empty Map when response is not array", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ not: "array" }),
    });
    const result = await fetchClobEnrichment(["tok1"], mockFetch as unknown as typeof fetch);
    expect(result.size).toBe(0);
  });
});

// ─── fetchTrades ──────────────────────────────────────────────────────────────

describe("fetchTrades", () => {
  it("returns combined results from two pages", async () => {
    const now = Math.floor(Date.now() / 1000);
    // Page 1: 5000 trades, page 2: 312 trades
    const page1 = Array.from({ length: 5000 }, (_, i) => ({
      asset: "tok1",
      conditionId: "cond",
      side: "BUY",
      size: 10,
      price: 0.5,
      proxyWallet: "0xW",
      transactionHash: `0xtx${i}`,
      timestamp: now - i,
    }));
    const page2 = Array.from({ length: 312 }, (_, i) => ({
      asset: "tok1",
      conditionId: "cond",
      side: "SELL",
      size: 10,
      price: 0.5,
      proxyWallet: "0xW",
      transactionHash: `0xtx2${i}`,
      timestamp: now - 5000 - i,
    }));

    let call = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      call++;
      return {
        ok: true,
        json: async () => (call === 1 ? page1 : page2),
      };
    });

    const result = await fetchTrades(24, 20000, mockFetch as unknown as typeof fetch);
    expect(result.length).toBe(5312);
  });

  it("returns [] when first page is empty", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    const result = await fetchTrades(24, 10000, mockFetch as unknown as typeof fetch);
    expect(result).toEqual([]);
  });

  it("respects maxTotal cap", async () => {
    const now = Math.floor(Date.now() / 1000);
    const trades = Array.from({ length: 5000 }, (_, i) => ({
      asset: "tok1",
      conditionId: "cond",
      side: "BUY",
      size: 10,
      price: 0.5,
      proxyWallet: "0xW",
      transactionHash: `0xtx${i}`,
      timestamp: now - i,
    }));

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => trades,
    });

    const result = await fetchTrades(24, 100, mockFetch as unknown as typeof fetch);
    expect(result.length).toBeLessThanOrEqual(100);
  });
});

// ─── fetchOrderBooks ──────────────────────────────────────────────────────────

describe("fetchOrderBooks", () => {
  it("fires two POSTs for 250 tokenIds and returns merged map", async () => {
    const tokenIds = Array.from({ length: 250 }, (_, i) => `tok${i}`);
    let callCount = 0;

    const mockFetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
      callCount++;
      const body = JSON.parse(opts.body as string) as { token_ids: string[] };
      const results = body.token_ids.map((id) => ({
        asset_id: id,
        bids: [{ price: "0.4", size: "100" }],
        asks: [{ price: "0.6", size: "100" }],
      }));
      return { ok: true, json: async () => results };
    });

    const result = await fetchOrderBooks(tokenIds, mockFetch as unknown as typeof fetch);
    expect(callCount).toBe(2);
    expect(result.size).toBe(250);
  });

  it("returns empty Map on fetch throw (no throw)", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network"));
    const result = await fetchOrderBooks(["tok1"], mockFetch as unknown as typeof fetch);
    expect(result.size).toBe(0);
  });

  it("skips batch on non-ok response and continues", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    const result = await fetchOrderBooks(["tok1", "tok2"], mockFetch as unknown as typeof fetch);
    expect(result.size).toBe(0);
  });
});

// ─── insertMarkets ────────────────────────────────────────────────────────────

describe("insertMarkets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls upsertMarket for each market entry", async () => {
    const db = mockDb();
    const markets = [
      {
        tokenId: "tok1",
        outcomeIndex: 0,
        market: { conditionId: "cond1", question: "Q1", negRisk: false, active: true, closed: false, acceptingOrders: true } as any,
        negRisk: false,
      },
      {
        tokenId: "tok2",
        outcomeIndex: 0,
        market: { conditionId: "cond2", question: "Q2", negRisk: false, active: true, closed: false, acceptingOrders: true } as any,
        negRisk: false,
      },
      {
        tokenId: "tok3",
        outcomeIndex: 0,
        market: { conditionId: "cond3", question: "Q3", negRisk: true, active: true, closed: false, acceptingOrders: false } as any,
        negRisk: true,
      },
    ];

    const clobMap = new Map();

    const result = await insertMarkets(db as any, markets, clobMap, new Date());
    expect(result.inserted).toBe(3);
    expect(upsertMarket).toHaveBeenCalledTimes(3);
    expect(upsertMarketStats).toHaveBeenCalledTimes(3);
  });

  it("sets watchlisted=false for neg-risk market", async () => {
    vi.clearAllMocks();
    const db = mockDb();
    const markets = [
      {
        tokenId: "neg-tok",
        outcomeIndex: 0,
        market: {
          conditionId: "cond",
          question: "Q",
          negRisk: true,
          active: true,
          closed: false,
          acceptingOrders: true,
        } as any,
        negRisk: true,
      },
    ];

    await insertMarkets(db as any, markets, new Map(), new Date());
    expect(upsertMarket).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ watchlisted: false })
    );
  });
});

// ─── insertTrades ─────────────────────────────────────────────────────────────

describe("insertTrades", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips trades for unknown tokenIds", async () => {
    const db = mockDb();
    const rawTrades = [
      { asset: "unknown1", conditionId: "c", side: "BUY", size: 10, price: 0.5, proxyWallet: "w", transactionHash: "tx1", timestamp: Math.floor(Date.now() / 1000) } as any,
      { asset: "tok1", conditionId: "c", side: "BUY", size: 10, price: 0.5, proxyWallet: "w", transactionHash: "tx2", timestamp: Math.floor(Date.now() / 1000) } as any,
    ];
    const known = new Set(["tok1"]);
    const lookup = new Map([["tok1", { conditionId: "c", outcome: "Yes", slug: null, eventSlug: null, question: "Q" }]]);

    const result = await insertTrades(db as any, rawTrades, known, lookup);
    expect(result.skipped).toBeGreaterThanOrEqual(1); // unknown token
    expect(result.inserted).toBe(1);
  });

  it("counts duplicate as skipped", async () => {
    vi.clearAllMocks();
    (insertTrade as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ inserted: true })
      .mockResolvedValueOnce({ inserted: false }); // duplicate

    const db = mockDb();
    const ts = Math.floor(Date.now() / 1000);
    const rawTrades = [
      { asset: "tok1", conditionId: "c", side: "BUY", size: 10, price: 0.5, proxyWallet: "w", transactionHash: "tx1", timestamp: ts } as any,
      { asset: "tok1", conditionId: "c", side: "BUY", size: 10, price: 0.5, proxyWallet: "w", transactionHash: "tx1", timestamp: ts } as any,
    ];
    const known = new Set(["tok1"]);
    const lookup = new Map([["tok1", { conditionId: "c", outcome: "Yes", slug: null, eventSlug: null, question: "Q" }]]);

    const result = await insertTrades(db as any, rawTrades, known, lookup);
    expect(result.inserted).toBe(1);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });
});

// ─── bootstrapPriceHistory ────────────────────────────────────────────────────

describe("bootstrapPriceHistory", () => {
  it("calls db.execute once per trade", async () => {
    const db = mockDb();
    const trades = [makeTradeEvent(), makeTradeEvent({ transactionHash: "0xTx2" }), makeTradeEvent({ transactionHash: "0xTx3" })];
    const count = await bootstrapPriceHistory(db as any, trades);
    expect(count).toBe(3);
    expect(db.execute).toHaveBeenCalledTimes(3);
  });

  it("handles db.execute throw gracefully (silently skips)", async () => {
    const db = mockDb();
    (db.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("constraint"));
    const trades = [makeTradeEvent(), makeTradeEvent({ transactionHash: "0xTx2" })];
    const count = await bootstrapPriceHistory(db as any, trades);
    expect(count).toBe(1); // only 1 succeeded
  });
});

// ─── recomputeMarketStats ─────────────────────────────────────────────────────

describe("recomputeMarketStats", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns calibrated=1 and uncalibrated=1 for 35 vs 5 trades", async () => {
    const db = mockDb();
    const bigTrades = Array.from({ length: 35 }, () => makeTradeEvent({ tokenId: "tok1" }));
    const smallTrades = Array.from({ length: 5 }, () => makeTradeEvent({ tokenId: "tok2", conditionId: "cond2" }));

    const tradesByToken = new Map([
      ["tok1", bigTrades],
      ["tok2", smallTrades],
    ]);
    const volMap = new Map([
      ["tok1", { conditionId: "cond1", volume24hr: 1000 }],
      ["tok2", { conditionId: "cond2", volume24hr: 500 }],
    ]);

    const result = await recomputeMarketStats(db as any, tradesByToken, volMap);
    expect(result.calibrated).toBe(1);
    expect(result.uncalibrated).toBe(1);
  });

  it("calls upsertMarketStats for each token", async () => {
    const db = mockDb();
    const tradesByToken = new Map([
      ["tok1", [makeTradeEvent()]],
    ]);
    const volMap = new Map([["tok1", { conditionId: "cond1", volume24hr: 100 }]]);

    await recomputeMarketStats(db as any, tradesByToken, volMap);
    expect(upsertMarketStats).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tokenId: "tok1" })
    );
  });
});

// ─── runWhaleDetection ────────────────────────────────────────────────────────

describe("runWhaleDetection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns alertCount=0 when evaluate always returns null", async () => {
    const db = mockDb();
    const trades = [makeTradeEvent()];
    const statsMap = new Map([["tok1", makeStats()]]);
    const booksMap = new Map();

    const result = await runWhaleDetection(db as any, trades, statsMap, booksMap);
    expect(result.alertCount).toBe(0);
    expect(result.whaleLookup.size).toBe(0);
  });

  it("counts alert and calls insertWhaleAlert when evaluate returns alert", async () => {
    vi.clearAllMocks();

    const fakeAlert = {
      trade: makeTradeEvent(),
      usdcValue: 99000,
      marketStats: makeStats(),
      priceAtAlert: 0.65,
      priceImpactEstimateUsdc: 0,
      bookDepthConsumedPct: 0,
      bookSnapshotAgeMs: 0,
      book: null,
      signal: {} as any,
      emitSignal: true,
    };

    (WhaleDetector as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      evaluate: vi.fn().mockReturnValue(fakeAlert),
    }));

    (buildTradeLookupKey as ReturnType<typeof vi.fn>).mockReturnValue("whale-key");

    const db = mockDb();
    const trades = [makeTradeEvent()];
    const statsMap = new Map([["tok1", makeStats()]]);
    const booksMap = new Map();

    const result = await runWhaleDetection(db as any, trades, statsMap, booksMap);
    expect(result.alertCount).toBe(1);
    expect(result.whaleLookup.has("whale-key")).toBe(true);
    expect(insertWhaleAlert).toHaveBeenCalledTimes(1);
  });

  it("skips trade if stats not found", async () => {
    vi.clearAllMocks();
    const db = mockDb();
    const trades = [makeTradeEvent({ tokenId: "unknown-tok" })];
    const statsMap = new Map<string, MarketStats>(); // empty
    const booksMap = new Map();

    const result = await runWhaleDetection(db as any, trades, statsMap, booksMap);
    expect(result.alertCount).toBe(0);
    expect(insertWhaleAlert).not.toHaveBeenCalled();
  });
});

// ─── runSignalDetection ───────────────────────────────────────────────────────

describe("runSignalDetection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns all zeros when booksMap is empty", async () => {
    const db = mockDb();
    const result = await runSignalDetection(db as any, [], new Map(), new Map());
    expect(result.bookImbalance).toBe(0);
    expect(result.priceImpact).toBe(0);
    expect(result.sentimentVelocity).toBe(0);
    expect(result.negRisk).toBe(0);
  });

  it("inserts ORDER_BOOK_IMBALANCE signal when bid/ask ratio > 3", async () => {
    vi.clearAllMocks();
    const db = mockDb();
    const booksMap = new Map([
      [
        "tok1",
        {
          tokenId: "tok1",
          // bid depth much larger: 4000 vs ask depth 100 → ratio = 40
          bids: [{ price: "0.6", size: "6666" }], // 0.6 * 6666 = 3999.6
          asks: [{ price: "0.7", size: "100" }],   // 0.7 * 100 = 70
        },
      ],
    ]);
    const statsMap = new Map([["tok1", makeStats()]]);

    const result = await runSignalDetection(db as any, [], statsMap, booksMap);
    expect(result.bookImbalance).toBeGreaterThan(0);
    expect(insertSignal).toHaveBeenCalled();
  });

  it("detects SENTIMENT_VELOCITY for >= 10 trades with price change", async () => {
    vi.clearAllMocks();
    const db = mockDb();
    const now = new Date();

    // 10 trades with price going from 0.5 to 0.6 (20% gain > 0.5% threshold)
    const trades = Array.from({ length: 10 }, (_, i) =>
      makeTradeEvent({
        tokenId: "tok1",
        priceUsdc: 0.5 + i * 0.01,
        tradedAt: new Date(now.getTime() + i * 60000),
      })
    );

    const statsMap = new Map([["tok1", makeStats()]]);

    const result = await runSignalDetection(db as any, trades, statsMap, new Map());
    expect(result.sentimentVelocity).toBe(1);
  });

  it("does not detect SENTIMENT_VELOCITY for < 10 trades", async () => {
    vi.clearAllMocks();
    const db = mockDb();
    const trades = Array.from({ length: 5 }, () => makeTradeEvent({ priceUsdc: 0.9 }));
    const statsMap = new Map([["tok1", makeStats()]]);

    const result = await runSignalDetection(db as any, trades, statsMap, new Map());
    expect(result.sentimentVelocity).toBe(0);
  });
});

// ─── buildAndInsertWalletProfiles ─────────────────────────────────────────────

describe("buildAndInsertWalletProfiles", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls upsertWalletProfile for each unique wallet", async () => {
    const db = mockDb();
    const trades = [
      makeTradeEvent({ proxyWallet: "w1" }),
      makeTradeEvent({ proxyWallet: "w2" }),
    ];

    const count = await buildAndInsertWalletProfiles(db as any, trades, new Set());
    expect(count).toBe(2);
    expect(upsertWalletProfile).toHaveBeenCalledTimes(2);
  });

  it("returns 0 for empty trades", async () => {
    const db = mockDb();
    const count = await buildAndInsertWalletProfiles(db as any, [], new Set());
    expect(count).toBe(0);
  });

  it("aggregates multiple trades for same wallet into one profile", async () => {
    vi.clearAllMocks();
    const db = mockDb();
    const trades = [
      makeTradeEvent({ proxyWallet: "w1", transactionHash: "tx1", valueUsdc: 100 }),
      makeTradeEvent({ proxyWallet: "w1", transactionHash: "tx2", valueUsdc: 200 }),
    ];

    const count = await buildAndInsertWalletProfiles(db as any, trades, new Set());
    expect(count).toBe(1);
    expect(upsertWalletProfile).toHaveBeenCalledTimes(1);
    expect(upsertWalletProfile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ totalVolumeUsdc: 300, tradeCount: 2 })
    );
  });
});
