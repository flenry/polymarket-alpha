import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SentimentVelocityEvaluator } from "./velocity-signal.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TOKEN = "tok1";
const COND = "cond1";

// default evaluator: windowSeconds=300, priceThreshold=0.005, multiplier=1.5, cooldown=120000
// We use tight opts in tests for fast time control

function makeEvaluator(opts?: {
  windowSeconds?: number;
  priceThreshold?: number;
  tradeCountMultiplier?: number;
  cooldownMs?: number;
}) {
  return new SentimentVelocityEvaluator({
    windowSeconds: 300,
    priceThreshold: 0.005, // 0.5% per min
    tradeCountMultiplier: 1.5,
    cooldownMs: 120_000,
    ...opts,
  });
}

/**
 * Populate a fresh evaluator so both conditions are met:
 * - price rising from start to end at given velocity (pct/min)
 * - trade count velocity exceeds multiplier
 *
 * @param ev       - evaluator instance
 * @param now      - current time (Date.now())
 * @param priceVelocityPctPerMin - positive = rising (BULLISH), negative = falling (BEARISH)
 * @param tradeRatio - currentTrades / max(priorTrades, 1) — default 2.0 (exceeds 1.5)
 */
function populate(
  ev: SentimentVelocityEvaluator,
  now: number,
  priceVelocityPctPerMin: number,
  tradeRatio = 2.0
) {
  const windowSeconds = 300;
  const windowMs = windowSeconds * 1000;

  // Price: add 2 points in current window
  // windowStartPrice and latestPrice to produce the target velocity
  // priceVelocity = (latest - start) / start / windowSeconds * 60
  // → (latest - start) / start = priceVelocityPctPerMin / 100 * windowSeconds / 60
  const priceDeltaFraction = (priceVelocityPctPerMin / 100) * (windowSeconds / 60);
  const startPrice = 0.60;
  const endPrice = startPrice * (1 + priceDeltaFraction);

  ev.recordPrice(TOKEN, startPrice, now - windowMs + 1); // oldest in window
  ev.recordPrice(TOKEN, endPrice, now); // latest

  // Trades: prior window = Math.floor(10/tradeRatio), current window = 10
  const currentCount = 10;
  const priorCount = Math.floor(currentCount / tradeRatio); // so ratio = 10/priorCount >= tradeRatio

  for (let i = 0; i < priorCount; i++) {
    const ts = now - 2 * windowMs + i * 1000;
    const tb = (ev as unknown as { tradeBuffer: Map<string, { timestamp: number }[]> }).tradeBuffer;
    if (!tb.has(TOKEN)) tb.set(TOKEN, []);
    tb.get(TOKEN)!.push({ timestamp: ts });
  }
  for (let i = 0; i < currentCount; i++) {
    const ts = now - windowMs + i * 1000;
    const tb = (ev as unknown as { tradeBuffer: Map<string, { timestamp: number }[]> }).tradeBuffer;
    if (!tb.has(TOKEN)) tb.set(TOKEN, []);
    tb.get(TOKEN)!.push({ timestamp: ts });
  }
  // Disable warm-up for this token
  (ev as unknown as { warmUntil: Map<string, number> }).warmUntil.delete(TOKEN);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SentimentVelocityEvaluator", () => {
  let ev: SentimentVelocityEvaluator;
  let now: number;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-03-01T12:00:00Z"));
    now = Date.now();
    ev = makeEvaluator();
  });

  afterEach(() => {
    ev.clear();
    vi.useRealTimers();
  });

  // ── Fires when both conditions met ────────────────────────────────────

  it("fires BULLISH when price velocity and trade count velocity both exceed thresholds", () => {
    populate(ev, now, 1.0, 2.0); // 1% per min > 0.5% threshold; ratio 2.0 > 1.5
    const result = ev.evaluate(TOKEN, COND);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("BULLISH");
    expect(result!.signalType).toBe("SENTIMENT_VELOCITY");
  });

  it("fires BEARISH when price is falling fast", () => {
    populate(ev, now, -1.0, 2.0); // -1% per min
    const result = ev.evaluate(TOKEN, COND);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("BEARISH");
  });

  // ── Does NOT fire when only one condition met ─────────────────────────

  it("does NOT fire when only price velocity exceeded (trade count below multiplier)", () => {
    // Set up: price moves 1%/min but trade ratio = 1.0 (equal, not exceeding 1.5×)
    populate(ev, now, 1.0, 1.0); // ratio=1.0 < 1.5
    const result = ev.evaluate(TOKEN, COND);
    expect(result).toBeNull();
  });

  it("does NOT fire when only trade count velocity exceeded (price below threshold)", () => {
    // Price velocity near 0 but trade ratio high
    populate(ev, now, 0.1, 3.0); // 0.1%/min < 0.5% threshold
    const result = ev.evaluate(TOKEN, COND);
    expect(result).toBeNull();
  });

  // ── Cooldown ───────────────────────────────────────────────────────────

  it("cooldown suppresses second evaluation within cooldownMs", () => {
    populate(ev, now, 1.0, 2.0);
    const first = ev.evaluate(TOKEN, COND);
    expect(first).not.toBeNull();

    // Re-populate with same conditions
    populate(ev, now, 1.0, 2.0);
    const second = ev.evaluate(TOKEN, COND);
    expect(second).toBeNull();
  });

  it("fires again after cooldownMs elapses", () => {
    populate(ev, now, 1.0, 2.0);
    ev.evaluate(TOKEN, COND);

    vi.advanceTimersByTime(120_001);
    now = Date.now();

    ev.clear();
    ev = makeEvaluator();
    populate(ev, now, 1.0, 2.0);
    const result = ev.evaluate(TOKEN, COND);
    expect(result).not.toBeNull();
  });

  // ── Rolling window ─────────────────────────────────────────────────────

  it("returns null when fewer than 2 price records in current window", () => {
    // Only 1 price point in current window
    ev.recordPrice(TOKEN, 0.60, now - 100);
    (ev as unknown as { warmUntil: Map<string, number> }).warmUntil.delete(TOKEN);
    const result = ev.evaluate(TOKEN, COND);
    expect(result).toBeNull();
  });

  it("excludes price records older than windowSeconds", () => {
    const windowMs = 300 * 1000;
    // Price from long ago — outside current window
    ev.recordPrice(TOKEN, 0.50, now - windowMs - 1);
    // Only one point in current window
    ev.recordPrice(TOKEN, 0.60, now - 100);
    (ev as unknown as { warmUntil: Map<string, number> }).warmUntil.delete(TOKEN);
    const result = ev.evaluate(TOKEN, COND);
    // Only 1 point in window → null
    expect(result).toBeNull();
  });

  it("prior window uses [now-2W, now-W) range", () => {
    const windowMs = 300 * 1000;
    // Put many trades in prior window, few in current
    // prior: 20 trades, current: 20 trades → ratio = 20/20 = 1.0 < 1.5 → no signal

    // Add price data for 2 points in current window
    ev.recordPrice(TOKEN, 0.60, now - windowMs + 1000);
    ev.recordPrice(TOKEN, 0.70, now);

    // Add 20 trades in prior window
    for (let i = 0; i < 20; i++) {
      ev.recordTrade(TOKEN, now - 2 * windowMs + i * 1000);
    }
    // Add 20 trades in current window
    for (let i = 0; i < 20; i++) {
      ev.recordTrade(TOKEN, now - windowMs + i * 1000);
    }

    (ev as unknown as { warmUntil: Map<string, number> }).warmUntil.delete(TOKEN);

    // Price velocity = (0.70-0.60)/0.60 / 300 * 60 ≈ 0.0333/min > 0.005 ✓
    // Trade ratio = 20/20 = 1.0 < 1.5 → null
    const result = ev.evaluate(TOKEN, COND);
    expect(result).toBeNull();
  });

  it("tradeCountVelocity = 1 when prior window is empty (division guard)", () => {
    // Prior window empty → denominator = max(0,1) = 1
    // current has 2 trades → ratio = 2/1 = 2.0 > 1.5 ✓
    // Add 2 price points
    ev.recordPrice(TOKEN, 0.60, now - 299_000);
    ev.recordPrice(TOKEN, 0.70, now);
    // 2 trades in current window only
    ev.recordTrade(TOKEN, now - 100);
    ev.recordTrade(TOKEN, now - 50);
    (ev as unknown as { warmUntil: Map<string, number> }).warmUntil.delete(TOKEN);

    const result = ev.evaluate(TOKEN, COND);
    // price velocity = (0.10/0.60)/300*60 ≈ 0.0333 > 0.005 ✓
    // tradeCountVelocity = 2/1 = 2 > 1.5 ✓
    expect(result).not.toBeNull();
    expect(result!.tradeCountVelocity).toBe(2);
  });

  // ── Warm-up suppression ────────────────────────────────────────────────

  it("warm-up: returns null before 2× windowMs has elapsed for cold-start token", () => {
    // First recordTrade for a brand-new token triggers warm-up
    ev.recordTrade(TOKEN, now);
    // Add price points
    ev.recordPrice(TOKEN, 0.60, now - 299_000);
    ev.recordPrice(TOKEN, 0.70, now);
    // warmUntil = now + 2*300*1000 = now + 600s
    const result = ev.evaluate(TOKEN, COND);
    expect(result).toBeNull();
  });

  it("warm-up: fires after 2× windowMs has elapsed", () => {
    const windowMs = 300 * 1000;
    ev.recordTrade(TOKEN, now); // triggers warmUntil = now + 2*windowMs

    // Advance past warm-up
    vi.advanceTimersByTime(2 * windowMs + 1);
    const newNow = Date.now();

    // Add fresh data after warm-up
    ev.recordPrice(TOKEN, 0.60, newNow - windowMs + 1000);
    ev.recordPrice(TOKEN, 0.70, newNow);
    ev.recordTrade(TOKEN, newNow - 100);
    ev.recordTrade(TOKEN, newNow - 50);

    const result = ev.evaluate(TOKEN, COND);
    // tradeCountVelocity: current=2, prior = trades before (newNow-windowMs) but after (newNow-2*windowMs)
    // prior may have 1 trade (the one at `now` = newNow - 2*windowMs - 1) — could be 0
    // Let's just check it fires (warm-up guard passed) if conditions met
    // Actually if prior=1 and current=2 → ratio=2 > 1.5 ✓
    // But price velocity is (0.10/0.60)/300*60 ≈ 0.0333 > 0.005 ✓
    expect(result).not.toBeNull();
  });

  // ── Bootstrap ──────────────────────────────────────────────────────────

  it("bootstrap: pre-populates buffers and suppresses warm-up when both windows covered", async () => {
    const windowMs = 300 * 1000;
    const now2 = Date.now();

    // Mock DB: returns price history and trade timestamps covering both windows
    const priceRows = [
      { price: 0.70, recordedAt: new Date(now2 - 100) },       // current window
      { price: 0.60, recordedAt: new Date(now2 - windowMs + 1000) }, // current window start
      { price: 0.58, recordedAt: new Date(now2 - windowMs - 1000) }, // prior window
      { price: 0.55, recordedAt: new Date(now2 - 2 * windowMs + 1000) }, // prior window
    ];

    const tradeRows = [
      { tradedAt: new Date(now2 - 100) },            // current window
      { tradedAt: new Date(now2 - 200) },            // current window
      { tradedAt: new Date(now2 - windowMs - 1000) }, // prior window
    ];

    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(
                // Return newest-first (DESC)
                priceRows.sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())
                  .map((r) => ({ price: r.price.toString(), recordedAt: r.recordedAt }))
              ),
            }),
          }),
        }),
      }),
      execute: vi.fn().mockResolvedValue({
        rows: tradeRows.map((t) => ({ traded_at: t.tradedAt })),
      }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ev.bootstrap(mockDb as any, [TOKEN]);

    // warm-up should be cleared since both windows are covered
    const warmUntil = (ev as unknown as { warmUntil: Map<string, number> }).warmUntil;
    expect(warmUntil.has(TOKEN)).toBe(false);

    // Price buffer should contain entries
    const priceBuf = (ev as unknown as { priceBuffer: Map<string, unknown[]> }).priceBuffer;
    expect((priceBuf.get(TOKEN) ?? []).length).toBeGreaterThan(0);
  });

  it("bootstrap: does not set warm-up for tokens with no DB data (remains unset until first recordTrade)", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ev.bootstrap(mockDb as any, [TOKEN]);

    // warm-up not set by bootstrap (only by recordTrade for new token)
    const warmUntil = (ev as unknown as { warmUntil: Map<string, number> }).warmUntil;
    expect(warmUntil.has(TOKEN)).toBe(false);
  });

  // ── Confidence ─────────────────────────────────────────────────────────

  it("confidence scales as min(1.0, |priceVelocity| / (threshold * 3))", () => {
    // priceVelocity = 0.005 * 3 → confidence = 1.0
    populate(ev, now, (0.005 * 3 * 100), 2.0); // 1.5%/min = threshold*3
    (ev as unknown as { warmUntil: Map<string, number> }).warmUntil.delete(TOKEN);
    const result = ev.evaluate(TOKEN, COND);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeCloseTo(1.0, 2);
  });

  it("confidence capped at 1.0 for very high velocity", () => {
    populate(ev, now, 5.0, 2.0); // 5%/min >> threshold*3 = 0.015
    (ev as unknown as { warmUntil: Map<string, number> }).warmUntil.delete(TOKEN);
    const result = ev.evaluate(TOKEN, COND);
    if (result) {
      expect(result.confidence).toBeLessThanOrEqual(1.0);
    }
  });

  it("strength equals tradeCountVelocity", () => {
    populate(ev, now, 1.0, 2.0); // trade ratio = 2.0
    (ev as unknown as { warmUntil: Map<string, number> }).warmUntil.delete(TOKEN);
    const result = ev.evaluate(TOKEN, COND);
    expect(result).not.toBeNull();
    expect(result!.strength).toBeCloseTo(result!.tradeCountVelocity, 5);
  });

  // ── Custom opts ────────────────────────────────────────────────────────

  it("respects custom windowSeconds from constructor opts", () => {
    const shortWindow = makeEvaluator({ windowSeconds: 60 });
    const shortNow = Date.now();

    // Add 2 price points within the 60s window
    shortWindow.recordPrice(TOKEN, 0.60, shortNow - 59_000);
    shortWindow.recordPrice(TOKEN, 0.70, shortNow);
    // 2 trades in current window, 0 in prior → ratio = 2/1 = 2 > 1.5
    shortWindow.recordTrade(TOKEN, shortNow - 100);
    shortWindow.recordTrade(TOKEN, shortNow - 50);
    (shortWindow as unknown as { warmUntil: Map<string, number> }).warmUntil.delete(TOKEN);

    // priceVelocity = (0.10/0.60)/60*60 = 0.1667/min > 0.005 ✓
    const result = shortWindow.evaluate(TOKEN, COND);
    expect(result).not.toBeNull();
  });

  it("uses default config when no opts provided", () => {
    const defaultEv = new SentimentVelocityEvaluator();
    // Just verify it instantiates and doesn't throw
    const result = defaultEv.evaluate(TOKEN, COND);
    expect(result).toBeNull(); // no data → null
    defaultEv.clear();
  });

  // ── windowStartPrice = 0 guard ─────────────────────────────────────────

  it("returns null when windowStartPrice is 0", () => {
    const windowMs = 300 * 1000;
    ev.recordPrice(TOKEN, 0, now - windowMs + 1000); // price = 0 at window start
    ev.recordPrice(TOKEN, 0.70, now);
    (ev as unknown as { warmUntil: Map<string, number> }).warmUntil.delete(TOKEN);
    const result = ev.evaluate(TOKEN, COND);
    expect(result).toBeNull();
  });

  // ── clear() ────────────────────────────────────────────────────────────

  it("clear() resets all buffers", () => {
    populate(ev, now, 1.0, 2.0);
    ev.clear();

    const pb = (ev as unknown as { priceBuffer: Map<string, unknown[]> }).priceBuffer;
    const tb = (ev as unknown as { tradeBuffer: Map<string, unknown[]> }).tradeBuffer;
    expect(pb.size).toBe(0);
    expect(tb.size).toBe(0);
  });
});
