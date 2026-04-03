import { describe, it, expect } from "vitest";
import { WhaleDetector } from "../src/processors/whale-detector.js";
import whaleTrade from "./fixtures/whale-trade.json" assert { type: "json" };
import type { TradeEvent, MarketStats } from "../src/events/types.js";

// FROZEN: do not edit without updating consuming tests

const OPTS = {
  absoluteMinUsdc: 10_000,
  sigmaThreshold: 3.0,
  pctVolumeThreshold: 0.02,
  minLiquidityUsdc: 50_000,
};

function makeCalibratedStats(): MarketStats {
  return {
    tokenId: whaleTrade.tokenId,
    volume24hr: 2_500_000,
    avgTradeSize24h: 5_000,
    stddevTradeSize24h: 8_000,
    liquidityUsdc: 500_000,
    tradeCount24h: 60,
    calibrated: true,
  };
}

function makeTradeFromFixture(): TradeEvent {
  return {
    ...whaleTrade,
    tradedAt: new Date(whaleTrade.tradedAt),
    source: "live_ws" as const,
    side: whaleTrade.side as "BUY" | "SELL",
  };
}

describe("WhaleDetector (fixture-based)", () => {
  it("fires on fixture whale trade exceeding both thresholds", () => {
    const detector = new WhaleDetector(OPTS);
    const trade = makeTradeFromFixture();
    const stats = makeCalibratedStats();

    // valueUsdc=75000, avg=5000, stddev=8000 → sigma = 8.75 ≥ 3
    // pct = 75000 / 2500000 = 3% ≥ 2%
    const alert = detector.evaluate(trade, stats, null);

    expect(alert).not.toBeNull();
    expect(alert!.emitSignal).toBe(true);
    expect(alert!.signal.signalType).toBe("WHALE_TRADE");
  });

  it("neg_risk trade filtered (not evaluated): WhaleDetector itself doesn't filter — LiveDataWsClient does", () => {
    // WhaleDetector evaluates any trade passed to it.
    // Neg-risk filtering happens at ingestion (LiveDataWsClient).
    // This test verifies WhaleDetector still works on a trade passed through.
    const detector = new WhaleDetector(OPTS);
    const trade = makeTradeFromFixture();
    const stats = makeCalibratedStats();
    const alert = detector.evaluate(trade, stats, null);
    // Should fire normally
    expect(alert).not.toBeNull();
  });

  it("absolute gate: valueUsdc < absoluteMinUsdc → no alert", () => {
    const detector = new WhaleDetector(OPTS);
    const trade = { ...makeTradeFromFixture(), valueUsdc: 9_999 };
    const alert = detector.evaluate(trade, makeCalibratedStats(), null);
    expect(alert).toBeNull();
  });
});
