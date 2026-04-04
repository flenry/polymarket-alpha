import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PriceImpactSignalEvaluator } from "./price-impact-signal.js";
import type { TradeEvent } from "../events/types.js";
import type { SnapshotRecord } from "../db/queries/snapshots.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeTrade(overrides?: Partial<TradeEvent>): TradeEvent {
  return {
    tokenId: "tok1",
    conditionId: "cond1",
    side: "BUY",
    sizeTokens: 10000,
    priceUsdc: 0.72,
    valueUsdc: 7200,
    proxyWallet: "0xwallet",
    transactionHash: "0xtx",
    tradedAt: new Date(),
    outcome: "Yes",
    marketSlug: "test",
    eventSlug: "test",
    marketTitle: "Test Market",
    source: "live_ws",
    ...overrides,
  };
}

function makeSnapshot(overrides?: Partial<SnapshotRecord>): SnapshotRecord {
  return {
    tokenId: "tok1",
    conditionId: "cond1",
    bids: [{ price: "0.68", size: "5000" }],
    asks: [{ price: "0.72", size: "5000" }],
    bidDepthUsdc: 50_000,
    askDepthUsdc: 50_000,
    imbalanceRatio: 1.0,
    capturedAt: new Date(), // fresh
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PriceImpactSignalEvaluator", () => {
  let evaluator: PriceImpactSignalEvaluator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-03-01T12:00:00Z"));
    evaluator = new PriceImpactSignalEvaluator({ threshold: 2.5, cooldownMs: 30_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Fire conditions ─────────────────────────────────────────────────────

  it("fires BULLISH signal for BUY trade when score > threshold", async () => {
    // valueUsdc=7200, askDepthUsdc=1000 → expectedImpact=7.2
    // priceMove: |0.72-0.60|/0.60 = 0.20 → actualImpact=0.20
    // score = 0.20 / 7.2 ≈ 0.028 ... hmm let's flip: small depth so big score
    // depthUsdc=500, valueUsdc=5000 → expectedImpact=10
    // priceMove = |0.72-0.50|/0.50=0.44 → score=0.44/10=0.044 — still < 2.5
    // Let's use: depthUsdc=100, valueUsdc=1000, expectedImpact=10
    // actualImpact = |0.80-0.50|/0.50 = 0.60 → score=0.60/10=0.06 — still too small
    // Correct way: actualImpact MUCH larger than expectedImpact
    // expectedImpact = valueUsdc/depth = small (e.g. 1000/100_000 = 0.01)
    // actualImpact = |Δprice|/priceBefore = 0.20 (20% move)
    // score = 0.20/0.01 = 20 > 2.5 ✓
    const snap = makeSnapshot({ askDepthUsdc: 100_000, bidDepthUsdc: 100_000 });
    const trade = makeTrade({ side: "BUY", valueUsdc: 1_000 }); // small relative to depth but big actual move
    const result = await evaluator.evaluate(trade, 0.50, 0.70, snap);
    // expectedImpact = 1000/100000 = 0.01; actualImpact = |0.70-0.50|/0.50 = 0.40; score = 40 > 2.5
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("BULLISH");
    expect(result!.signalType).toBe("PRICE_IMPACT_ANOMALY");
  });

  it("fires BEARISH signal for SELL trade using bid depth", async () => {
    const snap = makeSnapshot({ bidDepthUsdc: 100_000, askDepthUsdc: 100_000 });
    const trade = makeTrade({ side: "SELL", valueUsdc: 1_000 });
    // same math: actualImpact big relative to expected
    const result = await evaluator.evaluate(trade, 0.70, 0.50, snap);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("BEARISH");
  });

  it("BUY uses askDepthUsdc (corrected depth mapping)", async () => {
    // BUY with large ask depth → small expectedImpact → easy to exceed threshold
    const snapLargeAsk = makeSnapshot({ askDepthUsdc: 100_000, bidDepthUsdc: 1 });
    const trade = makeTrade({ side: "BUY", valueUsdc: 1_000 });
    const result = await evaluator.evaluate(trade, 0.50, 0.70, snapLargeAsk);
    // expectedImpact = 1000/100000 = 0.01; actualImpact=0.40; score=40 > 2.5 → fires
    expect(result).not.toBeNull();
  });

  it("SELL uses bidDepthUsdc", async () => {
    const snapLargeBid = makeSnapshot({ bidDepthUsdc: 100_000, askDepthUsdc: 1 });
    const trade = makeTrade({ side: "SELL", valueUsdc: 1_000 });
    const result = await evaluator.evaluate(trade, 0.70, 0.50, snapLargeBid);
    expect(result).not.toBeNull();
  });

  // ── Skip conditions ────────────────────────────────────────────────────

  it("returns null when snapshot is null", async () => {
    const result = await evaluator.evaluate(makeTrade(), 0.68, 0.72, null);
    expect(result).toBeNull();
  });

  it("returns null and logs warn when snapshot is older than 60s", async () => {
    const stale = makeSnapshot({
      capturedAt: new Date(Date.now() - 61_000), // 61s ago
    });
    const warnSpy = vi.spyOn(await import("../logger.js").then((m) => m.logger), "warn");
    const result = await evaluator.evaluate(makeTrade(), 0.68, 0.72, stale);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotAgeMs: expect.any(Number) }),
      expect.stringContaining("stale snapshot")
    );
  });

  it("returns null when priceBeforeTrade is null", async () => {
    const result = await evaluator.evaluate(makeTrade(), null, 0.72, makeSnapshot());
    expect(result).toBeNull();
  });

  it("returns null when priceBeforeTrade is 0 (division guard)", async () => {
    const result = await evaluator.evaluate(makeTrade(), 0, 0.72, makeSnapshot());
    expect(result).toBeNull();
  });

  it("returns null when depthUsdc is 0 (division guard)", async () => {
    const snap = makeSnapshot({ askDepthUsdc: 0, bidDepthUsdc: 0 });
    const result = await evaluator.evaluate(makeTrade({ side: "BUY" }), 0.68, 0.72, snap);
    expect(result).toBeNull();
  });

  it("returns null when depthUsdc is null", async () => {
    const snap = makeSnapshot({ askDepthUsdc: null, bidDepthUsdc: null });
    const result = await evaluator.evaluate(makeTrade({ side: "BUY" }), 0.68, 0.72, snap);
    expect(result).toBeNull();
  });

  it("returns null when score <= threshold", async () => {
    // Large depth → small expected impact → but actual impact also small
    const snap = makeSnapshot({ askDepthUsdc: 100_000 });
    const trade = makeTrade({ valueUsdc: 1_000 });
    // expectedImpact = 0.01, actualImpact = |0.69-0.68|/0.68 ≈ 0.0147; score ≈ 1.47 < 2.5
    const result = await evaluator.evaluate(trade, 0.68, 0.69, snap);
    expect(result).toBeNull();
  });

  // ── Cooldown ───────────────────────────────────────────────────────────

  it("cooldown suppresses second call within cooldownMs", async () => {
    const snap = makeSnapshot({ askDepthUsdc: 100_000 });
    const trade = makeTrade({ valueUsdc: 1_000 });

    const first = await evaluator.evaluate(trade, 0.50, 0.70, snap);
    expect(first).not.toBeNull();

    // Immediately again — same token, within cooldown
    const second = await evaluator.evaluate(trade, 0.50, 0.70, snap);
    expect(second).toBeNull();
  });

  it("cooldown resets after cooldownMs elapses", async () => {
    const snap = makeSnapshot({ askDepthUsdc: 100_000 });
    const trade = makeTrade({ valueUsdc: 1_000 });

    await evaluator.evaluate(trade, 0.50, 0.70, snap);

    // Advance past cooldown
    vi.advanceTimersByTime(30_001);

    const result = await evaluator.evaluate(trade, 0.50, 0.70, snap);
    expect(result).not.toBeNull();
  });

  it("resetCooldown allows immediate re-fire", async () => {
    const snap = makeSnapshot({ askDepthUsdc: 100_000 });
    const trade = makeTrade({ valueUsdc: 1_000 });

    await evaluator.evaluate(trade, 0.50, 0.70, snap);
    evaluator.resetCooldown("tok1");

    const result = await evaluator.evaluate(trade, 0.50, 0.70, snap);
    expect(result).not.toBeNull();
  });

  // ── Confidence ─────────────────────────────────────────────────────────

  it("confidence scales with (score - threshold) / threshold, capped at 1.0", async () => {
    const snap = makeSnapshot({ askDepthUsdc: 100_000 });
    const trade = makeTrade({ valueUsdc: 1_000 });

    // score = actualImpact / expectedImpact
    // expectedImpact = 1000/100000 = 0.01
    // actualImpact = |0.70-0.50|/0.50 = 0.40
    // score = 40; threshold = 2.5
    // confidence = min(1.0, (40 - 2.5)/2.5) = min(1.0, 15) = 1.0
    const result = await evaluator.evaluate(trade, 0.50, 0.70, snap);
    expect(result!.confidence).toBe(1.0);
  });

  it("confidence < 1.0 for score just above threshold", async () => {
    // We need score ≈ 3.5 (just above 2.5)
    // expectedImpact = valueUsdc/depth; actualImpact = |Δp|/p0
    // score = actualImpact/expectedImpact = (|Δp|/p0) * (depth/valueUsdc)
    // target score = 3.5 → |Δp|/p0 * (depth/valueUsdc) = 3.5
    // use: depth=100000, valueUsdc=10000, expectedImpact=0.1
    //      actualImpact = 3.5 * 0.1 = 0.35 → |Δp| = 0.35 * p0 = 0.35 * 0.60 = 0.21 → priceNow=0.81
    const snap = makeSnapshot({ askDepthUsdc: 100_000 });
    const ev2 = new PriceImpactSignalEvaluator({ threshold: 2.5, cooldownMs: 0 });
    const trade = makeTrade({ valueUsdc: 10_000 });
    const result = await ev2.evaluate(trade, 0.60, 0.81, snap);

    // score = 0.35/0.1 = 3.5; confidence = (3.5-2.5)/2.5 = 0.4
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeCloseTo(0.4, 2);
    expect(result!.confidence).toBeLessThan(1.0);
  });

  // ── Custom opts ────────────────────────────────────────────────────────

  it("respects custom threshold from constructor opts", async () => {
    const highThreshold = new PriceImpactSignalEvaluator({ threshold: 50, cooldownMs: 0 });
    const snap = makeSnapshot({ askDepthUsdc: 100_000 });
    const trade = makeTrade({ valueUsdc: 1_000 });
    // score ≈ 40 < 50 → null
    const result = await highThreshold.evaluate(trade, 0.50, 0.70, snap);
    expect(result).toBeNull();
  });

  it("uses default config when no opts provided", async () => {
    const defaultEv = new PriceImpactSignalEvaluator();
    const snap = makeSnapshot({ askDepthUsdc: 100_000 });
    const trade = makeTrade({ valueUsdc: 1_000 });
    // score ≈ 40 > 2.5 (default threshold) → fires
    const result = await defaultEv.evaluate(trade, 0.50, 0.70, snap);
    expect(result).not.toBeNull();
  });
});
