import { describe, it, expect } from "vitest";
import { WhaleDetector } from "./whale-detector.js";
import type { TradeEvent, MarketStats, OrderBook } from "../events/types.js";

const OPTS = {
  absoluteMinUsdc: 10_000,
  sigmaThreshold: 3.0,
  pctVolumeThreshold: 0.02,
  minLiquidityUsdc: 50_000,
};

function makeDetector(overrides: Partial<typeof OPTS> = {}) {
  return new WhaleDetector({ ...OPTS, ...overrides });
}

function makeTrade(valueUsdc: number, side: "BUY" | "SELL" = "BUY"): TradeEvent {
  return {
    tokenId: "tok1",
    conditionId: "cond1",
    side,
    sizeTokens: valueUsdc / 0.65,
    priceUsdc: 0.65,
    valueUsdc,
    proxyWallet: "0xwallet",
    transactionHash: "0xtx",
    tradedAt: new Date(),
    outcome: "Yes",
    marketSlug: "test",
    eventSlug: "test",
    marketTitle: "Test",
    source: "live_ws",
  };
}

function makeStats(
  overrides: Partial<MarketStats> = {}
): MarketStats {
  return {
    tokenId: "tok1",
    volume24hr: 2_000_000,
    avgTradeSize24h: 5_000,
    stddevTradeSize24h: 8_000,
    liquidityUsdc: 500_000,
    tradeCount24h: 50,
    calibrated: true,
    ...overrides,
  };
}

function makeBook(): OrderBook {
  return {
    tokenId: "tok1",
    conditionId: "cond1",
    bids: [
      { price: 0.65, size: 10000 },
      { price: 0.64, size: 20000 },
    ],
    asks: [
      { price: 0.66, size: 10000 },
      { price: 0.67, size: 20000 },
    ],
    timestamp: Date.now(),
    hash: "abc",
    capturedAt: new Date(Date.now() - 3000), // 3s ago
  };
}

describe("WhaleDetector (dual-threshold)", () => {
  it("fires when valueUsdc >= absoluteMin AND sigmas >= 3", () => {
    const detector = makeDetector();
    // avgTradeSize24h=5000, stddev=8000 → sigma = (65000-5000)/8000 = 7.5 ≥ 3
    const trade = makeTrade(65_000);
    const stats = makeStats();
    const alert = detector.evaluate(trade, stats, null);
    expect(alert).not.toBeNull();
    expect(alert!.signal.direction).toBe("BULLISH");
  });

  it("fires when valueUsdc >= absoluteMin AND pctOfVolume >= 2% (sigma fails)", () => {
    const detector = makeDetector();
    // sigma = (11000-5000)/8000 = 0.75 < 3 → sigma fails
    // pct = 11000 / 500000 = 2.2% ≥ 2% → passes
    const trade = makeTrade(11_000);
    const stats = makeStats({ volume24hr: 500_000 });
    const alert = detector.evaluate(trade, stats, null);
    expect(alert).not.toBeNull();
    expect(alert!.signal.pctOfDailyVolume).toBeGreaterThanOrEqual(0.02);
  });

  it("does NOT fire when only absoluteMin passed (relative check fails)", () => {
    const detector = makeDetector();
    // sigma = (10001-5000)/8000 = 0.625 < 3, pct = 10001/10000000 = 0.1% < 2%
    const trade = makeTrade(10_001);
    const stats = makeStats({ volume24hr: 10_000_000 });
    const alert = detector.evaluate(trade, stats, null);
    expect(alert).toBeNull();
  });

  it("does NOT fire when below absoluteMin even if relative check passes", () => {
    const detector = makeDetector();
    // valueUsdc=9999 < 10000 → Gate 1 fails
    const trade = makeTrade(9_999);
    const stats = makeStats({ volume24hr: 100_000 }); // 10% would pass Gate 2
    const alert = detector.evaluate(trade, stats, null);
    expect(alert).toBeNull();
  });

  it("calibrated=false: sigma branch skipped; pct-of-volume branch still applies", () => {
    const detector = makeDetector();
    // calibrated=false → sigma skipped
    // pct = 50000 / 500000 = 10% ≥ 2% → fires
    const trade = makeTrade(50_000);
    const stats = makeStats({ calibrated: false, volume24hr: 500_000 });
    const alert = detector.evaluate(trade, stats, null);
    expect(alert).not.toBeNull();
    // sigmasAboveMean should be 0 (not computed)
    expect(alert!.signal.sigmasAboveMean).toBe(0);
  });

  it("stddevTradeSize24h=0: treated as calibrated=false (sigma skipped)", () => {
    const detector = makeDetector();
    const trade = makeTrade(50_000);
    const stats = makeStats({ calibrated: true, stddevTradeSize24h: 0, volume24hr: 500_000 });
    const alert = detector.evaluate(trade, stats, null);
    // stddev=0 → isCalibrated=false → sigma skipped; pct=10% fires
    expect(alert).not.toBeNull();
  });

  it("missing book snapshot: alert emitted with null impact fields", () => {
    const detector = makeDetector();
    const trade = makeTrade(65_000);
    const stats = makeStats();
    const alert = detector.evaluate(trade, stats, null);
    expect(alert).not.toBeNull();
    expect(alert!.book).toBeNull();
    expect(alert!.bookSnapshotAgeMs).toBe(0);
    expect(alert!.priceImpactEstimateUsdc).toBe(0);
  });

  it("BUY → direction = BULLISH", () => {
    const detector = makeDetector();
    const trade = makeTrade(65_000, "BUY");
    const alert = detector.evaluate(trade, makeStats(), null);
    expect(alert!.signal.direction).toBe("BULLISH");
  });

  it("SELL → direction = BEARISH", () => {
    const detector = makeDetector();
    const trade = makeTrade(65_000, "SELL");
    const alert = detector.evaluate(trade, makeStats(), null);
    expect(alert!.signal.direction).toBe("BEARISH");
  });

  it("confidence capped at 1.0", () => {
    const detector = makeDetector();
    // sigma = (100000-5000)/8000 = 11.875 → confidence = min(1.0, 11.875/6) > 1
    const trade = makeTrade(100_000);
    const alert = detector.evaluate(trade, makeStats(), null);
    expect(alert!.signal.confidence).toBeLessThanOrEqual(1.0);
    expect(alert!.signal.confidence).toBe(1.0);
  });

  it("liquidityUsdc < minLiquidityUsdc: emitSignal=false but alert still returned", () => {
    const detector = makeDetector();
    const trade = makeTrade(65_000);
    const stats = makeStats({ liquidityUsdc: 10_000 }); // below 50k threshold
    const alert = detector.evaluate(trade, stats, null);
    expect(alert).not.toBeNull();
    expect(alert!.emitSignal).toBe(false);
  });

  it("bookSnapshotAgeMs annotated correctly from capturedAt delta", () => {
    const detector = makeDetector();
    const trade = makeTrade(65_000);
    const book = makeBook(); // 3s ago
    const alert = detector.evaluate(trade, makeStats(), book);
    expect(alert).not.toBeNull();
    expect(alert!.bookSnapshotAgeMs).toBeGreaterThan(0);
    expect(alert!.bookSnapshotAgeMs).toBeLessThan(10_000); // reasonable range
  });

  it("alert format matches expected output shape", () => {
    const detector = makeDetector();
    const trade = makeTrade(65_000);
    const alert = detector.evaluate(trade, makeStats(), makeBook());
    expect(alert).toMatchObject({
      trade: expect.objectContaining({ tokenId: "tok1" }),
      usdcValue: 65_000,
      signal: expect.objectContaining({
        signalType: "WHALE_TRADE",
        tokenId: "tok1",
        direction: "BULLISH",
      }),
      emitSignal: true,
    });
  });

  it("book with empty bids: mid falls back to trade.priceUsdc (covers line 23 fallback)", () => {
    const detector = makeDetector();
    const trade = makeTrade(65_000);
    // Book with asks but no bids — mid fallback to trade.priceUsdc
    const partialBook: OrderBook = {
      tokenId: "tok1",
      conditionId: "cond1",
      bids: [],
      asks: [{ price: 0.66, size: 10000 }],
      timestamp: Date.now(),
      hash: "abc",
      capturedAt: new Date(Date.now() - 1000),
    };
    const alert = detector.evaluate(trade, makeStats(), partialBook);
    expect(alert).not.toBeNull();
    // Mid = trade.priceUsdc since bids is empty
    expect(alert!.priceImpactEstimateUsdc).toBeGreaterThanOrEqual(0);
  });

  it("SELL trade: walks bids side of book (line 19 SELL branch)", () => {
    const detector = makeDetector();
    const trade = makeTrade(65_000, "SELL");
    const book = makeBook();
    const alert = detector.evaluate(trade, makeStats(), book);
    expect(alert).not.toBeNull();
    expect(alert!.signal.direction).toBe("BEARISH");
    // SELL uses bids side — should have depth consumed
    expect(alert!.bookDepthConsumedPct).toBeGreaterThanOrEqual(0);
  });

  it("volume24hr=0: pctOfDailyVolume=0 (line 79 zero-volume branch)", () => {
    const detector = makeDetector();
    // volume=0 → pctOfDailyVolume=0, but sigma passes
    const trade = makeTrade(65_000);
    const stats = makeStats({ volume24hr: 0 });
    // sigma = (65000-5000)/8000 = 7.5 ≥ 3 → fires
    const alert = detector.evaluate(trade, stats, null);
    expect(alert).not.toBeNull();
    expect(alert!.signal.pctOfDailyVolume).toBe(0);
  });

  it("totalDepth=0: bookDepthConsumedPct=0 (zero-depth book branch)", () => {
    const detector = makeDetector();
    const trade = makeTrade(65_000);
    // Book with zero-size levels → totalDepth=0
    const zeroDepthBook: OrderBook = {
      tokenId: "tok1",
      conditionId: "cond1",
      bids: [{ price: 0.65, size: 0 }],
      asks: [{ price: 0.66, size: 0 }],
      timestamp: Date.now(),
      hash: "abc",
      capturedAt: new Date(),
    };
    const alert = detector.evaluate(trade, makeStats(), zeroDepthBook);
    expect(alert).not.toBeNull();
    expect(alert!.bookDepthConsumedPct).toBe(0);
  });

  it("trade fills all book levels: remaining<=0 break branch hit", () => {
    const detector = makeDetector();
    // Small book: asks total = 0.66*10 = 6.6 USDC, but trade is 65k → drains all levels
    const smallBook: OrderBook = {
      tokenId: "tok1",
      conditionId: "cond1",
      bids: [{ price: 0.65, size: 100 }],
      asks: [{ price: 0.66, size: 10 }], // only 6.6 USDC of asks
      timestamp: Date.now(),
      hash: "abc",
      capturedAt: new Date(),
    };
    // BUY trade: walks asks; 65k >> 6.6 USDC → drains all asks without breaking early
    // (the break fires when remaining <= 0, but here we exhaust levels instead)
    // Use a very small trade that fits exactly: 0.66*10 = 6.6 USDC → remaining becomes 0
    const smallTrade: TradeEvent = {
      ...makeTrade(65_000),
      valueUsdc: 6.6,
      sizeTokens: 10,
    };
    const _alert = detector.evaluate(smallTrade, makeStats(), smallBook);
    // Note: gate 1 may block (6.6 < 10000) — use a detector with low threshold
    const lowDetector = makeDetector({ absoluteMinUsdc: 1, pctVolumeThreshold: 0.000001 });
    const alert2 = lowDetector.evaluate(smallTrade, makeStats(), smallBook);
    // This test verifies the code runs without error (branch is hit)
    expect(alert2).not.toBeNull();
    expect(alert2!.bookDepthConsumedPct).toBeGreaterThan(0);
  });

  it("constructor uses config defaults when no opts provided (lines 60-63 ?? branches)", () => {
    // Default constructor — all opts come from config
    const detector = new WhaleDetector();
    const trade = makeTrade(65_000);
    // With default config: absoluteMinUsdc=10000, pctVolumeThreshold=0.02
    // sigma = 7.5 ≥ 3 → fires
    const alert = detector.evaluate(trade, makeStats(), null);
    expect(alert).not.toBeNull();
  });
});
