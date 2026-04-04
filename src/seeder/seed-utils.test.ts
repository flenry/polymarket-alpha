import { describe, it, expect } from "vitest";
import {
  parseClobTokenIds,
  buildTradeEventFromDataApi,
  computeMarketStats,
  buildWalletAggregates,
  type DataApiTrade,
  type WalletAggregate,
} from "./seed-utils.js";
import type { TradeEvent } from "../events/types.js";

// ─── parseClobTokenIds ────────────────────────────────────────────────────────

describe("parseClobTokenIds", () => {
  it("parses a JSON string array", () => {
    expect(parseClobTokenIds('["a","b"]')).toEqual(["a", "b"]);
  });

  it("returns already-parsed string array as-is", () => {
    expect(parseClobTokenIds(["x", "y"])).toEqual(["x", "y"]);
  });

  it("returns [] for non-array JSON string", () => {
    expect(parseClobTokenIds('"not-an-array"')).toEqual([]);
  });

  it("returns [] for bad JSON string", () => {
    expect(parseClobTokenIds("{bad json}")).toEqual([]);
  });

  it("returns [] for undefined", () => {
    expect(parseClobTokenIds(undefined)).toEqual([]);
  });

  it("returns [] for null", () => {
    expect(parseClobTokenIds(null)).toEqual([]);
  });

  it("deduplicates tokens in JSON string", () => {
    expect(parseClobTokenIds('["a","a","b"]')).toEqual(["a", "b"]);
  });

  it("returns [] for empty JSON array string", () => {
    expect(parseClobTokenIds("[]")).toEqual([]);
  });

  it("filters non-string items from already-parsed array", () => {
    expect(parseClobTokenIds(["a", 123, null, "b"])).toEqual(["a", "b"]);
  });
});

// ─── buildTradeEventFromDataApi ───────────────────────────────────────────────

describe("buildTradeEventFromDataApi", () => {
  const rawTrade: DataApiTrade = {
    asset: "token-abc",
    conditionId: "cond-123",
    side: "BUY",
    size: 100,
    price: 0.65,
    proxyWallet: "0xWallet",
    transactionHash: "0xTxHash",
    timestamp: 1700000000,
    outcome: "Yes",
    slug: "market-slug",
    eventSlug: "event-slug",
    title: "Will it happen?",
    pseudonym: "trader-x",
    name: "Trader X",
  };

  const market = {
    conditionId: "cond-123",
    outcome: "Yes",
    slug: "market-slug",
    eventSlug: "event-slug",
    question: "Will it happen?",
  };

  it("maps all fields correctly", () => {
    const result = buildTradeEventFromDataApi(rawTrade, market);

    expect(result.tokenId).toBe("token-abc");
    expect(result.conditionId).toBe("cond-123");
    expect(result.side).toBe("BUY");
    expect(result.sizeTokens).toBe(100);
    expect(result.priceUsdc).toBe(0.65);
    expect(result.valueUsdc).toBeCloseTo(65);
    expect(result.proxyWallet).toBe("0xWallet");
    expect(result.transactionHash).toBe("0xTxHash");
    expect(result.tradedAt).toEqual(new Date(1700000000 * 1000));
    expect(result.source).toBe("data_api");
  });

  it("computes valueUsdc = size * price", () => {
    const result = buildTradeEventFromDataApi(rawTrade, market);
    expect(result.valueUsdc).toBeCloseTo(rawTrade.size * rawTrade.price);
  });

  it("source is always data_api", () => {
    const result = buildTradeEventFromDataApi(rawTrade, market);
    expect(result.source).toBe("data_api");
  });

  it("falls back to market.outcome when raw.outcome is undefined", () => {
    const noOutcome: DataApiTrade = { ...rawTrade, outcome: undefined };
    const result = buildTradeEventFromDataApi(noOutcome, { ...market, outcome: "No" });
    expect(result.outcome).toBe("No");
  });

  it("falls back to market.slug when raw.slug is undefined", () => {
    const noSlug: DataApiTrade = { ...rawTrade, slug: undefined };
    const result = buildTradeEventFromDataApi(noSlug, { ...market, slug: "fallback-slug" });
    expect(result.marketSlug).toBe("fallback-slug");
  });

  it("uses empty string when both raw.slug and market.slug are null", () => {
    const noSlug: DataApiTrade = { ...rawTrade, slug: undefined };
    const result = buildTradeEventFromDataApi(noSlug, { ...market, slug: null });
    expect(result.marketSlug).toBe("");
  });

  it("maps traderName and traderPseudonym", () => {
    const result = buildTradeEventFromDataApi(rawTrade, market);
    expect(result.traderName).toBe("Trader X");
    expect(result.traderPseudonym).toBe("trader-x");
  });
});

// ─── computeMarketStats ───────────────────────────────────────────────────────

function makeTrade(valueUsdc: number): TradeEvent {
  return {
    tokenId: "tok",
    conditionId: "cond",
    side: "BUY",
    sizeTokens: valueUsdc,
    priceUsdc: 1,
    valueUsdc,
    proxyWallet: "0xW",
    transactionHash: "0xT",
    tradedAt: new Date(),
    outcome: "Yes",
    marketSlug: "",
    eventSlug: "",
    marketTitle: "",
    source: "data_api",
  };
}

describe("computeMarketStats", () => {
  it("returns zeros for empty trades", () => {
    const result = computeMarketStats("tok", "cond", []);
    expect(result.tokenId).toBe("tok");
    expect(result.volume24hr).toBe(0);
    expect(result.avgTradeSize24h).toBe(0);
    expect(result.stddevTradeSize24h).toBe(0);
    expect(result.tradeCount24h).toBe(0);
    expect(result.calibrated).toBe(false);
  });

  it("handles single trade correctly", () => {
    const result = computeMarketStats("tok", "cond", [makeTrade(100)]);
    expect(result.volume24hr).toBe(100);
    expect(result.avgTradeSize24h).toBe(100);
    expect(result.stddevTradeSize24h).toBe(0); // n < 2
    expect(result.tradeCount24h).toBe(1);
    expect(result.calibrated).toBe(false);
  });

  it("calibrated=true when tradeCount >= 30", () => {
    const trades = Array.from({ length: 30 }, () => makeTrade(50));
    const result = computeMarketStats("tok", "cond", trades);
    expect(result.tradeCount24h).toBe(30);
    expect(result.calibrated).toBe(true);
  });

  it("calibrated=false when tradeCount = 29", () => {
    const trades = Array.from({ length: 29 }, () => makeTrade(50));
    const result = computeMarketStats("tok", "cond", trades);
    expect(result.calibrated).toBe(false);
  });

  it("volume24hr is sum of valueUsdc", () => {
    const trades = [makeTrade(100), makeTrade(200), makeTrade(300)];
    const result = computeMarketStats("tok", "cond", trades);
    expect(result.volume24hr).toBe(600);
  });

  it("computes population stddev correctly", () => {
    // Values: 100, 200, 300 → mean=200, variance=(100² + 0 + 100²)/3 = 6666.67, stddev≈81.65
    const trades = [makeTrade(100), makeTrade(200), makeTrade(300)];
    const result = computeMarketStats("tok", "cond", trades);
    expect(result.stddevTradeSize24h).toBeCloseTo(81.65, 0);
  });

  it("liquidityUsdc is always 0 (not derivable from trades)", () => {
    const result = computeMarketStats("tok", "cond", [makeTrade(100)]);
    expect(result.liquidityUsdc).toBe(0);
  });
});

// ─── buildWalletAggregates ────────────────────────────────────────────────────

function makeTrade2(
  wallet: string,
  value: number,
  txHash = "0xTx",
  tokenId = "tok"
): TradeEvent {
  const tradedAt = new Date(1700000000 * 1000);
  return {
    tokenId,
    conditionId: "cond",
    side: "BUY",
    sizeTokens: value,
    priceUsdc: 1,
    valueUsdc: value,
    proxyWallet: wallet,
    transactionHash: txHash,
    tradedAt,
    outcome: "Yes",
    marketSlug: "",
    eventSlug: "",
    marketTitle: "",
    source: "data_api",
  };
}

function makeLookupKey(trade: TradeEvent): string {
  return [
    trade.transactionHash,
    trade.tokenId,
    trade.proxyWallet,
    trade.tradedAt.toISOString(),
    trade.priceUsdc.toString(),
    trade.sizeTokens.toString(),
  ].join("|");
}

describe("buildWalletAggregates", () => {
  it("returns one entry per unique wallet", () => {
    const trades = [
      makeTrade2("w1", 100, "tx1"),
      makeTrade2("w2", 200, "tx2"),
      makeTrade2("w3", 300, "tx3"),
    ];
    const map = buildWalletAggregates(trades, new Set());
    expect(map.size).toBe(3);
  });

  it("accumulates volume correctly for same wallet", () => {
    const trades = [
      makeTrade2("w1", 100, "tx1"),
      makeTrade2("w1", 200, "tx2"),
    ];
    const map = buildWalletAggregates(trades, new Set());
    expect(map.get("w1")!.totalVolumeUsdc).toBe(300);
    expect(map.get("w1")!.tradeCount).toBe(2);
  });

  it("correctly counts whale trades", () => {
    const whaleTrade = makeTrade2("w1", 9999, "whale-tx");
    const normalTrade = makeTrade2("w2", 10, "normal-tx");
    const key = makeLookupKey(whaleTrade);
    const map = buildWalletAggregates([whaleTrade, normalTrade], new Set([key]));

    expect(map.get("w1")!.whaleTradeCount).toBe(1);
    expect(map.get("w2")!.whaleTradeCount).toBe(0);
  });

  it("tracks firstSeenAt and lastSeenAt correctly", () => {
    const t1 = new Date(1000000);
    const t2 = new Date(2000000);
    const tr1 = { ...makeTrade2("w1", 100, "tx1"), tradedAt: t1 };
    const tr2 = { ...makeTrade2("w1", 200, "tx2"), tradedAt: t2 };
    const map = buildWalletAggregates([tr1, tr2], new Set());
    expect(map.get("w1")!.firstSeenAt).toEqual(t1);
    expect(map.get("w1")!.lastSeenAt).toEqual(t2);
  });

  it("returns empty map for empty trades", () => {
    const map = buildWalletAggregates([], new Set());
    expect(map.size).toBe(0);
  });
});
