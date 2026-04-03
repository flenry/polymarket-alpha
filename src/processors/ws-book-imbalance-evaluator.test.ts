import { describe, it, expect, vi, beforeEach } from "vitest";
import { WsBookImbalanceEvaluator } from "./ws-book-imbalance-evaluator.js";
import type { OrderBook } from "../events/types.js";

// Mock insertBookSnapshot
vi.mock("../db/queries/snapshots.js", () => ({
  insertBookSnapshot: vi.fn().mockResolvedValue(undefined),
}));

import { insertBookSnapshot } from "../db/queries/snapshots.js";

function makeBus() {
  const emitted: unknown[] = [];
  return {
    emit: vi.fn((event: string, payload: unknown) => { emitted.push({ event, payload }); return true; }),
    on: vi.fn(),
    off: vi.fn(),
    _emitted: emitted,
  };
}

function makeDb() {
  return {} as Parameters<typeof WsBookImbalanceEvaluator.prototype.evaluate>[0];
}

function makeBook(
  bids: { price: number; size: number }[],
  asks: { price: number; size: number }[],
  tokenId = "tok1"
): OrderBook {
  return {
    tokenId,
    conditionId: "cond1",
    bids,
    asks,
    timestamp: Date.now(),
    hash: "hash1",
    capturedAt: new Date(),
  };
}

describe("WsBookImbalanceEvaluator", () => {
  let bus: ReturnType<typeof makeBus>;
  let db: ReturnType<typeof makeDb>;
  const THRESHOLD = 3.0;

  beforeEach(() => {
    bus = makeBus();
    db = makeDb();
    vi.mocked(insertBookSnapshot).mockClear();
  });

  it("BULL signal: ratio > threshold → emits ORDER_BOOK_IMBALANCE with BULLISH direction", () => {
    // bids: 4 * 1.0 USDC = 4.0, asks: 1 * 1.0 USDC = 1.0 → ratio = 4.0 > 3.0
    const evaluator = new WsBookImbalanceEvaluator(
      bus as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[0],
      db as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[1],
      { threshold: THRESHOLD, cooldownMs: 60_000 }
    );

    const bids = [{ price: 0.8, size: 5 }]; // bidDepthUsdc = 4.0
    const asks = [{ price: 0.82, size: 1.22 }]; // askDepthUsdc ≈ 1.0
    const book = makeBook(bids, asks);

    evaluator.evaluate(book);

    expect(bus.emit).toHaveBeenCalledOnce();
    const call = bus.emit.mock.calls[0];
    expect(call[0]).toBe("signal");
    const signal = call[1] as { signalType: string; direction: string; confidence: number };
    expect(signal.signalType).toBe("ORDER_BOOK_IMBALANCE");
    expect(signal.direction).toBe("BULLISH");
  });

  it("BULL confidence formula: min(1.0, (ratio - threshold) / threshold)", () => {
    // bids = 4, asks = 1 → ratio = 4.0, threshold = 3.0
    // confidence = (4 - 3) / 3 = 0.333...
    const evaluator = new WsBookImbalanceEvaluator(
      bus as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[0],
      db as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[1],
      { threshold: THRESHOLD, cooldownMs: 60_000 }
    );

    const bidDepthUsdc = 4.0;
    const askDepthUsdc = 1.0;
    const bids = [{ price: 1.0, size: bidDepthUsdc }];
    const asks = [{ price: 1.0, size: askDepthUsdc }];
    const book = makeBook(bids, asks);

    evaluator.evaluate(book);

    const signal = bus.emit.mock.calls[0][1] as { confidence: number };
    const expectedConfidence = Math.min(1.0, (4.0 - 3.0) / 3.0);
    expect(signal.confidence).toBeCloseTo(expectedConfidence, 6);
  });

  it("BEAR signal: ratio < 1/threshold → emits ORDER_BOOK_IMBALANCE with BEARISH direction", () => {
    // bids = 1, asks = 4 → ratio = 0.25 < 1/3.0 = 0.333
    const evaluator = new WsBookImbalanceEvaluator(
      bus as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[0],
      db as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[1],
      { threshold: THRESHOLD, cooldownMs: 60_000 }
    );

    const bids = [{ price: 1.0, size: 1.0 }]; // bidDepthUsdc = 1.0
    const asks = [{ price: 1.0, size: 4.0 }]; // askDepthUsdc = 4.0
    const book = makeBook(bids, asks);

    evaluator.evaluate(book);

    expect(bus.emit).toHaveBeenCalledOnce();
    const signal = bus.emit.mock.calls[0][1] as { direction: string; signalType: string };
    expect(signal.signalType).toBe("ORDER_BOOK_IMBALANCE");
    expect(signal.direction).toBe("BEARISH");
  });

  it("no signal when ratio within band (between 1/threshold and threshold)", () => {
    // ratio = 2.0 is between 0.333 and 3.0 → no signal
    const evaluator = new WsBookImbalanceEvaluator(
      bus as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[0],
      db as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[1],
      { threshold: THRESHOLD, cooldownMs: 60_000 }
    );

    const bids = [{ price: 1.0, size: 2.0 }];
    const asks = [{ price: 1.0, size: 1.0 }];
    const book = makeBook(bids, asks);

    evaluator.evaluate(book);

    expect(bus.emit).not.toHaveBeenCalled();
    // But snapshot still inserted
    expect(insertBookSnapshot).toHaveBeenCalledOnce();
  });

  it("cooldown: second evaluate within cooldown window → no second signal but snapshot still inserted", () => {
    const evaluator = new WsBookImbalanceEvaluator(
      bus as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[0],
      db as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[1],
      { threshold: THRESHOLD, cooldownMs: 60_000 }
    );

    const bids = [{ price: 1.0, size: 4.0 }];
    const asks = [{ price: 1.0, size: 1.0 }];
    const book = makeBook(bids, asks);

    evaluator.evaluate(book);
    expect(bus.emit).toHaveBeenCalledOnce();

    evaluator.evaluate(book);
    // Still only one signal emission
    expect(bus.emit).toHaveBeenCalledOnce();
    // But snapshot inserted twice
    expect(insertBookSnapshot).toHaveBeenCalledTimes(2);
  });

  it("resetCooldown: after reset, second evaluate emits signal", () => {
    const evaluator = new WsBookImbalanceEvaluator(
      bus as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[0],
      db as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[1],
      { threshold: THRESHOLD, cooldownMs: 60_000 }
    );

    const bids = [{ price: 1.0, size: 4.0 }];
    const asks = [{ price: 1.0, size: 1.0 }];
    const book = makeBook(bids, asks);

    evaluator.evaluate(book);
    expect(bus.emit).toHaveBeenCalledOnce();

    evaluator.resetCooldown("tok1");
    evaluator.evaluate(book);
    expect(bus.emit).toHaveBeenCalledTimes(2);
  });

  it("strength = total depth (bidDepthUsdc + askDepthUsdc)", () => {
    const evaluator = new WsBookImbalanceEvaluator(
      bus as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[0],
      db as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[1],
      { threshold: THRESHOLD, cooldownMs: 60_000 }
    );

    const bidDepthUsdc = 6.0;
    const askDepthUsdc = 1.0;
    const bids = [{ price: 1.0, size: bidDepthUsdc }];
    const asks = [{ price: 1.0, size: askDepthUsdc }];
    const book = makeBook(bids, asks);

    evaluator.evaluate(book);

    const signal = bus.emit.mock.calls[0][1] as { strength: number };
    expect(signal.strength).toBeCloseTo(bidDepthUsdc + askDepthUsdc, 6);
  });

  it("askDepthUsdc === 0: no snapshot insert, no signal", () => {
    const evaluator = new WsBookImbalanceEvaluator(
      bus as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[0],
      db as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[1],
      { threshold: THRESHOLD, cooldownMs: 60_000 }
    );

    const book = makeBook([{ price: 1.0, size: 4.0 }], []);
    evaluator.evaluate(book);

    expect(bus.emit).not.toHaveBeenCalled();
    expect(insertBookSnapshot).not.toHaveBeenCalled();
  });

  it("snapshot always inserted with snapshotTrigger: 'ws_event'", () => {
    const evaluator = new WsBookImbalanceEvaluator(
      bus as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[0],
      db as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[1],
      { threshold: THRESHOLD, cooldownMs: 60_000 }
    );

    // Ratio within band — no signal but snapshot should still be called
    const bids = [{ price: 1.0, size: 2.0 }];
    const asks = [{ price: 1.0, size: 1.0 }];
    const book = makeBook(bids, asks);

    evaluator.evaluate(book);

    expect(insertBookSnapshot).toHaveBeenCalledOnce();
    const snapArg = vi.mocked(insertBookSnapshot).mock.calls[0][1];
    expect(snapArg.snapshotTrigger).toBe("ws_event");
  });

  it("ORDER_BOOK_IMBALANCE signal type (not BOOK_IMBALANCE)", () => {
    const evaluator = new WsBookImbalanceEvaluator(
      bus as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[0],
      db as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[1],
      { threshold: THRESHOLD, cooldownMs: 60_000 }
    );

    const bids = [{ price: 1.0, size: 4.0 }];
    const asks = [{ price: 1.0, size: 1.0 }];
    evaluator.evaluate(makeBook(bids, asks));

    const signal = bus.emit.mock.calls[0][1] as { signalType: string };
    expect(signal.signalType).toBe("ORDER_BOOK_IMBALANCE");
    expect(signal.signalType).not.toBe("BOOK_IMBALANCE");
  });

  it("priceAtSignal = mid-price when both bids and asks present", () => {
    const evaluator = new WsBookImbalanceEvaluator(
      bus as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[0],
      db as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[1],
      { threshold: THRESHOLD, cooldownMs: 60_000 }
    );

    const bids = [{ price: 0.70, size: 6.0 }];
    const asks = [{ price: 0.72, size: 1.0 }];
    evaluator.evaluate(makeBook(bids, asks));

    const signal = bus.emit.mock.calls[0][1] as { priceAtSignal: number };
    expect(signal.priceAtSignal).toBeCloseTo((0.70 + 0.72) / 2, 6);
  });

  it("priceAtSignal = 0 when bids empty (BEAR signal with no bid side)", async () => {
    // bids=[], asks=[4.0] → ratio=0 < 1/3.0 → BEAR. bids.length===0 → priceAtSignal=0
    const evaluator = new WsBookImbalanceEvaluator(
      bus as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[0],
      db as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[1],
      { threshold: THRESHOLD, cooldownMs: 60_000 }
    );

    // Empty bids but has asks
    const book = makeBook([], [{ price: 0.8, size: 4.0 }]);
    evaluator.evaluate(book);

    expect(bus.emit).toHaveBeenCalledOnce();
    const sig = bus.emit.mock.calls[0][1] as { direction: string; priceAtSignal: number };
    expect(sig.direction).toBe("BEARISH");
    expect(sig.priceAtSignal).toBe(0);
  });

  it("uses config defaults when no opts passed: threshold=3.0, cooldown=60000", () => {
    // Constructs without opts — covers lines 21-22 (config.imbalanceRatioThreshold / config.imbalanceCooldownMs)
    const evaluator = new WsBookImbalanceEvaluator(
      bus as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[0],
      db as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[1]
      // no opts — defaults from config
    );

    // ratio = 4.0/1.0 = 4.0 > 3.0 threshold — should still fire
    const bids = [{ price: 1.0, size: 4.0 }];
    const asks = [{ price: 1.0, size: 1.0 }];
    evaluator.evaluate(makeBook(bids, asks));

    expect(bus.emit).toHaveBeenCalledOnce();
    const sig = bus.emit.mock.calls[0][1] as { signalType: string; direction: string };
    expect(sig.signalType).toBe("ORDER_BOOK_IMBALANCE");
    expect(sig.direction).toBe("BULLISH");
  });

  it("snapshot insert failure: evaluate() does not throw, signal still emitted", async () => {
    // Cover the .catch() branch on insertBookSnapshot (line 49)
    vi.mocked(insertBookSnapshot).mockRejectedValueOnce(new Error("DB write failed"));

    const evaluator = new WsBookImbalanceEvaluator(
      bus as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[0],
      db as unknown as ConstructorParameters<typeof WsBookImbalanceEvaluator>[1],
      { threshold: THRESHOLD, cooldownMs: 60_000 }
    );

    const bids = [{ price: 1.0, size: 4.0 }];
    const asks = [{ price: 1.0, size: 1.0 }];
    const book = makeBook(bids, asks);

    // Should not throw despite DB failure
    expect(() => evaluator.evaluate(book)).not.toThrow();
    // Signal still emitted (fire-and-forget snapshot)
    expect(bus.emit).toHaveBeenCalledOnce();
    const sig = bus.emit.mock.calls[0][1] as { signalType: string };
    expect(sig.signalType).toBe("ORDER_BOOK_IMBALANCE");

    // Wait for the rejected promise to settle (covers the catch log)
    await new Promise((r) => setTimeout(r, 10));
  });
});
