import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ArbDetector } from "./arb-detector.js";
import type { NegRiskGroup } from "./group-resolver.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeGroup(
  sumAsk: number,
  tokenCount = 3,
  conditionId = "cond1",
  isValid = true
): NegRiskGroup {
  const tokenPrice = sumAsk / tokenCount;
  return {
    conditionId,
    sumAsk,
    sumBid: sumAsk - 0.05 * tokenCount,
    isValid,
    tokens: Array.from({ length: tokenCount }, (_, i) => ({
      tokenId: `tok${i + 1}`,
      conditionId,
      bestAsk: tokenPrice,
      bestBid: tokenPrice - 0.02,
      question: `Outcome ${i + 1}`,
    })),
  };
}

/** Make a DB that returns `rows` from price-history queries */
function makeDb(priceRows: Array<{ price: string; recordedAt: Date }> = []) {
  const orderByFn = vi.fn().mockResolvedValue(priceRows);
  const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  return { select: selectFn } as unknown as ConstructorParameters<typeof ArbDetector>[0];
}

/** Build price rows with a consistent mean */
function priceRows(count: number, mean: number, spread = 0.01): Array<{ price: string; recordedAt: Date }> {
  return Array.from({ length: count }, (_, i) => ({
    price: String(mean + (i % 2 === 0 ? spread : -spread)),
    recordedAt: new Date(Date.now() - i * 60_000),
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ArbDetector.evaluate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-04-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ARB signal fires when sumAsk < 0.98 (arbSpread < -0.02)", async () => {
    // sumAsk = 0.90 → arbSpread = -0.10 < -0.02
    const group = makeGroup(0.90, 3, "cond1");
    const db = makeDb(); // no price history → outlier skipped
    const detector = new ArbDetector(db, { arbThreshold: -0.02, cooldownMs: 0 });
    const signals = await detector.evaluate(group);
    expect(signals).toHaveLength(1);
    expect(signals[0].signalType).toBe("NEG_RISK_ARB");
    expect(signals[0].direction).toBe("BULLISH");
    expect(signals[0].arbSpread).toBeCloseTo(-0.10, 4);
  });

  it("ARB signal NOT fired when sumAsk = 0.99 (arbSpread = -0.01 ≥ -0.02)", async () => {
    const group = makeGroup(0.99, 3, "cond1");
    const db = makeDb();
    const detector = new ArbDetector(db, { arbThreshold: -0.02, cooldownMs: 0 });
    const signals = await detector.evaluate(group);
    expect(signals).toHaveLength(0);
  });

  it("OUTLIER signal fires (BULLISH): token underpriced by 4σ", async () => {
    // Three tokens. tok1 is underpriced: its ask is 0.30 but mean history is 0.38
    // stddev ≈ spread, so deviation = (0.38 - 0.30) / small ≈ 4σ
    const group: NegRiskGroup = {
      conditionId: "cond1",
      sumAsk: 0.99, // not triggering ARB
      sumBid: 0.94,
      isValid: true,
      tokens: [
        { tokenId: "tok1", conditionId: "cond1", bestAsk: 0.30, bestBid: 0.28, question: "A" },
        { tokenId: "tok2", conditionId: "cond1", bestAsk: 0.40, bestBid: 0.38, question: "B" },
        { tokenId: "tok3", conditionId: "cond1", bestAsk: 0.29, bestBid: 0.27, question: "C" },
      ],
    };

    // Build a DB that returns history with mean=0.38, stddev≈0.01 for tok1
    // underpricedDev = (0.38 - 0.30) / 0.01 = 8.0 > 3.0
    const tok1History = Array.from({ length: 10 }, (_, i) => ({
      price: String(i % 2 === 0 ? "0.39" : "0.37"),
      recordedAt: new Date(Date.now() - i * 60_000),
    }));

    const orderByFn = vi.fn()
      .mockResolvedValueOnce(tok1History) // tok1
      .mockResolvedValue([]); // tok2, tok3 — no history

    const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as ConstructorParameters<typeof ArbDetector>[0];

    const detector = new ArbDetector(db, { arbThreshold: -0.02, cooldownMs: 0 });
    const signals = await detector.evaluate(group);
    const outlier = signals.find((s) => s.signalType === "NEG_RISK_OUTLIER");
    expect(outlier).toBeDefined();
    expect(outlier!.direction).toBe("BULLISH");
    expect(outlier!.tokenId).toBe("tok1");
  });

  it("OUTLIER signal fires (BEARISH): token overpriced by 4σ", async () => {
    const group: NegRiskGroup = {
      conditionId: "cond1",
      sumAsk: 0.99,
      sumBid: 0.94,
      isValid: true,
      tokens: [
        { tokenId: "tok1", conditionId: "cond1", bestAsk: 0.46, bestBid: 0.44, question: "A" },
        { tokenId: "tok2", conditionId: "cond1", bestAsk: 0.28, bestBid: 0.26, question: "B" },
        { tokenId: "tok3", conditionId: "cond1", bestAsk: 0.25, bestBid: 0.23, question: "C" },
      ],
    };

    // tok1 history: mean=0.38, stddev≈0.01 → overpricedDev = (0.46 - 0.38) / 0.01 = 8.0
    const tok1History = Array.from({ length: 10 }, (_, i) => ({
      price: String(i % 2 === 0 ? "0.39" : "0.37"),
      recordedAt: new Date(Date.now() - i * 60_000),
    }));

    const orderByFn = vi.fn()
      .mockResolvedValueOnce(tok1History)
      .mockResolvedValue([]);

    const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as ConstructorParameters<typeof ArbDetector>[0];

    const detector = new ArbDetector(db, { arbThreshold: -0.02, cooldownMs: 0 });
    const signals = await detector.evaluate(group);
    const outlier = signals.find((s) => s.signalType === "NEG_RISK_OUTLIER");
    expect(outlier).toBeDefined();
    expect(outlier!.direction).toBe("BEARISH");
    expect(outlier!.tokenId).toBe("tok1");
  });

  it("cooldown suppresses second evaluate() within cooldownMs for same conditionId", async () => {
    const group = makeGroup(0.90, 3, "cond1");
    const db = makeDb();
    const detector = new ArbDetector(db, { arbThreshold: -0.02, cooldownMs: 60_000 });

    const first = await detector.evaluate(group);
    expect(first).toHaveLength(1); // ARB fires

    // Second call within cooldown
    vi.advanceTimersByTime(30_000);
    const second = await detector.evaluate(group);
    expect(second).toHaveLength(0); // suppressed
  });

  it("cooldown expires after cooldownMs — subsequent call fires again", async () => {
    const group = makeGroup(0.90, 3, "cond1");
    const db = makeDb();
    const detector = new ArbDetector(db, { arbThreshold: -0.02, cooldownMs: 60_000 });

    await detector.evaluate(group); // first fire
    vi.advanceTimersByTime(61_000); // expire cooldown
    const signals = await detector.evaluate(group);
    expect(signals).toHaveLength(1);
  });

  it("invalid group (isValid=false) → return [] immediately", async () => {
    const group = makeGroup(0.90, 3, "cond1", false /* isValid=false */);
    const db = makeDb();
    const detector = new ArbDetector(db, { arbThreshold: -0.02, cooldownMs: 0 });
    const signals = await detector.evaluate(group);
    expect(signals).toHaveLength(0);
  });

  it("price history < 5 points: outlier check skipped, ARB can still fire", async () => {
    const group = makeGroup(0.90, 3, "cond1");
    // Only 3 history points per token — below the 5-point minimum
    const fewHistory = priceRows(3, 0.38);
    const orderByFn = vi.fn().mockResolvedValue(fewHistory);
    const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as ConstructorParameters<typeof ArbDetector>[0];

    const detector = new ArbDetector(db, { arbThreshold: -0.02, cooldownMs: 0 });
    const signals = await detector.evaluate(group);
    // Only ARB, no OUTLIER
    expect(signals.some((s) => s.signalType === "NEG_RISK_ARB")).toBe(true);
    expect(signals.some((s) => s.signalType === "NEG_RISK_OUTLIER")).toBe(false);
  });

  it("stddev = 0: outlier skipped (division guard)", async () => {
    const group = makeGroup(0.90, 3, "cond1");
    // All prices identical → stddev = 0
    const flatHistory = Array.from({ length: 10 }, () => ({
      price: "0.38",
      recordedAt: new Date(),
    }));
    const orderByFn = vi.fn().mockResolvedValue(flatHistory);
    const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as ConstructorParameters<typeof ArbDetector>[0];

    const detector = new ArbDetector(db, { arbThreshold: -0.02, cooldownMs: 0 });
    const signals = await detector.evaluate(group);
    expect(signals.some((s) => s.signalType === "NEG_RISK_OUTLIER")).toBe(false);
  });

  it("confidence scaling: arbSpread=-0.10 → confidence=1.0; deviation=3.5 → confidence=0.70", async () => {
    const group = makeGroup(0.90, 3, "cond1"); // arbSpread = -0.10
    const db = makeDb();
    const detector = new ArbDetector(db, { arbThreshold: -0.02, cooldownMs: 0 });
    const signals = await detector.evaluate(group);
    const arb = signals.find((s) => s.signalType === "NEG_RISK_ARB");
    expect(arb!.confidence).toBeCloseTo(1.0, 4); // min(1.0, 0.10/0.05) = 1.0

    // Test outlier confidence: deviation=3.5 → min(1.0, 3.5/5.0) = 0.70
    // Build a group with tok1 at 3.5σ underpriced
    const group2: NegRiskGroup = {
      conditionId: "cond2",
      sumAsk: 0.99,
      sumBid: 0.94,
      isValid: true,
      tokens: [
        { tokenId: "tokA", conditionId: "cond2", bestAsk: 0.345, bestBid: 0.325, question: "A" },
        { tokenId: "tokB", conditionId: "cond2", bestAsk: 0.30, bestBid: 0.28, question: "B" },
        { tokenId: "tokC", conditionId: "cond2", bestAsk: 0.345, bestBid: 0.325, question: "C" },
      ],
    };
    // history for tokA: mean=0.38, stddev=0.01 → underpricedDev=(0.38-0.345)/0.01=3.5
    const tokAHistory = Array.from({ length: 10 }, (_, i) => ({
      price: String(i % 2 === 0 ? "0.39" : "0.37"),
      recordedAt: new Date(Date.now() - i * 60_000),
    }));
    const orderByFn2 = vi.fn()
      .mockResolvedValueOnce(tokAHistory)
      .mockResolvedValue([]);
    const whereFn2 = vi.fn().mockReturnValue({ orderBy: orderByFn2 });
    const fromFn2 = vi.fn().mockReturnValue({ where: whereFn2 });
    const selectFn2 = vi.fn().mockReturnValue({ from: fromFn2 });
    const db2 = { select: selectFn2 } as unknown as ConstructorParameters<typeof ArbDetector>[0];

    const detector2 = new ArbDetector(db2, { arbThreshold: -0.02, cooldownMs: 0 });
    const signals2 = await detector2.evaluate(group2);
    const outlier = signals2.find((s) => s.signalType === "NEG_RISK_OUTLIER");
    expect(outlier).toBeDefined();
    // deviation = 3.5 → confidence = min(1.0, 3.5/5.0) = 0.70
    expect(outlier!.confidence).toBeCloseTo(0.70, 2);
  });

  it("both ARB and OUTLIER can fire in the same evaluate() call", async () => {
    // sumAsk = 0.90 (triggers ARB) AND tok1 is underpriced by 4σ
    const group: NegRiskGroup = {
      conditionId: "cond1",
      sumAsk: 0.90,
      sumBid: 0.85,
      isValid: true,
      tokens: [
        { tokenId: "tok1", conditionId: "cond1", bestAsk: 0.30, bestBid: 0.28, question: "A" },
        { tokenId: "tok2", conditionId: "cond1", bestAsk: 0.30, bestBid: 0.28, question: "B" },
        { tokenId: "tok3", conditionId: "cond1", bestAsk: 0.30, bestBid: 0.28, question: "C" },
      ],
    };

    // tok1 history gives 4σ underprice
    const tok1History = Array.from({ length: 10 }, (_, i) => ({
      price: String(i % 2 === 0 ? "0.39" : "0.37"),
      recordedAt: new Date(Date.now() - i * 60_000),
    }));
    const orderByFn = vi.fn()
      .mockResolvedValueOnce(tok1History)
      .mockResolvedValue([]);

    const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as ConstructorParameters<typeof ArbDetector>[0];

    const detector = new ArbDetector(db, { arbThreshold: -0.02, cooldownMs: 0 });
    const signals = await detector.evaluate(group);
    expect(signals.some((s) => s.signalType === "NEG_RISK_ARB")).toBe(true);
    expect(signals.some((s) => s.signalType === "NEG_RISK_OUTLIER")).toBe(true);
  });

  it("negRiskGroupSize, negRiskSumBid, negRiskSumAsk carried on signal", async () => {
    const group = makeGroup(0.90, 3, "cond1");
    const db = makeDb();
    const detector = new ArbDetector(db, { arbThreshold: -0.02, cooldownMs: 0 });
    const signals = await detector.evaluate(group);
    const arb = signals[0];
    expect(arb.negRiskGroupSize).toBe(3);
    expect(arb.negRiskSumAsk).toBeCloseTo(0.90, 4);
    expect(arb.conditionIdGroup).toBe("cond1");
  });
});
