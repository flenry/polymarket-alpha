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

  it("returns null when change < 2%", () => {
    // 0.65 → 0.66 = 1.54% change
    const history = makeHistory([0.65, 0.66]);
    const result = evaluatePriceImpact("tok1", "cond1", history, 10000, 100000, OPTS);
    expect(result).toBeNull();
  });

  it("returns BULLISH when price increases > 2%", () => {
    // 0.65 → 0.68 = 4.6% increase
    const history = makeHistory([0.65, 0.68]);
    const result = evaluatePriceImpact("tok1", "cond1", history, 50000, 100000, OPTS);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("BULLISH");
    expect(result!.priceChangePct).toBeGreaterThan(2.0);
  });

  it("returns BEARISH when price decreases > 2%", () => {
    // 0.68 → 0.65 = 4.4% decrease
    const history = makeHistory([0.68, 0.65]);
    const result = evaluatePriceImpact("tok1", "cond1", history, 50000, 100000, OPTS);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("BEARISH");
  });

  it("confidence computed and capped at 1.0", () => {
    // 0.50 → 0.60 = 20% change → confidence = min(1.0, 20/10) = 1.0
    const history = makeHistory([0.50, 0.60]);
    const result = evaluatePriceImpact("tok1", "cond1", history, 50000, 100000, OPTS);
    expect(result!.confidence).toBe(1.0);

    // 0.65 → 0.68 = 4.6% → confidence = 0.46
    const history2 = makeHistory([0.65, 0.68]);
    const result2 = evaluatePriceImpact("tok1", "cond1", history2, 50000, 100000, OPTS);
    expect(result2!.confidence).toBeLessThan(1.0);
    expect(result2!.confidence).toBeGreaterThan(0);
  });

  it("liquidity guard: returns null if under threshold", () => {
    const history = makeHistory([0.65, 0.68]); // 4.6% change
    const result = evaluatePriceImpact("tok1", "cond1", history, 50000, 10_000, OPTS);
    expect(result).toBeNull();
  });

  it("triggeringTradeValueUsdc included in result", () => {
    const history = makeHistory([0.65, 0.68]);
    const result = evaluatePriceImpact("tok1", "cond1", history, 75000, 100000, OPTS);
    expect(result!.triggeringTradeValueUsdc).toBe(75000);
  });
});
