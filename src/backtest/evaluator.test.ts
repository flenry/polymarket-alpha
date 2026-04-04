import { describe, it, expect } from "vitest";
import { evaluate } from "./evaluator.js";
import type { SignalOutcome, BacktestConfig } from "./types.js";

const BASE_CONFIG: BacktestConfig = {
  startDate: new Date("2025-01-01"),
  endDate: new Date("2025-04-01"),
};

function makeOutcome(
  overrides: Partial<SignalOutcome> & Pick<SignalOutcome, "signalType" | "direction" | "marketWinner">
): SignalOutcome {
  return {
    signalId: 1n,
    confidence: 0.7,
    tokenId: "tok1",
    createdAt: new Date("2025-02-01"),
    ...overrides,
  };
}

describe("BacktestEvaluator", () => {
  // ── Zero-division guards ──────────────────────────────────────────────

  it("returns all-zero metrics when no signals provided", () => {
    const result = evaluate([], BASE_CONFIG);
    expect(result.overall.totalFired).toBe(0);
    expect(result.overall.precision).toBe(0);
    expect(result.overall.resolvedHitRate).toBe(0);
    expect(result.overall.f1).toBe(0);
    expect(result.overall.avgConfidence).toBe(0);
    expect(Object.keys(result.byType)).toHaveLength(0);
  });

  it("resolvedHitRate = 0 when no signals resolved (all marketWinner=null)", () => {
    const outcomes = [
      makeOutcome({ signalType: "WHALE_TRADE", direction: "BULLISH", marketWinner: null }),
      makeOutcome({ signalType: "WHALE_TRADE", direction: "BULLISH", marketWinner: null }),
    ];
    const result = evaluate(outcomes, BASE_CONFIG);
    expect(result.overall.totalResolved).toBe(0);
    expect(result.overall.resolvedHitRate).toBe(0);
    expect(result.overall.totalFired).toBe(2);
  });

  // ── Precision / resolvedHitRate / f1 math ──────────────────────────────

  it("precision = correct / totalFired (including unresolved)", () => {
    // 4 fired, 2 correct (resolved+correct), 1 resolved-but-wrong, 1 unresolved
    const outcomes = [
      makeOutcome({ signalType: "WHALE_TRADE", direction: "BULLISH", marketWinner: true }),   // correct
      makeOutcome({ signalType: "WHALE_TRADE", direction: "BULLISH", marketWinner: true }),   // correct
      makeOutcome({ signalType: "WHALE_TRADE", direction: "BULLISH", marketWinner: false }),  // resolved, wrong
      makeOutcome({ signalType: "WHALE_TRADE", direction: "BULLISH", marketWinner: null }),   // unresolved
    ];
    const result = evaluate(outcomes, BASE_CONFIG);
    expect(result.overall.totalFired).toBe(4);
    expect(result.overall.totalResolved).toBe(3); // 2 correct + 1 wrong
    expect(result.overall.totalCorrect).toBe(2);
    expect(result.overall.precision).toBeCloseTo(2 / 4, 5);    // 0.5
    expect(result.overall.resolvedHitRate).toBeCloseTo(2 / 3, 5); // 0.667
  });

  it("f1 is harmonic mean of precision and resolvedHitRate", () => {
    const outcomes = [
      makeOutcome({ signalType: "WHALE_TRADE", direction: "BULLISH", marketWinner: true }),
      makeOutcome({ signalType: "WHALE_TRADE", direction: "BULLISH", marketWinner: false }),
    ];
    const result = evaluate(outcomes, BASE_CONFIG);
    // precision = 1/2 = 0.5, resolvedHitRate = 1/2 = 0.5
    // f1 = 2 * 0.5 * 0.5 / (0.5 + 0.5) = 0.5
    expect(result.overall.f1).toBeCloseTo(0.5, 5);
  });

  it("f1 = 0 when precision + resolvedHitRate = 0", () => {
    const outcomes = [
      makeOutcome({ signalType: "WHALE_TRADE", direction: "BULLISH", marketWinner: false }),
    ];
    const result = evaluate(outcomes, BASE_CONFIG);
    // precision = 0/1 = 0, resolvedHitRate = 0/1 = 0 → f1 = 0
    expect(result.overall.f1).toBe(0);
  });

  // ── BEARISH direction ──────────────────────────────────────────────────

  it("BEARISH + winner=false → correct (market declined = BEARISH correct)", () => {
    // In SignalOutcome, marketWinner=true means signal direction was correct.
    // The runner sets marketWinner=true when: BULLISH+winner=true OR BEARISH+winner=false.
    // Evaluator just checks marketWinner===true.
    const outcomes = [
      makeOutcome({ signalType: "WHALE_TRADE", direction: "BEARISH", marketWinner: true }), // correct
    ];
    const result = evaluate(outcomes, BASE_CONFIG);
    expect(result.overall.totalCorrect).toBe(1);
    expect(result.overall.precision).toBe(1);
  });

  // ── Per-type breakdown ─────────────────────────────────────────────────

  it("computes per-type metrics independently", () => {
    const outcomes = [
      makeOutcome({ signalType: "WHALE_TRADE", direction: "BULLISH", marketWinner: true }),
      makeOutcome({ signalType: "WHALE_TRADE", direction: "BULLISH", marketWinner: false }),
      makeOutcome({ signalType: "ORDER_BOOK_IMBALANCE", direction: "BULLISH", marketWinner: true }),
      makeOutcome({ signalType: "ORDER_BOOK_IMBALANCE", direction: "BULLISH", marketWinner: true }),
      makeOutcome({ signalType: "ORDER_BOOK_IMBALANCE", direction: "BULLISH", marketWinner: false }),
    ];
    const result = evaluate(outcomes, BASE_CONFIG);

    // WHALE_TRADE: 2 fired, 1 correct
    expect(result.byType["WHALE_TRADE"]?.totalFired).toBe(2);
    expect(result.byType["WHALE_TRADE"]?.totalCorrect).toBe(1);
    expect(result.byType["WHALE_TRADE"]?.precision).toBeCloseTo(0.5, 5);

    // ORDER_BOOK_IMBALANCE: 3 fired, 2 correct
    expect(result.byType["ORDER_BOOK_IMBALANCE"]?.totalFired).toBe(3);
    expect(result.byType["ORDER_BOOK_IMBALANCE"]?.totalCorrect).toBe(2);
    expect(result.byType["ORDER_BOOK_IMBALANCE"]?.precision).toBeCloseTo(2 / 3, 5);
  });

  it("mixed signal types: overall metrics aggregate all", () => {
    const outcomes = [
      makeOutcome({ signalType: "WHALE_TRADE", direction: "BULLISH", marketWinner: true }),
      makeOutcome({ signalType: "PRICE_IMPACT_ANOMALY", direction: "BULLISH", marketWinner: false }),
    ];
    const result = evaluate(outcomes, BASE_CONFIG);
    expect(result.overall.totalFired).toBe(2);
    expect(result.overall.totalCorrect).toBe(1);
    expect(Object.keys(result.byType)).toHaveLength(2);
  });

  // ── avgConfidence ──────────────────────────────────────────────────────

  it("avgConfidence computed correctly", () => {
    const outcomes = [
      makeOutcome({ signalType: "WHALE_TRADE", direction: "BULLISH", marketWinner: true, confidence: 0.4 }),
      makeOutcome({ signalType: "WHALE_TRADE", direction: "BULLISH", marketWinner: true, confidence: 0.8 }),
    ];
    const result = evaluate(outcomes, BASE_CONFIG);
    expect(result.overall.avgConfidence).toBeCloseTo(0.6, 5);
  });

  // ── Config pass-through ────────────────────────────────────────────────

  it("result.config equals the input config", () => {
    const result = evaluate([], BASE_CONFIG);
    expect(result.config).toBe(BASE_CONFIG);
  });
});
