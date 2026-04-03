import { describe, it, expect } from "vitest";
import { evaluatePriceImpact } from "./price-impact-signal.js";
import type { PricePoint } from "./price-impact-signal.js";

const OPTS = {
  windowSec: 60,
  minChangePct: 2.0,
  minLiquidityUsdc: 50_000,
};

function makeHistory(prices: number[]): PricePoint[] {
  const now = Date.now();
  return prices.map((price, i) => ({
    price,
    recordedAt: new Date(now - (prices.length - i) * 10_000),
  }));
}

describe("evaluatePriceImpact", () => {
  it("returns null with < 2 price points", () => {
    const result = evaluatePriceImpact("tok1", "cond1", [{ price: 0.65, recordedAt: new Date() }], 10000, 100000, OPTS);
    expect(result).toBeNull();
  });

  it("returns null with empty history (0 points)", () => {
    const result = evaluatePriceImpact("tok1", "cond1", [], 50000, 100000, OPTS);
    expect(result).toBeNull();
  });

  it("returns null when change < 2%", () => {
    const history = makeHistory([0.65, 0.66]); // 1.54% change
    const result = evaluatePriceImpact("tok1", "cond1", history, 10000, 100000, OPTS);
    expect(result).toBeNull();
  });

  it("returns null when priceStart is 0 (division guard)", () => {
    const history = makeHistory([0, 0.65]);
    const result = evaluatePriceImpact("tok1", "cond1", history, 50000, 100000, OPTS);
    expect(result).toBeNull();
  });

  it("returns BULLISH when price increases > 2%", () => {
    const history = makeHistory([0.65, 0.68]); // 4.6% increase
    const result = evaluatePriceImpact("tok1", "cond1", history, 50000, 100000, OPTS);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("BULLISH");
    expect(result!.priceChangePct).toBeGreaterThan(2.0);
  });

  it("returns BEARISH when price decreases > 2%", () => {
    const history = makeHistory([0.68, 0.65]); // 4.4% decrease
    const result = evaluatePriceImpact("tok1", "cond1", history, 50000, 100000, OPTS);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("BEARISH");
  });

  it("confidence computed and capped at 1.0", () => {
    const history = makeHistory([0.50, 0.60]); // 20% → confidence=1.0
    const result = evaluatePriceImpact("tok1", "cond1", history, 50000, 100000, OPTS);
    expect(result!.confidence).toBe(1.0);

    const history2 = makeHistory([0.65, 0.68]); // 4.6% → confidence=0.46
    const result2 = evaluatePriceImpact("tok1", "cond1", history2, 50000, 100000, OPTS);
    expect(result2!.confidence).toBeLessThan(1.0);
    expect(result2!.confidence).toBeGreaterThan(0);
  });

  it("liquidity guard: returns null if under threshold", () => {
    const history = makeHistory([0.65, 0.68]);
    const result = evaluatePriceImpact("tok1", "cond1", history, 50000, 10_000, OPTS);
    expect(result).toBeNull();
  });

  it("triggeringTradeValueUsdc included in result", () => {
    const history = makeHistory([0.65, 0.68]);
    const result = evaluatePriceImpact("tok1", "cond1", history, 75000, 100000, OPTS);
    expect(result!.triggeringTradeValueUsdc).toBe(75000);
  });

  it("signal shape: signalType and windowSeconds present", () => {
    const history = makeHistory([0.65, 0.68]);
    const result = evaluatePriceImpact("tok1", "cond1", history, 50000, 100000, OPTS);
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe("PRICE_IMPACT_ANOMALY");
    expect(result!.windowSeconds).toBe(60);
  });

  it("uses config defaults when opts not provided (exercises ?? branches)", () => {
    // Call without opts — exercises the opts.windowSec ?? config.xxx fallback branches
    const history = makeHistory([0.65, 0.70]); // 7.69% change — above default 2% threshold
    // liquidityUsdc 100k — above default 50k threshold → should fire
    const result = evaluatePriceImpact("tok1", "cond1", history, 50000, 100_000);
    expect(result).not.toBeNull();
  });
});
